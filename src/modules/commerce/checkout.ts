import { createHash } from 'node:crypto';
import type { VideoCommerceRepository } from '../media/videoRepository.js';
import { config } from '../../config.js';
import { getMediaPaymentMethods } from '../../mediaLocalization.js';
import { isMaintenanceBlocked } from '../../maintenance.js';
import { INVOICE_PAYLOAD_KIND, normalizeFeatureKeyValue, normalizePaymentActionKind, normalizePaymentSource, resolveInvoiceActionResult } from './paymentFlow.js';
import { INVOICE_TTL_MS, isExpired, normalizePositiveInteger, normalizeString, parseJsonObject } from '../../mediaCommerce/utils.js';
import { parseStrictJsonObject } from '../../mediaCommerceRepository/shared.js';
import type { UpsertInvoiceTokenInput } from '../../mediaCommerceRepository/shared.js';
import { TelegramStarsInvoiceError } from '../../payments/stars.js';
import type { StarsInvoiceClient } from '../../payments/stars.js';
import { SbpPaymentError } from '../../payments/sbp.js';
import type { SbpPaymentClient, SbpTransactionStatus } from '../../payments/sbp.js';
import type { StoredInvoiceToken, LoadedInvoiceToken } from '../../mediaCommerceTypes.js';
import { MediaCommerceOperationError, runOperation, runRepositoryOperation } from '../../mediaCommerce/operations.js';
import type { OperationLogContext } from '../../mediaCommerce/operations.js';
import type { MediaRepository } from '../../mediaCommerce/repositoryContract.js';
import { videoInvoiceAllowed } from '../access/videoEligibility.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const SBP_CHECKOUT_WAIT_TIMEOUT_MS = 24_000;

export const SBP_CHECKOUT_WAIT_BACKOFF_MS = [200, 400, 800, 1000, 1500, 2000] as const;

export function buildSbpGatewayCheckoutUrl(token: string): string {
  const baseUrl = normalizeString(config.GATEWAY_PUBLIC_URL);
  if (!baseUrl) {
    throw new MediaCommerceOperationError(
      "Gateway public URL is not configured",
      "payment.buildSbpGatewayCheckoutUrl",
      "sbp_gateway_url_missing",
    );
  }

  return `${baseUrl}/v1/pay/sbp/${encodeURIComponent(token)}`;
}

export const RETRYABLE_SBP_FAILURE_REASONS = new Set(["sbp_canceled", "sbp_expired"]);

export const MAX_SBP_SUCCESSOR_DEPTH = 8;

export function buildSbpRetryToken(predecessorToken: string): string {
  const hash = createHash("sha256")
    .update(["sbp_retry", predecessorToken].join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `pay_retry_${hash}:sbp`;
}

export function isRetryableSbpCancellation(row: StoredInvoiceToken | LoadedInvoiceToken): boolean {
  return normalizePaymentSource(row.payment_source) === "sbp"
    && normalizeString(row.status) === "canceled"
    && RETRYABLE_SBP_FAILURE_REASONS.has(normalizeString(row.failure_reason) ?? "");
}

export function isExpiredSbpInvoiceSent(row: StoredInvoiceToken): boolean {
  return normalizePaymentSource(row.payment_source) === "sbp"
    && normalizeString(row.status) === "invoice_sent"
    && isExpired(row.expires_at);
}

export function buildSbpSuccessorInput(row: StoredInvoiceToken): UpsertInvoiceTokenInput {
  return {
    token: buildSbpRetryToken(row.token),
    kind: row.kind,
    chat_id: row.chat_id,
    scene_session_id: row.scene_session_id,
    turn_no: row.turn_no,
    scene_turn_no: row.scene_turn_no,
    payload_json: parseStrictJsonObject(row.payload_json, "buildSbpSuccessorInput"),
    action_kind: normalizeString(row.action_kind) ?? "",
    sku: normalizeString(row.sku) ?? "",
    payment_source: "sbp",
    amount: normalizePositiveInteger(row.amount) ?? 0,
    currency: "RUB",
    amount_xtr: normalizePositiveInteger(row.amount_xtr),
    telegram_invoice_payload: null,
    checkout_url: null,
    external_payment_id: null,
    expires_at: new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
    invoice_title: row.invoice_title,
    invoice_description: row.invoice_description,
    invoice_label: row.invoice_label,
    invoice_button_text: row.invoice_button_text,
  };
}

export function getSbpPaymentError(error: unknown): SbpPaymentError | null {
  if (error instanceof SbpPaymentError) return error;
  if (
    error instanceof MediaCommerceOperationError
    && error.cause instanceof SbpPaymentError
  ) {
    return error.cause;
  }
  return null;
}

export function getSbpCheckoutEligibilityError(row: StoredInvoiceToken): string | null {
  if (normalizeString(row.kind) !== INVOICE_PAYLOAD_KIND) return "sbp_invoice_kind_invalid";
  if (normalizePaymentSource(row.payment_source) !== "sbp") return "sbp_payment_source_invalid";
  if (normalizeString(row.status) !== "invoice_sent") return "sbp_invoice_status_invalid";
  if (!normalizePaymentActionKind(row.action_kind)) return "sbp_invoice_action_invalid";

  if (isExpired(row.expires_at)) {
    return "sbp_invoice_expired";
  }
  return null;
}

export function getInvoicePurchaseId(row: StoredInvoiceToken | LoadedInvoiceToken): string | null {
  const payload = parseJsonObject(row.payload_json) ?? {};
  return normalizeString(
    typeof payload.idempotency_key === "string" ? payload.idempotency_key : null,
  );
}

export function getInvoiceFeatureKey(row: StoredInvoiceToken | LoadedInvoiceToken): string | null {
  const payload = parseJsonObject(row.payload_json) ?? {};
  return normalizeFeatureKeyValue(
    typeof payload.feature_key === "string" ? payload.feature_key : null,
  );
}

export function buildPurchaseGroupKey(row: StoredInvoiceToken): string | null {
  const purchaseId = getInvoicePurchaseId(row);
  const sku = normalizeString(row.sku);
  if (!purchaseId || !sku) return null;
  return `${purchaseId}\u001f${sku}`;
}

export function isRenderableStoredInvoiceRow(row: StoredInvoiceToken): boolean {
  const paymentSource = normalizePaymentSource(row.payment_source);
  const status = normalizeString(row.status);
  if (paymentSource === "stars") {
    return status === "invoice_sent";
  }
  if (paymentSource === "sbp") {
    return status === "invoice_sent" || isRetryableSbpCancellation(row);
  }
  return false;
}

export function getTelegramStarsInvoiceError(error: unknown): TelegramStarsInvoiceError | null {
  if (error instanceof TelegramStarsInvoiceError) return error;
  if (error instanceof Error && error.cause instanceof TelegramStarsInvoiceError) {
    return error.cause;
  }
  return null;
}

export function isTransientStarsInvoiceError(error: unknown): boolean {
  const starsError = getTelegramStarsInvoiceError(error);
  return starsError != null
    && (
      starsError.stage === "request"
      || starsError.statusCode === 429
      || (starsError.statusCode != null && starsError.statusCode >= 500)
    );
}

export function buildSbpGatewayRow(row: StoredInvoiceToken): StoredInvoiceToken {
  return {
    ...row,
    checkout_url: buildSbpGatewayCheckoutUrl(row.token),
    external_payment_id: null,
  };
}

export async function upsertCurrentPaymentAttempts(repository: MediaRepository, videos: VideoCommerceRepository, inputs: UpsertInvoiceTokenInput[],
    operationPrefix: string,
  ): Promise<StoredInvoiceToken[]> {
    const rows = await runRepositoryOperation(
      `${operationPrefix}.upsertInvoiceTokens`,
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => repository.upsertInvoiceTokens(inputs),
    );
    const mergedRows = rows.slice();

    for (const row of rows) {
      if (!isRetryableSbpCancellation(row)) continue;
      const successor = await createSbpSuccessorAttempt(repository, videos, row, operationPrefix);
      if (!successor) continue;
      const index = mergedRows.findIndex((candidate) => candidate.token === row.token);
      if (index >= 0) {
        mergedRows[index] = successor;
      } else {
        mergedRows.push(successor);
      }
    }

    return mergedRows;
  }

export async function canCreateSbpSuccessor(repository: MediaRepository, videos: VideoCommerceRepository, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<boolean> {
    const payload = parseJsonObject(row.payload_json) ?? {};
    const actionResolution = resolveInvoiceActionResult(payload, row.action_kind);
    const action = actionResolution.action;
    if (!action) return false;

    if (action.payment_kind === "subscription") {
      const offerId = normalizeString(
        typeof payload.idempotency_key === "string" ? payload.idempotency_key : null,
      );
      if (!offerId) return false;
      const activeOfferId = await runRepositoryOperation(
        `${operationPrefix}.loadActiveSubscriptionOfferId`,
        {
          chat_id: row.chat_id,
          payment_kind: action.payment_kind,
          sku: normalizeString(row.sku),
          invoice_status: normalizeString(row.status),
        },
        () => repository.loadActiveSubscriptionOfferId(row.chat_id),
      );
      return activeOfferId === offerId;
    }

    const sceneSessionId = normalizeString(row.scene_session_id)
      ?? normalizeString(
        typeof payload.scene_session_id === "string" ? payload.scene_session_id : null,
      );
    if (!sceneSessionId) return true;

    const sceneStatus = await runRepositoryOperation(
      `${operationPrefix}.loadSceneAccessStatus`,
      {
        chat_id: row.chat_id,
        payment_kind: action.payment_kind,
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => repository.loadSceneAccessStatus({
        chat_id: row.chat_id,
        scene_session_id: sceneSessionId,
      }),
    );

    if(!sceneStatus?.scene_is_active || normalizeString(sceneStatus.active_scene_session_id)!==sceneSessionId)return false;
    if(action.feature_key==='video_unlock'||action.feature_key==='video_pass')return videoInvoiceAllowed(videos, row.chat_id,sceneSessionId,action.feature_key,payload);
    if(action.feature_key==='scene_unlock')return !sceneStatus.subscription_active && !sceneStatus.scene_access_active;
    return true;
  }

export async function createSbpSuccessorAttempt(repository: MediaRepository, videos: VideoCommerceRepository, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken | null> {
    if (!await canCreateSbpSuccessor(repository, videos, row, operationPrefix)) {
      return null;
    }

    const successorInput = buildSbpSuccessorInput(row);
    const [successor] = await runRepositoryOperation(
      `${operationPrefix}.upsertSbpSuccessor`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => repository.upsertInvoiceTokens([successorInput]),
    );

    return successor ?? null;
  }

export async function reloadSbpPredecessor(repository: MediaRepository, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const token = normalizeString(row.token);
    if (!token) {
      throw new MediaCommerceOperationError(
        "SBP predecessor token is missing",
        `${operationPrefix}.reloadSbpPredecessor`,
        "sbp_invoice_status_invalid",
      );
    }

    const [reloaded] = await runRepositoryOperation(
      `${operationPrefix}.reloadSbpPredecessor`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => repository.loadStoredInvoiceTokens([token]),
    );
    if (!reloaded) {
      throw new MediaCommerceOperationError(
        "SBP predecessor disappeared during reconciliation",
        `${operationPrefix}.reloadSbpPredecessor`,
        "sbp_invoice_status_invalid",
      );
    }

    return reloaded;
  }

export async function reconcileExpiredSbpInvoice(repository: MediaRepository, sbpClient: SbpPaymentClient | null, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const externalPaymentId = normalizeString(row.external_payment_id);
    if (!externalPaymentId) {
      const updated = await runRepositoryOperation(
        `${operationPrefix}.markSbpInvoiceExpired`,
        {
          chat_id: row.chat_id,
          payment_kind: normalizeString(row.action_kind),
          sku: normalizeString(row.sku),
          invoice_status: normalizeString(row.status),
        },
        () => repository.markSbpInvoiceExpired(row.token, row.chat_id),
      );
      if (updated !== 1) {
        return reloadSbpPredecessor(repository, row, operationPrefix);
      }
      return {
        ...row,
        status: "canceled",
        failure_reason: "sbp_expired",
      };
    }

    let providerStatus: SbpTransactionStatus | null = null;
    try {
      providerStatus = await sbpClient?.getTransactionStatus?.(externalPaymentId) ?? null;
    } catch (error) {
      throw new MediaCommerceOperationError(
        "SBP provider status is ambiguous",
        `${operationPrefix}.getTransactionStatus`,
        "sbp_provider_status_ambiguous",
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (providerStatus !== "CANCELED") {
      throw new MediaCommerceOperationError(
        "Expired SBP checkout is not retryable by provider status",
        `${operationPrefix}.getTransactionStatus`,
        providerStatus === "PENDING"
          ? "sbp_provider_status_pending"
          : providerStatus === "CONFIRMED"
            ? "sbp_provider_status_confirmed"
            : providerStatus === "CHARGEBACKED"
              ? "sbp_provider_status_chargebacked"
              : "sbp_provider_status_ambiguous",
      );
    }

    const updated = await runRepositoryOperation(
      `${operationPrefix}.markInvoiceCanceled`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => repository.markSbpInvoiceCanceled(externalPaymentId),
    );
    if (updated !== 1) {
      return reloadSbpPredecessor(repository, row, operationPrefix);
    }
    return {
      ...row,
      status: "canceled",
      failure_reason: "sbp_canceled",
    };
  }

export async function resolveSbpSuccessorChain(repository: MediaRepository, sbpClient: SbpPaymentClient | null, videos: VideoCommerceRepository, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    let current = row;
    const visited = new Set<string>();

    for (let depth = 0; depth < MAX_SBP_SUCCESSOR_DEPTH; depth += 1) {
      if (visited.has(current.token)) {
        throw new MediaCommerceOperationError(
          "SBP retry chain contains a cycle",
          `${operationPrefix}.resolveRetryChain`,
          "sbp_retry_chain_corrupt",
        );
      }
      visited.add(current.token);

      if (isExpiredSbpInvoiceSent(current)) {
        current = await reconcileExpiredSbpInvoice(repository, sbpClient, current, operationPrefix);
      }

      if (!isRetryableSbpCancellation(current)) {
        return current;
      }

      const successorToken = buildSbpRetryToken(current.token);
      const [existing] = await runRepositoryOperation(
        `${operationPrefix}.loadSbpSuccessor`,
        {
          chat_id: current.chat_id,
          payment_kind: normalizeString(current.action_kind),
          sku: normalizeString(current.sku),
          invoice_status: normalizeString(current.status),
        },
        () => repository.loadStoredInvoiceTokens([successorToken]),
      );
      if (existing) {
        current = existing;
        continue;
      }

      const successor = await createSbpSuccessorAttempt(repository, videos, current, operationPrefix);
      if (!successor) {
        throw new MediaCommerceOperationError(
          "SBP retry context is stale",
          `${operationPrefix}.createSbpSuccessor`,
          "sbp_successor_context_stale",
        );
      }
      return successor;
    }

    throw new MediaCommerceOperationError(
      "SBP retry chain is too deep",
      `${operationPrefix}.resolveRetryChain`,
      "sbp_retry_chain_corrupt",
    );
  }

export async function persistSbpCheckoutCreationUncertain(repository: MediaRepository, token: string,
    chatId: number,
    operationPrefix: string,
    context: OperationLogContext,
  ): Promise<void> {
    const updated = await runRepositoryOperation(
      `${operationPrefix}.markCheckoutCreationUncertain`,
      context,
      () => repository.markSbpCheckoutCreationUncertain(token, chatId),
    );
    if (updated !== 1) {
      console.error("[media_commerce] sbp_checkout_creation_uncertain_not_persisted", {
        token,
        chat_id: chatId,
        updated_count: updated,
      });
      throw new MediaCommerceOperationError(
        "SBP uncertain creation state was not persisted",
        `${operationPrefix}.markCheckoutCreationUncertain`,
        "sbp_checkout_uncertain_persistence_failed",
      );
    }
  }

export async function ensureStarsInvoiceLink(repository: MediaRepository, starsClient: StarsInvoiceClient, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const existingLink =
      normalizeString(row.checkout_url)
      ?? normalizeString(row.invoice_link);
    if (existingLink) {
      return {
        ...row,
        checkout_url: existingLink,
        invoice_link: existingLink,
      };
    }

    const token = normalizeString(row.token);
    const chatId = normalizePositiveInteger(row.chat_id);
    const payload = normalizeString(row.telegram_invoice_payload);
    const amountXtr = normalizePositiveInteger(row.amount_xtr);
    const title = normalizeString(row.invoice_title);
    const description = normalizeString(row.invoice_description);
    const label = normalizeString(row.invoice_label);

    if (!token || !chatId || !payload || !amountXtr || !title || !description || !label) {
      throw new MediaCommerceOperationError(
        "Stored invoice row is incomplete",
        `${operationPrefix}.createInvoiceLink`,
        "stars_invoice_creation_failed",
      );
    }

    const context = {
      chat_id: chatId,
      payment_kind: normalizeString(row.action_kind),
      sku: normalizeString(row.sku),
      amount_xtr: amountXtr,
      title,
      label,
      invoice_status: normalizeString(row.status),
    };
    const created = await runOperation(
      `${operationPrefix}.createInvoiceLink`,
      context,
      () => starsClient.createStarsInvoice({
        title,
        description,
        payload,
        label,
        amount_xtr: amountXtr,
      }),
    );

    await runRepositoryOperation(
      `${operationPrefix}.storeInvoiceLink`,
      context,
      () => repository.storeInvoiceLinks([{
        token,
        chat_id: chatId,
        invoice_link: created.invoice_link,
        checkout_url: created.invoice_link,
        external_payment_id: null,
      }]),
    );

    return {
      ...row,
      checkout_url: created.invoice_link,
      invoice_link: created.invoice_link,
    };
  }

export async function ensureSbpCheckout(repository: MediaRepository, sbpClient: SbpPaymentClient | null, videos: VideoCommerceRepository, uncertainSbpCheckouts: Map<string, { external_payment_id: string | null; checkout_url: string | null }>, row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const eligibilityError = getSbpCheckoutEligibilityError(row);
    if (eligibilityError) {
      throw new MediaCommerceOperationError(
        "SBP invoice is not eligible for checkout",
        `${operationPrefix}.validateCheckoutEligibility`,
        eligibilityError,
      );
    }

    const existingCheckout = normalizeString(row.checkout_url);
    const existingExternalPaymentId = normalizeString(row.external_payment_id);
    if (existingCheckout && existingExternalPaymentId) {
      return {
        ...row,
        checkout_url: existingCheckout,
        external_payment_id: existingExternalPaymentId,
      };
    }

    if (!sbpClient) {
      throw new MediaCommerceOperationError(
        "SBP adapter is not configured",
        `${operationPrefix}.createPayment`,
        "sbp_payment_creation_failed",
      );
    }

    const token = normalizeString(row.token);
    const chatId = normalizePositiveInteger(row.chat_id);
    const sku = normalizeString(row.sku);
    const amountRub = normalizePositiveInteger(row.amount);
    const description = normalizeString(row.invoice_description);
    if (!token || !chatId || !amountRub || !description) {
      throw new MediaCommerceOperationError(
        "Stored SBP row is incomplete",
        `${operationPrefix}.createPayment`,
        "sbp_payment_creation_failed",
      );
    }

    const uncertain = uncertainSbpCheckouts.get(token);
    if (uncertain) {
      const reloaded = await repository.loadInvoiceToken(token, chatId);
      if (
        uncertain.external_payment_id != null
        && uncertain.checkout_url != null
        && normalizeString(reloaded?.status) === "invoice_sent"
        && !isExpired(reloaded?.expires_at)
        && normalizeString(reloaded?.external_payment_id) === uncertain.external_payment_id
        && normalizeString(reloaded?.checkout_url) === uncertain.checkout_url
      ) {
        uncertainSbpCheckouts.delete(token);
        return {
          ...row,
          checkout_url: uncertain.checkout_url,
          external_payment_id: uncertain.external_payment_id,
        };
      }
      throw new MediaCommerceOperationError(
        "SBP checkout creation outcome requires reconciliation",
        `${operationPrefix}.createPayment`,
        "sbp_checkout_creation_uncertain",
      );
    }

    const claimContext = {
      chat_id: chatId,
      payment_kind: normalizeString(row.action_kind),
      sku,
      invoice_status: normalizeString(row.status),
    };
    let claim = await runRepositoryOperation(
      `${operationPrefix}.claimSbpCheckoutCreation`,
      claimContext,
      () => repository.claimSbpCheckoutCreation(token, chatId),
    );
    const waitStartedAt = Date.now();
    let pollIndex = 0;

    while (true) {
      const claimedCheckout = normalizeString(claim?.checkout_url);
      const claimedExternalPaymentId = normalizeString(claim?.external_payment_id);
      if (claim?.eligible === false) {
        throw new MediaCommerceOperationError(
          "SBP invoice became ineligible for checkout",
          `${operationPrefix}.claimSbpCheckoutCreation`,
          "sbp_invoice_status_invalid",
        );
      }
      if (claimedCheckout && claimedExternalPaymentId) {
        return {
          ...row,
          checkout_url: claimedCheckout,
          external_payment_id: claimedExternalPaymentId,
        };
      }

      if (claim?.claim_acquired) {
        break;
      }
      if (claim?.creation_state === "uncertain") {
        throw new MediaCommerceOperationError(
          "SBP checkout creation outcome requires reconciliation",
          `${operationPrefix}.createPayment`,
          "sbp_checkout_creation_uncertain",
        );
      }

      const remainingMs = SBP_CHECKOUT_WAIT_TIMEOUT_MS - (Date.now() - waitStartedAt);
      if (remainingMs <= 0) {
        throw new MediaCommerceOperationError(
          "SBP checkout creation is already in progress",
          `${operationPrefix}.createPayment`,
          "sbp_checkout_creation_in_progress",
        );
      }

      const delayMs = Math.min(
        SBP_CHECKOUT_WAIT_BACKOFF_MS[pollIndex] ?? 2000,
        remainingMs,
      );
      pollIndex += 1;
      await sleep(delayMs);

      claim = await runRepositoryOperation(
        `${operationPrefix}.claimSbpCheckoutCreation`,
        claimContext,
        () => repository.claimSbpCheckoutCreation(token, chatId),
      );
    }

    if (!await canCreateSbpSuccessor(repository, videos, row, operationPrefix)) {
      await runRepositoryOperation(
        `${operationPrefix}.releaseSbpCheckoutCreation`,
        claimContext,
        () => repository.releaseSbpCheckoutCreation(token, chatId),
      );
      throw new MediaCommerceOperationError(
        "SBP checkout context is stale",
        `${operationPrefix}.validateCheckoutContext`,
        "sbp_successor_context_stale",
      );
    }

    let created: {
      external_payment_id: string;
      checkout_url: string;
      provider_expires_at: string | null;
    };
    try {
      created = await runOperation(
        `${operationPrefix}.createPayment`,
        {
          chat_id: chatId,
          payment_kind: normalizeString(row.action_kind),
          sku,
          invoice_status: normalizeString(row.status),
        },
        () => sbpClient!.createPayment({
          token,
          chat_id: chatId,
          description,
          amount_rub: amountRub,
          metadata: {
            scene_session_id: row.scene_session_id,
            action_kind: row.action_kind ?? null,
          },
        }),
      );
    } catch (error) {
      const providerError = getSbpPaymentError(error);
      if (providerError?.outcome === "definite_failure") {
        await runRepositoryOperation(
          `${operationPrefix}.releaseSbpCheckoutCreation`,
          claimContext,
          () => repository.releaseSbpCheckoutCreation(token, chatId),
        );
      } else {
        uncertainSbpCheckouts.set(token, {
          external_payment_id: null,
          checkout_url: null,
        });
        await persistSbpCheckoutCreationUncertain(repository, 
          token,
          chatId,
          operationPrefix,
          claimContext,
        );
        throw new MediaCommerceOperationError(
          "SBP checkout creation outcome requires reconciliation",
          `${operationPrefix}.createPayment`,
          "sbp_checkout_creation_uncertain",
          { cause: error instanceof Error ? error : undefined },
        );
      }
      throw error;
    }

    uncertainSbpCheckouts.set(token, created);
    let updatedCount: number;
    try {
      updatedCount = await runRepositoryOperation(
        `${operationPrefix}.storeCheckout`,
        claimContext,
        () => repository.storeInvoiceLinks([{
          token,
          chat_id: chatId,
          invoice_link: null,
          checkout_url: created.checkout_url,
          external_payment_id: created.external_payment_id,
          expires_at: created.provider_expires_at,
        }]),
      );
    } catch (error) {
      await persistSbpCheckoutCreationUncertain(repository, 
        token,
        chatId,
        operationPrefix,
        claimContext,
      );
      throw new MediaCommerceOperationError(
        "SBP checkout persistence outcome requires reconciliation",
        `${operationPrefix}.storeCheckout`,
        "sbp_checkout_creation_uncertain",
        { cause: error instanceof Error ? error : undefined },
      );
    }
    if (updatedCount !== 1) {
      await persistSbpCheckoutCreationUncertain(repository, 
        token,
        chatId,
        operationPrefix,
        claimContext,
      );
      throw new MediaCommerceOperationError(
        "SBP checkout was not persisted to the expected invoice",
        `${operationPrefix}.storeCheckout`,
        "sbp_checkout_creation_uncertain",
      );
    }

    const saved = await runRepositoryOperation(
      `${operationPrefix}.reloadCheckout`,
      claimContext,
      () => repository.loadInvoiceToken(token, chatId),
    );
    if (
      normalizeString(saved?.external_payment_id) !== created.external_payment_id
      || normalizeString(saved?.checkout_url) !== created.checkout_url
    ) {
      throw new MediaCommerceOperationError(
        "Persisted SBP checkout does not match provider response",
        `${operationPrefix}.reloadCheckout`,
        "sbp_checkout_persistence_failed",
      );
    }
    uncertainSbpCheckouts.delete(token);

    if (normalizeString(saved?.status) !== "invoice_sent") {
      throw new MediaCommerceOperationError(
        "Persisted SBP checkout is no longer payable",
        `${operationPrefix}.reloadCheckout`,
        "sbp_invoice_status_invalid",
      );
    }

    return {
      ...row,
      checkout_url: created.checkout_url,
      external_payment_id: created.external_payment_id,
    };
  }

export async function resolveSbpCheckout(repository: MediaRepository, sbpClient: SbpPaymentClient | null, videos: VideoCommerceRepository, uncertainSbpCheckouts: Map<string, { external_payment_id: string | null; checkout_url: string | null }>, tokenInput: string): Promise<string> {
    const token = normalizeString(tokenInput);
    if (!token) {
      throw new MediaCommerceOperationError(
        "SBP invoice token is required",
        "sbpRedirect.loadInvoiceToken",
        "sbp_invoice_not_found",
      );
    }

    const rows = await runRepositoryOperation(
      "sbpRedirect.loadInvoiceToken",
      {
        chat_id: null,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => repository.loadStoredInvoiceTokens([token]),
    );
    const row = rows.find((candidate) => candidate.token === token);

    if (!row) {
      throw new MediaCommerceOperationError(
        "SBP invoice token was not found",
        "sbpRedirect.loadInvoiceToken",
        "sbp_invoice_not_found",
      );
    }
    if (isMaintenanceBlocked(row.chat_id)) {
      throw new MediaCommerceOperationError(
        "SBP checkout is unavailable during maintenance",
        "sbpRedirect.validateMaintenanceAccess",
        "maintenance_mode",
      );
    }
    const resolvedRow = await resolveSbpSuccessorChain(repository, sbpClient, videos, row, "sbpRedirect");
    const eligibilityError = getSbpCheckoutEligibilityError(resolvedRow);
    if (eligibilityError) {
      throw new MediaCommerceOperationError(
        "Invoice token is not eligible for SBP checkout",
        "sbpRedirect.validateCheckoutEligibility",
        eligibilityError,
      );
    }

    const payload=parseJsonObject(resolvedRow.payload_json)??{};
    if(['video_unlock','video_pass','scene_unlock'].includes(String(payload.feature_key)) &&
      !await canCreateSbpSuccessor(repository, videos, resolvedRow,'sbpRedirect')){
      throw new MediaCommerceOperationError('Product is no longer available','sbpRedirect.validateCheckoutEligibility','sbp_invoice_not_payable');
    }
    const ready = await ensureSbpCheckout(repository, sbpClient, videos, uncertainSbpCheckouts, resolvedRow, "sbpRedirect");
    const checkoutUrl = normalizeString(ready.checkout_url);
    if (!checkoutUrl) {
      throw new MediaCommerceOperationError(
        "SBP checkout URL was not created",
        "sbpRedirect.createPayment",
        "sbp_payment_creation_failed",
      );
    }

    return checkoutUrl;
  }

export async function prepareRenderablePaymentRows(repository: MediaRepository, starsClient: StarsInvoiceClient, rows: StoredInvoiceToken[],
    operationPrefix: string,
  ): Promise<StoredInvoiceToken[]> {
    const methods = getMediaPaymentMethods();
    const renderableRows = rows.filter(row => isRenderableStoredInvoiceRow(row)
      && methods.includes(row.payment_source as 'stars'|'sbp'));
    const groupsWithUsableSbp = new Set(
      renderableRows
        .filter((row) => normalizePaymentSource(row.payment_source) === "sbp")
        .map((row) => buildPurchaseGroupKey(row))
        .filter((value): value is string => value != null),
    );
    const preparedRows: StoredInvoiceToken[] = [];

    for (const row of renderableRows) {
      const paymentSource = normalizePaymentSource(row.payment_source);
      if (paymentSource === "sbp") {
        preparedRows.push(buildSbpGatewayRow(row));
        continue;
      }

      try {
        preparedRows.push(await ensureStarsInvoiceLink(repository, starsClient, row, operationPrefix));
      } catch (error) {
        const purchaseGroup = buildPurchaseGroupKey(row);
        if (
          isTransientStarsInvoiceError(error)
          && purchaseGroup != null
          && groupsWithUsableSbp.has(purchaseGroup)
        ) {
          const starsError = getTelegramStarsInvoiceError(error);
          console.warn("[media_commerce] transient_stars_invoice_unavailable", {
            token: row.token,
            chat_id: row.chat_id,
            sku: normalizeString(row.sku),
            status_code: starsError?.statusCode ?? null,
          });
          continue;
        }
        throw error;
      }
    }

    return preparedRows;
  }
