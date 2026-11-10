import type { VideoCommerceRepository, VideoContext } from '../media/videoRepository.js';
import { config } from '../../config.js';
import { getMediaUxCopy } from '../../mediaLocalization.js';
import { isMaintenanceBlocked } from '../../maintenance.js';
import { INVOICE_PAYLOAD_KIND, hasExpectedPaymentDetails, normalizePaymentActionKind, normalizePaymentSource, resolveInvoiceActionResult, toPaidInvoiceToken, validatePrecheckout } from './paymentFlow.js';
import type { ResolvedInvoiceAction } from './paymentFlow.js';
import { buildBaseResponse } from '../../application/mediaCommerce/responseBuilders.js';
import { normalizeLowerString, normalizeNonNegativeInteger, normalizePositiveInteger, normalizeString, parseJsonArray, parseJsonObject } from '../../mediaCommerce/utils.js';
import { MediaRepositoryContractError } from '../../mediaCommerceRepository/errors.js';
import type { MediaCommerceDecisionRequest } from '../../mediaCommerce/requestSchema.js';
import type { CommerceUi, CommerceSurface, MediaCommerceDecisionResponse, MediaContext, PaidInvoiceToken, LoadedInvoiceToken } from '../../mediaCommerceTypes.js';
import { MediaCommerceOperationError, runRepositoryOperation } from '../../mediaCommerce/operations.js';
import { renderUx, videoPaymentCleanupUrls, deliveryResponse, buildFeatureFulfillmentResponse } from '../../application/mediaCommerce/paymentResponses.js';
import type { MediaRepository } from '../../mediaCommerce/repositoryContract.js';
import { videoInvoiceAllowed } from '../access/videoEligibility.js';

export type SubscriptionPaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "subscription" }
>;

export type FeaturePaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "feature" }
>;

export function normalizePaymentKindFromActionKind(
  value: string | null | undefined,
): "subscription" | "photo" | "feature" | null {
  const actionKind = normalizePaymentActionKind(value);
  if (actionKind === "subscription_payment") return "subscription";
  if (actionKind === "photo_payment") return "photo";
  if (actionKind === "feature_payment") return "feature";
  return null;
}

export function normalizePositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export async function evaluatePrecheckout(repository: MediaRepository, videos: VideoCommerceRepository, input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "pre_checkout");
    const requestedChatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!invoicePayload) {
      return {
        ...base,
        operation: "answer_precheckout",
        precheckout_ok: false,
        precheckout_error: getMediaUxCopy().payment_errors.stale,
        reason: "invoice_payload_required",
      };
    }
    if (isMaintenanceBlocked(
      input.source_user_id ?? input.telegram_chat_id ?? requestedChatId,
    )) {
      return {
        ...base,
        operation: "answer_precheckout",
        precheckout_ok: false,
        precheckout_error: config.MAINTENANCE_TEXT,
        reason: "maintenance_mode",
      };
    }

    const tokenRow = await runRepositoryOperation(
      "payment.precheckout.loadInvoiceToken",
      {
        chat_id: requestedChatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => repository.loadInvoiceToken(invoicePayload, requestedChatId),
    );
    const chatId = normalizePositiveInteger(tokenRow?.chat_id) ?? requestedChatId;
    if (!chatId) {
      return {
        ...base,
        operation: "answer_precheckout",
        precheckout_ok: false,
        precheckout_error: getMediaUxCopy().payment_errors.stale,
        reason: "chat_id_required",
      };
    }
    let validation = validatePrecheckout(
      tokenRow,
      normalizeString(input.payment_currency),
      normalizeNonNegativeInteger(input.payment_total_amount),
    );
    if (validation.ok && validation.action) {
      const payload = parseJsonObject(tokenRow?.payload_json) ?? {};
      const invoiceSceneSessionId =
        normalizeString(tokenRow?.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        );
      if (validation.action.payment_kind === "subscription") {
        const offerId = normalizeString(
          typeof payload.idempotency_key === "string" ? payload.idempotency_key : null,
        );
        const activeOfferId = await runRepositoryOperation(
          "payment.precheckout.loadActiveSubscriptionOfferId",
          {
            chat_id: chatId,
            payment_kind: validation.action.payment_kind,
            sku: normalizeString(tokenRow?.sku),
            invoice_status: normalizeString(tokenRow?.status),
          },
          () => repository.loadActiveSubscriptionOfferId(chatId),
        );
        if (!offerId || activeOfferId !== offerId) {
          validation = {
            ...validation,
            ok: false,
            error: getMediaUxCopy().payment_errors.stale,
            reason: "subscription_offer_not_active",
          };
        }
      }
      if (
        validation.action?.payment_kind === "photo"
        || (
          validation.action?.payment_kind === "feature"
          && invoiceSceneSessionId != null
        )
      ) {
        const validationAction = validation.action;
        const sceneStatus = await runRepositoryOperation(
          "payment.precheckout.loadSceneAccessStatus",
          {
            chat_id: chatId,
            payment_kind: validationAction.payment_kind,
            sku: normalizeString(tokenRow?.sku),
            invoice_status: normalizeString(tokenRow?.status),
          },
          () => repository.loadSceneAccessStatus({
            chat_id: chatId,
            scene_session_id: invoiceSceneSessionId,
          }),
        );
        if (!invoiceSceneSessionId || sceneStatus?.scene_is_active !== true) {
          validation = {
            ...validation,
            ok: false,
            error: getMediaUxCopy().payment_errors.different_scene,
            reason: "scene_invoice_not_active",
          };
        } else if (validationAction.feature_key === 'video_unlock' || validationAction.feature_key === 'video_pass') {
          if (!await videoInvoiceAllowed(videos, chatId,invoiceSceneSessionId,validationAction.feature_key,payload)) {
            validation={...validation,ok:false,error:getMediaUxCopy().payment_errors.stale,reason:'video_invoice_stale'};
          }
        } else if (sceneStatus.subscription_active) {
          validation = {
            ...validation,
            ok: false,
            error: getMediaUxCopy().payment_errors.subscription_active,
            reason: "subscription_already_active",
          };
        } else if (sceneStatus.scene_access_active) {
          validation = {
            ...validation,
            ok: false,
            error: getMediaUxCopy().payment_errors.scene_already_unlocked,
            reason: "scene_access_already_active",
          };
        }
      }
    }

    if (tokenRow?.token != null) {
      const token = tokenRow.token;
      await runRepositoryOperation(
        "payment.precheckout.storePrecheckoutResult",
        {
          chat_id: normalizePositiveInteger(tokenRow.chat_id) ?? chatId,
          payment_kind: validation.action?.payment_kind ?? null,
          sku: normalizeString(tokenRow.sku),
          invoice_status: normalizeString(tokenRow.status),
        },
        () => repository.storePrecheckoutResult({
          token,
          pre_checkout_query_id: normalizeString(input.pre_checkout_query_id),
          ok: validation.ok,
          error_message: validation.error,
        }),
      );
    }

    return {
      ...base,
      operation: "answer_precheckout",
      chat_id: chatId,
      scene_session_id: tokenRow?.scene_session_id ?? base.scene_session_id,
      turn_no: normalizeNonNegativeInteger(tokenRow?.turn_no) ?? base.turn_no,
      payment_kind: validation.action?.payment_kind ?? null,
      feature_key: validation.action?.feature_key ?? null,
      precheckout_ok: validation.ok,
      precheckout_error: validation.error,
      reason: validation.reason,
    };
  }

export async function evaluatePaymentSuccess(repository: MediaRepository, videos: VideoCommerceRepository, applyMediaActionDecision: (base: MediaCommerceDecisionResponse, context: MediaContext) => Promise<MediaCommerceDecisionResponse>, loadVideoContext: (base: MediaCommerceDecisionResponse) => Promise<VideoContext>, allowRootButtons: (root: CommerceUi['return_context'], receipts: unknown[], base: MediaCommerceDecisionResponse) => Promise<void>, commerceRoot: (base: MediaCommerceDecisionResponse, surface: CommerceSurface, ctx?: VideoContext | null, returnContext?: CommerceUi['return_context']) => Promise<MediaCommerceDecisionResponse>, input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "payment_success");
    if (normalizeString(input.event_type) === "payment.chargebacked.received") {
      return evaluateExternalPaymentChargeback(repository, base, input);
    }
    if (normalizeString(input.event_type) === "payment.canceled.received") {
      return evaluateExternalPaymentCancellation(repository, base, input);
    }
    const inputPaymentSource = normalizePaymentSource(input.payment_source);
    if (
      inputPaymentSource === "sbp"
      || normalizeString(input.event_type) === "payment.confirmed.received"
    ) {
      return evaluateExternalPaymentSuccess(repository, videos, applyMediaActionDecision, loadVideoContext, allowRootButtons, commerceRoot, base, input);
    }

    const requestedChatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!invoicePayload) {
      return {
        ...base,
        reason: "invoice_payload_required",
      };
    }

    const loaded = await runRepositoryOperation(
      "payment.success.loadInvoiceToken",
      {
        chat_id: requestedChatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => repository.loadInvoiceToken(invoicePayload, requestedChatId),
    );
    if (!loaded?.found || !loaded.token) {
      return { ...base, reason: "invoice_not_found" };
    }
    const chatId = normalizePositiveInteger(loaded.chat_id) ?? requestedChatId;
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    if (normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        reason: "invoice_kind_invalid",
      };
    }

    const payload = parseJsonObject(loaded.payload_json) ?? {};
    const actionResolution = resolveInvoiceActionResult(payload, loaded.action_kind);
    if (actionResolution.reason != null || !actionResolution.action) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        reason: actionResolution.reason ?? "invoice_action_kind_invalid",
      };
    }
    const resolvedAction = actionResolution.action;

    const existingStatus = normalizeString(loaded.status);
    if (
      !hasExpectedPaymentDetails(
        loaded.amount,
        loaded.currency,
        normalizeString(input.payment_currency),
        normalizeNonNegativeInteger(input.payment_total_amount),
      )
    ) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_details_mismatch",
      };
    }

    if (existingStatus === "fulfilled") {
      if (
        resolvedAction.payment_kind === "feature"
        && resolvedAction.feature_key === "scene_unlock" && !payload.commerce_origin
      ) {
        return {
          ...base,
          operation: "scene_access_activated",
          text: getMediaUxCopy().callbacks.scene_access_activated,
          chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
          scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
          turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
          payment_kind: resolvedAction.payment_kind,
          payment_token: loaded.token,
          feature_key: resolvedAction.feature_key,
          target_message_id:
            normalizePositiveInteger(payload.target_message_id)
            ?? normalizePositiveInteger(loaded.telegram_invoice_message_id)
            ?? null,
          reason: "already_active",
        };
      }
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        payment_token: loaded.token,
        feature_key: resolvedAction.feature_key,
        reason: "payment_already_fulfilled",
      };
    }

    let paidRow: PaidInvoiceToken | null = null;
    if (existingStatus === "paid") {
      paidRow = toPaidInvoiceToken(loaded);
    } else if (existingStatus === "invoice_sent") {
      const loadedToken = loaded.token;
      paidRow = await runRepositoryOperation(
        "payment.success.markInvoicePaid",
        {
          chat_id: chatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => repository.markInvoicePaid({
          token: loadedToken,
          chat_id: chatId,
          expected_kind: INVOICE_PAYLOAD_KIND,
          expected_action_kind: resolvedAction.action_kind,
          payment_source: "stars",
          telegram_payment_charge_id: normalizeString(
            input.telegram_payment_charge_id,
          ),
          provider_payment_charge_id: normalizeString(
            input.provider_payment_charge_id,
          ),
          external_payment_id: null,
          payment_currency: normalizeString(input.payment_currency),
          payment_total_amount: normalizeNonNegativeInteger(
            input.payment_total_amount,
          ),
          checkout_url: normalizeString(input.checkout_url),
        }),
      );

      if (!paidRow) {
        const reloaded = await runRepositoryOperation(
          "payment.success.reloadInvoiceToken",
          {
            chat_id: chatId,
            payment_kind: actionResolution.action.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => repository.loadInvoiceToken(invoicePayload, chatId),
        );
        const reloadedStatus = normalizeString(reloaded?.status);
        if (reloadedStatus === "fulfilled") {
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_kind: resolvedAction.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: resolvedAction.feature_key,
            reason: "payment_already_fulfilled",
          };
        }
        if (reloadedStatus === "paid" && reloaded) {
          paidRow = toPaidInvoiceToken(reloaded);
        }
        if (
          reloadedStatus === "canceled"
          && normalizeString(reloaded?.failure_reason) === "sibling_paid"
        ) {
          console.error("[media_commerce] stars_status_conflict", {
            token: reloaded?.token,
            chat_id: reloaded?.chat_id,
            local_status: reloadedStatus,
            failure_reason: reloaded?.failure_reason,
          });
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_kind: resolvedAction.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: resolvedAction.feature_key,
            reason: "payment_status_conflict",
          };
        }
      }
    } else if (
      existingStatus === "canceled"
      && normalizeString(loaded.failure_reason) === "sibling_paid"
    ) {
      console.error("[media_commerce] stars_status_conflict", {
        token: loaded.token,
        chat_id: loaded.chat_id,
        local_status: existingStatus,
        failure_reason: loaded.failure_reason,
      });
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        payment_token: loaded.token,
        feature_key: resolvedAction.feature_key,
        reason: "payment_status_conflict",
      };
    } else {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "invoice_status_invalid",
      };
    }

    if (!paidRow) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_not_claimed",
      };
    }

    if (resolvedAction.payment_kind === "subscription") {
      return fulfillSubscriptionPayment(repository, videos, 
        base,
        paidRow,
        resolvedAction,
      );
    }

    if (resolvedAction.payment_kind === "feature") {
      if (resolvedAction.feature_key === 'video_unlock' || resolvedAction.feature_key === 'video_pass') {
        return fulfillVideoPayment(repository, videos, base, paidRow, payload, resolvedAction.feature_key);
      }
      if (resolvedAction.feature_key === "scene_unlock") {
        return fulfillSceneAccessPayment(repository, loadVideoContext, allowRootButtons, commerceRoot, 
          base,
          paidRow,
          payload,
          resolvedAction,
        );
      }
      return buildFeatureFulfillmentResponse(
        base,
        paidRow,
        payload,
        resolvedAction,
      );
    }

    return fulfillPhotoPayment(repository, applyMediaActionDecision, base, paidRow, payload);
  }

export async function recordSbpProviderEvent(repository: MediaRepository, input: MediaCommerceDecisionRequest,
    providerStatus: "CONFIRMED" | "CANCELED" | "CHARGEBACKED",
    loaded: LoadedInvoiceToken,
    operationPrefix: string,
  ): Promise<void> {
    const externalPaymentId = normalizeString(input.external_payment_id);
    const providerAmount = normalizePositiveFiniteNumber(input.provider_payment_amount);
    const providerCurrency = normalizeString(input.payment_currency);
    const providerPaymentMethod = normalizePositiveInteger(input.provider_payment_method);
    if (!externalPaymentId || !providerAmount || !providerCurrency) {
      throw new MediaCommerceOperationError(
        "SBP provider event is incomplete",
        `${operationPrefix}.recordProviderEvent`,
        "payment_details_mismatch",
      );
    }

    const updatedCount = await runRepositoryOperation(
      `${operationPrefix}.recordProviderEvent`,
      {
        chat_id: normalizePositiveInteger(loaded.chat_id),
        payment_kind: normalizeString(loaded.action_kind),
        sku: normalizeString(loaded.sku),
        invoice_status: normalizeString(loaded.status),
      },
      () => repository.recordSbpProviderEvent({
        external_payment_id: externalPaymentId,
        provider_status: providerStatus,
        provider_amount: providerAmount,
        provider_currency: providerCurrency,
        provider_payment_method: providerPaymentMethod,
      }),
    );
    if (updatedCount !== 1) {
      throw new MediaCommerceOperationError(
        "SBP provider event was not persisted",
        `${operationPrefix}.recordProviderEvent`,
        "sbp_provider_event_persistence_failed",
      );
    }
  }

export async function evaluateExternalPaymentCancellation(repository: MediaRepository, base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);
    if (!externalPaymentId) {
      return { ...base, payment_source: "sbp", reason: "external_payment_id_required" };
    }

    const loaded = await runRepositoryOperation(
      "payment.external.loadCanceledInvoice",
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
    );
    if (!loaded?.found || !loaded.token) {
      return { ...base, payment_source: "sbp", reason: "payment_not_found" };
    }
    if (
      normalizeString(loaded.external_payment_id) !== externalPaymentId
      || normalizePaymentSource(loaded.payment_source) !== "sbp"
      || normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND
    ) {
      return { ...base, payment_source: "sbp", reason: "payment_not_found" };
    }

    await recordSbpProviderEvent(repository, 
      input,
      "CANCELED",
      loaded,
      "payment.externalCanceled",
    );

    const status = normalizeString(loaded.status);
    if (status === "canceled") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        payment_source: "sbp",
        payment_token: loaded.token,
        reason: "payment_already_canceled",
      };
    }
    if (status === "paid" || status === "fulfilled") {
      const conflictRecorded = await runRepositoryOperation(
        "payment.externalCanceled.recordStatusConflict",
        {
          chat_id: normalizePositiveInteger(loaded.chat_id),
          payment_kind: normalizePaymentKindFromActionKind(loaded.action_kind),
          sku: normalizeString(loaded.sku),
          invoice_status: status,
        },
        () => repository.recordSbpStatusConflict(externalPaymentId, "CANCELED"),
      );
      if (conflictRecorded !== 1) {
        throw new MediaCommerceOperationError(
          "SBP payment status conflict was not persisted",
          "payment.externalCanceled.recordStatusConflict",
          "sbp_status_conflict_persistence_failed",
        );
      }
      console.error("[media_commerce] sbp_status_conflict", {
        external_payment_id: externalPaymentId,
        token: loaded.token,
        chat_id: loaded.chat_id,
        local_status: status,
        provider_status: "CANCELED",
      });
      return {
        ...base,
        operation: "noop",
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        payment_kind: normalizePaymentKindFromActionKind(loaded.action_kind),
        payment_token: loaded.token,
        reason: "payment_status_conflict",
      };
    }
    if (status !== "invoice_sent") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        payment_source: "sbp",
        payment_token: loaded.token,
        reason: "invoice_status_invalid",
      };
    }

    const updated = await runRepositoryOperation(
      "payment.external.markInvoiceCanceled",
      {
        chat_id: normalizePositiveInteger(loaded.chat_id),
        payment_kind: normalizeString(loaded.action_kind),
        sku: normalizeString(loaded.sku),
        invoice_status: status,
      },
      () => repository.markSbpInvoiceCanceled(externalPaymentId),
    );
    if (updated !== 1) {
      const reloaded = await repository.loadInvoiceTokenByExternalPaymentId(
        externalPaymentId,
      );
      if (normalizeString(reloaded?.status) !== "canceled") {
        return { ...base, payment_source: "sbp", reason: "payment_not_canceled" };
      }
    }

    return {
      ...base,
      chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
      payment_source: "sbp",
      payment_token: loaded.token,
      reason: "payment_canceled",
    };
  }

export async function evaluateExternalPaymentChargeback(repository: MediaRepository, base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);
    if (!externalPaymentId) {
      return { ...base, payment_source: "sbp", reason: "external_payment_id_required" };
    }

    const loaded = await runRepositoryOperation(
      "payment.externalChargeback.loadInvoiceTokenByExternalPaymentId",
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
    );
    if (!loaded?.found || !loaded.token) {
      return { ...base, payment_source: "sbp", reason: "payment_not_found" };
    }
    if (
      normalizeString(loaded.external_payment_id) !== externalPaymentId
      || normalizePaymentSource(loaded.payment_source) !== "sbp"
      || normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND
    ) {
      return { ...base, payment_source: "sbp", reason: "payment_not_found" };
    }

    await recordSbpProviderEvent(repository, 
      input,
      "CHARGEBACKED",
      loaded,
      "payment.externalChargeback",
    );

    console.error("[media_commerce] sbp_chargeback_recorded", {
      external_payment_id: externalPaymentId,
      token: loaded.token,
      chat_id: loaded.chat_id,
      local_status: loaded.status,
    });

    return {
      ...base,
      operation: "noop",
      chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
      scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
      turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
      payment_source: "sbp",
      payment_token: loaded.token,
      reason: "payment_chargeback_recorded",
    };
  }

export async function evaluateExternalPaymentSuccess(repository: MediaRepository, videos: VideoCommerceRepository, applyMediaActionDecision: (base: MediaCommerceDecisionResponse, context: MediaContext) => Promise<MediaCommerceDecisionResponse>, loadVideoContext: (base: MediaCommerceDecisionResponse) => Promise<VideoContext>, allowRootButtons: (root: CommerceUi['return_context'], receipts: unknown[], base: MediaCommerceDecisionResponse) => Promise<void>, commerceRoot: (base: MediaCommerceDecisionResponse, surface: CommerceSurface, ctx?: VideoContext | null, returnContext?: CommerceUi['return_context']) => Promise<MediaCommerceDecisionResponse>, base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);

    if (!externalPaymentId) {
      return {
        ...base,
        payment_source: "sbp",
        reason: "external_payment_id_required",
      };
    }

    const loaded = await runRepositoryOperation(
      "payment.external.loadInvoiceTokenByExternalPaymentId",
      {
        chat_id: null,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
    );
    if (!loaded?.found || !loaded.token) {
      return {
        ...base,
        payment_source: "sbp",
        reason: "payment_not_found",
      };
    }

    if (normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        reason: "invoice_kind_invalid",
      };
    }

    if (normalizePaymentSource(loaded.payment_source) !== "sbp") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: normalizePaymentSource(loaded.payment_source),
        reason: "payment_source_invalid",
      };
    }

    if (normalizeString(loaded.external_payment_id) !== externalPaymentId) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        reason: "payment_not_found",
      };
    }

    const payload = parseJsonObject(loaded.payload_json) ?? {};
    const loadedToken = loaded.token;
    const loadedChatId = normalizePositiveInteger(loaded.chat_id);
    if (!loadedChatId) {
      throw new MediaRepositoryContractError("payment.external.loadInvoiceTokenByExternalPaymentId", {
        field: "chat_id",
        reason: "invalid",
      });
    }
    const actionResolution = resolveInvoiceActionResult(payload, loaded.action_kind);
    if (actionResolution.reason != null || !actionResolution.action) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        reason: actionResolution.reason ?? "invoice_action_kind_invalid",
      };
    }

    const resolvedAction = actionResolution.action;
    const existingStatus = normalizeString(loaded.status);
    const providerAmount = normalizePositiveFiniteNumber(input.provider_payment_amount);
    if (
      normalizeString(loaded.currency) !== "RUB"
      || normalizeString(input.payment_currency) !== "RUB"
      || !providerAmount
    ) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_details_mismatch",
      };
    }

    await recordSbpProviderEvent(repository, 
      input,
      "CONFIRMED",
      loaded,
      "payment.externalConfirmed",
    );

    if (existingStatus === "canceled") {
      const conflictRecorded = await runRepositoryOperation(
        "payment.external.recordStatusConflict",
        {
          chat_id: loadedChatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => repository.recordSbpStatusConflict(externalPaymentId, "CONFIRMED"),
      );
      if (conflictRecorded !== 1) {
        throw new MediaCommerceOperationError(
          "SBP payment status conflict was not persisted",
          "payment.external.recordStatusConflict",
          "sbp_status_conflict_persistence_failed",
        );
      }
      console.error("[media_commerce] sbp_status_conflict", {
        external_payment_id: externalPaymentId,
        local_status: existingStatus,
        provider_status: "CONFIRMED",
      });
      return {
        ...base,
        chat_id: loadedChatId,
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        payment_token: loaded.token,
        feature_key: resolvedAction.feature_key,
        reason: "payment_status_conflict",
      };
    }

    if (existingStatus === "fulfilled") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        payment_token: loaded.token,
        feature_key: resolvedAction.feature_key,
        reason: "payment_already_fulfilled",
      };
    }

    let paidRow: PaidInvoiceToken | null = null;
    if (existingStatus === "paid") {
      paidRow = toPaidInvoiceToken(loaded);
    } else if (existingStatus === "invoice_sent") {
      paidRow = await runRepositoryOperation(
        "payment.external.markInvoicePaid",
        {
          chat_id: loadedChatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => repository.markInvoicePaid({
          token: loadedToken,
          chat_id: loadedChatId,
          expected_kind: INVOICE_PAYLOAD_KIND,
          expected_action_kind: resolvedAction.action_kind,
          payment_source: "sbp",
          telegram_payment_charge_id: null,
          provider_payment_charge_id: null,
          external_payment_id: externalPaymentId,
          payment_currency: normalizeString(input.payment_currency),
          payment_total_amount: normalizePositiveInteger(loaded.amount),
          checkout_url: normalizeString(input.checkout_url),
        }),
      );

      if (!paidRow) {
        const reloaded = await runRepositoryOperation(
          "payment.external.reloadInvoiceTokenByExternalPaymentId",
          {
            chat_id: loadedChatId,
            payment_kind: resolvedAction.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
        );
        const reloadedStatus = normalizeString(reloaded?.status);
        if (reloadedStatus === "fulfilled") {
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_source: "sbp",
            payment_kind: resolvedAction.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: resolvedAction.feature_key,
            reason: "payment_already_fulfilled",
          };
        }
        if (reloadedStatus === "paid" && reloaded) {
          paidRow = toPaidInvoiceToken(reloaded);
        }
        if (
          reloadedStatus === "canceled"
          && normalizeString(reloaded?.failure_reason) === "sibling_paid"
        ) {
          const conflictRecorded = await runRepositoryOperation(
            "payment.external.recordStatusConflict",
            {
              chat_id: loadedChatId,
              payment_kind: resolvedAction.payment_kind,
              sku: normalizeString(loaded.sku),
              invoice_status: reloadedStatus,
            },
            () => repository.recordSbpStatusConflict(externalPaymentId, "CONFIRMED"),
          );
          if (conflictRecorded !== 1) {
            throw new MediaCommerceOperationError(
              "SBP payment status conflict was not persisted",
              "payment.external.recordStatusConflict",
              "sbp_status_conflict_persistence_failed",
            );
          }
          console.error("[media_commerce] sbp_status_conflict", {
            external_payment_id: externalPaymentId,
            local_status: reloadedStatus,
            provider_status: "CONFIRMED",
            failure_reason: reloaded?.failure_reason,
          });
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_source: "sbp",
            payment_kind: resolvedAction.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: resolvedAction.feature_key,
            reason: "payment_status_conflict",
          };
        }
      }
    } else {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "invoice_status_invalid",
      };
    }

    if (!paidRow) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_not_claimed",
      };
    }

    if (resolvedAction.payment_kind === "subscription") {
      return fulfillSubscriptionPayment(repository, videos, base, paidRow, resolvedAction);
    }

    if (resolvedAction.payment_kind === "feature") {
      if (resolvedAction.feature_key === 'video_unlock' || resolvedAction.feature_key === 'video_pass') {
        return fulfillVideoPayment(repository, videos, base, paidRow, payload, resolvedAction.feature_key);
      }
      if (resolvedAction.feature_key === "scene_unlock") {
        return fulfillSceneAccessPayment(repository, loadVideoContext, allowRootButtons, commerceRoot, base, paidRow, payload, resolvedAction);
      }
      return buildFeatureFulfillmentResponse(base, paidRow, payload, resolvedAction);
    }

    return fulfillPhotoPayment(repository, applyMediaActionDecision, base, paidRow, payload);
  }

export async function fulfillSubscriptionPayment(repository: MediaRepository, videos: VideoCommerceRepository, base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    action: SubscriptionPaymentAction,
  ): Promise<MediaCommerceDecisionResponse> {
    const subscriptionDays = action.subscription_days;
    const subscriptionSku = action.subscription_sku ?? normalizeString(paidRow.sku);
    if (subscriptionDays <= 0 || !subscriptionSku) {
      return {
        ...base,
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "subscription",
        payment_token: paidRow.token,
        reason: "invoice_action_kind_invalid",
      };
    }

    const activatedCount = await runRepositoryOperation(
      "payment.subscription.activateSubscription",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "subscription",
        sku: subscriptionSku,
        invoice_status: paidRow.status,
      },
      () => paidRow.payload_json?.subscription_tier === 'full'
        ? videos.activateFullSubscription(paidRow.token,paidRow.chat_id,subscriptionSku,subscriptionDays,
          paidRow.payload_json?.subscription_change === 'upgrade' ? 'upgrade' : 'renew')
        : repository.activateSubscription({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        subscription_sku: subscriptionSku,
        subscription_days: subscriptionDays,
      }),
    );

    const offerId = normalizeString(
      typeof paidRow.payload_json?.idempotency_key === "string"
        ? paidRow.payload_json.idempotency_key
        : null,
    );
    if (offerId) {
      await runRepositoryOperation(
        "payment.subscription.clearActiveOffer",
        {
          chat_id: paidRow.chat_id,
          payment_kind: "subscription",
          sku: subscriptionSku,
          invoice_status: paidRow.status,
        },
        () => repository.clearActiveSubscriptionOffer(paidRow.chat_id, offerId),
      );
    }

    if (activatedCount <= 0) {
      return {
        ...base,
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "subscription",
        payment_token: paidRow.token,
        subscription_days: subscriptionDays,
        subscription_sku: subscriptionSku,
        offer_message_id: normalizePositiveInteger(
          paidRow.telegram_invoice_message_id,
        ),
        reason: "subscription_already_activated",
      };
    }

    return {
      ...base,
      operation: "subscription_activated",
      chat_id: paidRow.chat_id,
      scene_session_id: paidRow.scene_session_id,
      turn_no: paidRow.turn_no,
      payment_kind: "subscription",
      payment_token: paidRow.token,
      subscription_days: subscriptionDays,
      subscription_sku: subscriptionSku,
      offer_message_id: normalizePositiveInteger(
        paidRow.telegram_invoice_message_id,
      ),
      stored_count: activatedCount,
      reason: "subscription_activated",
    };
  }

export async function fulfillSceneAccessPayment(repository: MediaRepository, loadVideoContext: (base: MediaCommerceDecisionResponse) => Promise<VideoContext>, allowRootButtons: (root: CommerceUi['return_context'], receipts: unknown[], base: MediaCommerceDecisionResponse) => Promise<void>, commerceRoot: (base: MediaCommerceDecisionResponse, surface: CommerceSurface, ctx?: VideoContext | null, returnContext?: CommerceUi['return_context']) => Promise<MediaCommerceDecisionResponse>, base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
    action: FeaturePaymentAction,
  ): Promise<MediaCommerceDecisionResponse> {
    const sceneSessionId = normalizeString(
      typeof payload.scene_session_id === "string"
        ? payload.scene_session_id
        : paidRow.scene_session_id,
    );
    const sceneAccessSku = normalizeString(paidRow.sku);
    if (!sceneSessionId || !sceneAccessSku) {
      return {
        ...base,
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "feature",
        payment_token: paidRow.token,
        feature_key: action.feature_key,
        reason: "scene_access_invoice_invalid",
      };
    }

    const activatedCount = await runRepositoryOperation(
      "payment.sceneAccess.activateSceneAccess",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "feature",
        sku: sceneAccessSku,
        invoice_status: paidRow.status,
      },
      () => repository.activateSceneAccess({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        scene_session_id: sceneSessionId,
        scene_access_sku: sceneAccessSku,
      }),
    );
    const failureReason = activatedCount > 0
      ? null
      : await resolveSceneAccessActivationFailure(repository, 
        paidRow.chat_id,
        sceneSessionId,
      );

    const receipt:MediaCommerceDecisionResponse = {
      ...base,
      operation: activatedCount > 0 ? "scene_access_activated" : "noop",
      text: activatedCount > 0
        ? getMediaUxCopy().callbacks.scene_access_activated
        : undefined,
      chat_id:
        normalizePositiveInteger(payload.chat_id)
        ?? paidRow.chat_id,
      scene_session_id: sceneSessionId,
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(paidRow.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
      target_message_id:
        normalizePositiveInteger(payload.target_message_id)
        ?? normalizePositiveInteger(paidRow.telegram_invoice_message_id)
        ?? null,
      payment_kind: "feature",
      payment_token: paidRow.token,
      feature_key: action.feature_key,
      stored_count: activatedCount,
      reason:
        activatedCount > 0
          ? "scene_access_activated"
          : failureReason,
    };
    const origin=parseJsonObject(payload.commerce_origin);
    if(activatedCount && origin && (origin.surface==='photo'||origin.surface==='daily_photos') && receipt.target_message_id){
      const photo={...receipt,media_signature:typeof origin.media_signature==='string'?origin.media_signature:null,
        current_uuid:typeof origin.source_photo==='string'?origin.source_photo:null};
      const ctx=config.MEDIA_VIDEO_ENABLED && origin.surface==='photo'?await loadVideoContext(photo):null;
      const root:CommerceUi['return_context']={message_id:receipt.target_message_id,kind:'photo',text:typeof origin.root_text==='string'?origin.root_text:null,
        entities:parseJsonArray(origin.root_entities)??[],reply_markup:origin.root_markup};
      await allowRootButtons(root,[],photo);
      return commerceRoot(photo,origin.surface,ctx,root);
    }
    return receipt;
  }

export async function resolveSceneAccessActivationFailure(repository: MediaRepository, chatId: number,
    sceneSessionId: string,
  ): Promise<"already_active" | "scene_not_active" | "invoice_invalid"> {
    const sceneStatus = await runRepositoryOperation(
      "payment.sceneAccess.loadSceneAccessStatus",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: "payment_action_2",
        invoice_status: "paid",
      },
      () => repository.loadSceneAccessStatus({
        chat_id: chatId,
        scene_session_id: sceneSessionId,
      }),
    );
    if (sceneStatus?.scene_is_active !== true) {
      return "scene_not_active";
    }
    if (sceneStatus.scene_access_active) {
      return "already_active";
    }
    return "invoice_invalid";
  }

export async function fulfillPhotoPayment(repository: MediaRepository, applyMediaActionDecision: (base: MediaCommerceDecisionResponse, context: MediaContext) => Promise<MediaCommerceDecisionResponse>, base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    const requestedAction =
      normalizeString(
        typeof payload.requested_action === "string"
          ? payload.requested_action
          : null,
      ) ?? "photo_request";
    const photoSku =
      normalizeString(typeof payload.photo_sku === "string" ? payload.photo_sku : null)
      ?? normalizeString(paidRow.sku);

    const mediaContextInput = {
      chat_id:
        normalizePositiveInteger(payload.chat_id)
        ?? paidRow.chat_id,
      scene_session_id: normalizeString(
        typeof payload.scene_session_id === "string"
          ? payload.scene_session_id
          : paidRow.scene_session_id,
      ),
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(paidRow.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
      media_signature: normalizeString(
        typeof payload.media_signature === "string"
          ? payload.media_signature
          : null,
      ),
      current_uuid: normalizeLowerString(
        typeof payload.current_uuid === "string" ? payload.current_uuid : null,
      ),
      target_message_id:
        normalizePositiveInteger(payload.target_message_id)
        ?? normalizePositiveInteger(paidRow.telegram_invoice_message_id),
      base_price_xtr:
        normalizePositiveInteger(payload.base_price_xtr)
        ?? normalizePositiveInteger(paidRow.amount_xtr)
        ?? 10,
      action_kind: requestedAction,
      requested_action: requestedAction,
      invoice_token: paidRow.token,
      force_deliver_after_payment: true,
      paid_access_mode: "paid" as const,
      callback_valid: true,
      panel_text: normalizeString(
        typeof payload.panel_text === "string" ? payload.panel_text : null,
      ),
      panel_entities_json:
        parseJsonArray(payload.panel_entities_json) ?? [],
    };
    const loadedContext = await runRepositoryOperation(
      "payment.photo.loadMediaContext",
      {
        chat_id: mediaContextInput.chat_id,
        payment_kind: "photo",
        sku: normalizeString(paidRow.sku),
        invoice_status: paidRow.status,
      },
      () => repository.loadMediaContext(mediaContextInput),
    );
    const context = {
      ...loadedContext,
      photo_sku: photoSku,
    };

    const response = await applyMediaActionDecision(
      {
        ...base,
        callback_valid: true,
        chat_id: context.chat_id,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        photo_sku: normalizeString(context.photo_sku),
        target_message_id: context.target_message_id,
        current_uuid: context.current_uuid,
        base_price_xtr: context.base_price_xtr,
        panel_text: context.panel_text,
        panel_entities_json: parseJsonArray(context.panel_entities_json),
        payment_kind: "photo",
        payment_token: paidRow.token,
      },
      context,
    );

    return {
      ...response,
      payment_kind: "photo",
      payment_token: paidRow.token,
    };
  }

export async function fulfillVideoPayment(repository: MediaRepository, videos: VideoCommerceRepository, base: MediaCommerceDecisionResponse, paid: PaidInvoiceToken, payload: Record<string,unknown>, feature: string): Promise<MediaCommerceDecisionResponse> {
    if (feature === 'video_pass' && !await videos.activateVideoPass(paid.token,paid.chat_id)) {
      return {...base,operation:'video_payment_review_required',payment_token:paid.token,reason:'paid_scene_requires_review',
        text:renderUx(getMediaUxCopy().video?.duplicate_payment_review)};
    }
    const videoId = typeof payload.video_id === 'string' ? payload.video_id : null;
    const panelId = normalizePositiveInteger(payload.photo_message_id);
    const frozen = {...base,chat_id:paid.chat_id,scene_session_id:paid.scene_session_id,target_message_id:panelId,
      telegram_chat_id:normalizePositiveInteger(payload.telegram_chat_id),payment_token:paid.token,feature_key:feature};
    if (!videoId || !panelId) {
      const target=normalizePositiveInteger(payload.target_message_id);
      const menu = payload.pass_menu === true;
      const context=feature==='video_pass' && target && !menu ? await videos.context({chat_id:paid.chat_id,scene_session_id:paid.scene_session_id,panel_message_id:target}) : null;
      const originalMenu = menu ? parseJsonObject(payload.base_reply_markup) : null;
      const originalRows = Array.isArray(originalMenu?.inline_keyboard) ? originalMenu.inline_keyboard.flat() : [];
      const menuTokens = originalRows.map(button=>parseJsonObject(button)?.callback_data)
        .filter((token):token is string=>typeof token==='string');
      const controls=await Promise.all((menu ? menuTokens : context?.video_control_tokens ?? []).map(async token=>{
        const row=await repository.loadCallbackToken(token,paid.chat_id);
        return row?.action_kind === 'video_pass_options' || (menu && row?.action_kind === 'free_scene_unlock') ? token : null;
      }));
      return {...frozen,operation:feature === 'video_pass' ? 'video_pass_activated' : 'noop',target_message_id:target,
        current_reply_markup:originalMenu ?? context?.current_reply_markup,reply_markup:originalMenu ?? context?.current_reply_markup,
        video_control_tokens:controls.filter((token):token is string=>token!==null),video_payment_urls:videoPaymentCleanupUrls(context?.video_payment_urls,paid.token,context?.current_reply_markup),
        ...(menu ? {video:{available:false,consumed:true,pass_menu:true}} : {}),
        text:context?.scene_active === false ? renderUx(getMediaUxCopy().video?.pass_scene_changed)
          : renderUx(getMediaUxCopy().video?.pass_activated),reason:feature === 'video_pass' ? 'video_pass_activated' : 'video_snapshot_invalid'};
    }
    return deliveryResponse(frozen,await videos.prepareDelivery({request_key:`paid:${paid.token}`,
      chat_id:paid.chat_id,scene_session_id:paid.scene_session_id,video_id:videoId,photo_message_id:panelId,
      telegram_chat_id:frozen.telegram_chat_id,source:'telegram',payment_token:paid.token}));
  }
