import { createHash } from "node:crypto";
import {
  buildAssignment,
  chooseVariant,
  findActiveExperiment,
  parseAbTestAssignment,
  toAbTestContext,
  type AbTestContext,
  type AbTestSelection,
  type SubscriptionOfferExperimentParams,
} from "./abTesting.js";
import { config } from "./config.js";
import {
  buildCallbackTokenRow,
  buildMediaAction,
  buildPhotoInvoiceInput,
  calculateMediaPriceRequired,
} from "./mediaCommerce/mediaAction.js";
import {
  INVOICE_PAYLOAD_KIND,
  hasExpectedPaymentDetails,
  normalizeFeatureKey,
  normalizeFeatureKeyValue,
  normalizePaymentActionKind,
  normalizePaymentSource,
  type ResolvedInvoiceAction,
  resolveInvoiceActionResult,
  toPaidInvoiceToken,
  validatePrecheckout,
} from "./mediaCommerce/paymentFlow.js";
import {
  buildBaseResponse,
} from "./mediaCommerce/responseBuilders.js";
import {
  buildFeaturePaymentInputs,
  buildSceneUnlockPaymentInputs,
  buildSubscriptionPaymentInputs,
} from "./mediaCommerce/subscriptionFlow.js";
import {
  resolveSubscriptionPlans,
  resolveActionPlanByFeatureKey,
  resolvePhotoPlanBySku,
} from "./mediaCommerce/plans.js";
import {
  INVOICE_TTL_MS,
  buildTelegramInvoicePayload,
  extractPanelFromRawUpdate,
  isExpired,
  normalizeBoolean,
  normalizeLowerString,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeString,
  parseJsonArray,
  parseJsonObject,
} from "./mediaCommerce/utils.js";
import { MediaCommerceRepository } from "./mediaCommerceRepository.js";
import {
  parseStrictJsonObject,
  type UpsertInvoiceTokenInput,
} from "./mediaCommerceRepository/shared.js";
import { MediaRepositoryContractError } from "./mediaCommerceRepository/errors.js";
import type { MediaCommerceDecisionRequest } from "./mediaCommerce/requestSchema.js";
import { getRequestContext } from "./requestContext.js";
import { formatFreeBalances } from "./freeBalanceFormatter.js";
import {
  TelegramStarsInvoiceError,
  TelegramStarsPaymentAdapter,
  type StarsInvoiceClient,
} from "./payments/stars.js";
import {
  SbpPaymentAdapter,
  SbpPaymentError,
  type SbpPaymentClient,
  type SbpTransactionStatus,
} from "./payments/sbp.js";
import type {
  MediaCommerceDecisionResponse,
  MediaCommerceRoute,
  InteractionTokenRow,
  MediaContext,
  MediaOfferItem,
  MediaPaymentOption,
  MediaSubscriptionOfferReason,
  MediaOfferStats,
  PaymentUiCopy,
  PaymentCurrency,
  PaymentSource,
  PaidInvoiceToken,
  StoredInvoiceToken,
  LoadedInvoiceToken,
  TelegramMessageKind,
} from "./mediaCommerceTypes.js";

type MediaRepository = Pick<
  MediaCommerceRepository,
  | "loadOfferStats"
  | "upsertCallbackTokens"
  | "upsertInvoiceToken"
  | "upsertInvoiceTokens"
  | "loadCallbackToken"
  | "loadMediaContext"
  | "loadPhotoByUuid"
  | "storePanel"
  | "loadInvoiceToken"
  | "loadInvoiceTokenByExternalPaymentId"
  | "storePrecheckoutResult"
  | "markInvoicePaid"
  | "activateSubscription"
  | "activateSceneAccess"
  | "loadSceneAccessStatus"
  | "loadFreeCredits"
  | "redeemFreeFastSceneSkip"
  | "redeemFreeSceneUnlock"
  | "redeemFreePhotoUnlock"
  | "storePhotoEvent"
  | "finalizeFreePhotoUnlock"
  | "storeInvoiceLinks"
  | "claimSbpCheckoutCreation"
  | "releaseSbpCheckoutCreation"
  | "markSbpCheckoutCreationUncertain"
  | "markSbpInvoiceCanceled"
  | "markSbpInvoiceExpired"
  | "recordSbpStatusConflict"
  | "recordSbpProviderEvent"
  | "loadStoredInvoiceTokens"
  | "loadActiveSubscriptionOfferId"
  | "loadAbTestAssignment"
  | "storeAbTestAssignment"
  | "recordAbTestDelivered"
  | "storeSubscriptionOfferMessageId"
  | "clearActiveSubscriptionOffer"
>;

type SubscriptionPaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "subscription" }
>;

type FeaturePaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "feature" }
>;

type PaymentUiActionKind =
  | "reveal_feature_payment_options"
  | "subscription_payment_source_toggle";

function normalizePaymentCurrency(
  value: string | null | undefined,
): PaymentCurrency | null {
  return value === "RUB" ? "RUB" : value === "XTR" ? "XTR" : null;
}

function normalizePaymentKindFromActionKind(
  value: string | null | undefined,
): "subscription" | "photo" | "feature" | null {
  const actionKind = normalizePaymentActionKind(value);
  if (actionKind === "subscription_payment") return "subscription";
  if (actionKind === "photo_payment") return "photo";
  if (actionKind === "feature_payment") return "feature";
  return null;
}

function getSourceSortOrder(source: PaymentSource | null | undefined): number {
  return source === "sbp" ? 0 : source === "stars" ? 1 : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const SBP_CHECKOUT_WAIT_TIMEOUT_MS = 24_000;
const SBP_CHECKOUT_WAIT_BACKOFF_MS = [200, 400, 800, 1000, 1500, 2000] as const;
const FREE_CALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildSbpGatewayCheckoutUrl(token: string): string {
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

function replaceCount(template: string, count: number): string {
  return template.replaceAll("{count}", String(count));
}

function buildStableCallbackToken(parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `btn_${hash}`;
}

const RETRYABLE_SBP_FAILURE_REASONS = new Set(["sbp_canceled", "sbp_expired"]);
const MAX_SBP_SUCCESSOR_DEPTH = 8;

function buildSbpRetryToken(predecessorToken: string): string {
  const hash = createHash("sha256")
    .update(["sbp_retry", predecessorToken].join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `pay_retry_${hash}:sbp`;
}

function isRetryableSbpCancellation(row: StoredInvoiceToken | LoadedInvoiceToken): boolean {
  return normalizePaymentSource(row.payment_source) === "sbp"
    && normalizeString(row.status) === "canceled"
    && RETRYABLE_SBP_FAILURE_REASONS.has(normalizeString(row.failure_reason) ?? "");
}

function isExpiredSbpInvoiceSent(row: StoredInvoiceToken): boolean {
  return normalizePaymentSource(row.payment_source) === "sbp"
    && normalizeString(row.status) === "invoice_sent"
    && isExpired(row.expires_at);
}

function buildSbpSuccessorInput(row: StoredInvoiceToken): UpsertInvoiceTokenInput {
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

function buildFreeActionTokenRow(input: {
  action_kind: "free_fast_scene_skip" | "free_scene_unlock" | "free_photo_unlock";
  chat_id: number;
  scene_session_id: string;
  turn_no: number | null;
  scene_turn_no: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  media_signature?: string | null;
  target_message_id?: number | null;
  current_uuid?: string | null;
  base_price_xtr?: number | null;
  photo_sku?: string | null;
  feature_key: "fast_scene_skip" | "scene_unlock" | "photo_unlock";
  action_button_text: string;
  requested_action?: string | null;
  panel_text?: string | null;
  panel_entities_json?: unknown[] | null;
  ab_test?: AbTestContext | null;
}): InteractionTokenRow {
  const normalizedPhotoSku = input.feature_key === "photo_unlock"
    ? normalizeString(input.photo_sku)
    : null;
  const token = buildStableCallbackToken([
    input.action_kind,
    input.chat_id,
    input.scene_session_id,
    input.turn_no,
    input.scene_turn_no,
    input.target_message_id,
    input.feature_key,
    normalizedPhotoSku,
  ]);

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json: {
      action_kind: input.action_kind,
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      character_i: input.character_i ?? null,
      scene_mode: input.scene_mode ?? null,
      media_signature: input.media_signature ?? null,
      target_message_id: input.target_message_id ?? null,
      current_uuid: input.current_uuid ?? null,
      base_price_xtr: input.base_price_xtr ?? 0,
      ...(input.feature_key === "photo_unlock"
        ? { photo_sku: normalizedPhotoSku }
        : {}),
      feature_key: input.feature_key,
      requested_action:
        input.requested_action
        ?? (input.feature_key === "fast_scene_skip"
          ? "fast_scene_skip_free"
          : input.feature_key === "scene_unlock"
            ? "scene_unlock_free"
            : "photo_request"),
      action_button_text: input.action_button_text,
      panel_text: input.panel_text ?? null,
      panel_entities_json: input.panel_entities_json ?? [],
      ab_test: input.ab_test ?? null,
    },
    status: "active",
    action_kind: input.action_kind,
    expires_at: new Date(Date.now() + FREE_CALLBACK_TTL_MS).toISOString(),
  };
}

function buildPaymentUiCopy(): PaymentUiCopy {
  return { ...config.TELEGRAM_UX_COPY_JSON.payment_ui };
}

function getFeaturePaymentHint(featureKey: string | null | undefined): string | null {
  if (featureKey === "fast_scene_skip") {
    return config.TELEGRAM_UX_COPY_JSON.payment_ui.fast_scene_skip_hint;
  }

  if (featureKey === "scene_unlock") {
    return config.TELEGRAM_UX_COPY_JSON.payment_ui.scene_unlock_hint;
  }

  return null;
}

function buildPaymentSourceToggleTokenMap(
  tokenRows: InteractionTokenRow[],
): Partial<Record<PaymentSource, string>> {
  return tokenRows.reduce<Partial<Record<PaymentSource, string>>>((acc, row) => {
    const payload = parseJsonObject(row.payload_json) ?? {};
    const source = normalizePaymentSource(
      typeof payload.selected_payment_source === "string"
        ? payload.selected_payment_source
        : null,
    );
    if (source) {
      acc[source] = row.token;
    }
    return acc;
  }, {});
}

function normalizeInvoiceTokens(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => normalizeString(item)).filter(
      (item): item is string => item != null,
    )))
    : [];
}

function extractLegacyPaymentOptionTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeInvoiceTokens(value.map((item) =>
    item != null && typeof item === "object" && !Array.isArray(item)
      ? (item as { token?: unknown }).token
      : null,
  ));
}

function extractLegacySubscriptionInvoiceTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens: unknown[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const paymentOptions = (item as { payment_options?: unknown }).payment_options;
    if (!Array.isArray(paymentOptions)) continue;
    for (const option of paymentOptions) {
      if (option != null && typeof option === "object" && !Array.isArray(option)) {
        tokens.push((option as { token?: unknown }).token);
      }
    }
  }
  return normalizeInvoiceTokens(tokens);
}

function buildPaymentUiTokenRow(input: {
  action_kind: PaymentUiActionKind;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  target_message_id?: number | null;
  feature_key?: "fast_scene_skip" | "scene_unlock" | string | null;
  invoice_tokens?: string[];
  selected_payment_source?: PaymentSource | null;
  payment_source_toggle_tokens?: Partial<Record<PaymentSource, string>> | null;
  offer_id?: string | null;
  idempotency_key?: string | null;
}): InteractionTokenRow {
  const token = buildStableCallbackToken([
    input.action_kind,
    input.chat_id,
    input.scene_session_id,
    input.turn_no,
    input.scene_turn_no,
    input.target_message_id,
    input.feature_key,
    input.selected_payment_source,
    input.idempotency_key,
  ]);

  const payload_json = input.action_kind === "subscription_payment_source_toggle"
    ? {
        action_kind: input.action_kind,
        chat_id: input.chat_id,
        offer_id: input.offer_id ?? null,
        selected_payment_source: input.selected_payment_source ?? null,
        invoice_tokens: input.invoice_tokens ?? [],
        payment_source_toggle_tokens: input.payment_source_toggle_tokens ?? null,
      }
    : {
        action_kind: input.action_kind,
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        target_message_id: input.target_message_id ?? null,
        feature_key: input.feature_key ?? null,
        invoice_tokens: input.invoice_tokens ?? [],
      };

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json,
    status: "active",
    action_kind: input.action_kind,
    expires_at:
      input.action_kind === "subscription_payment_source_toggle"
      || (input.action_kind === "reveal_feature_payment_options" && input.scene_session_id)
        ? null
        : new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
  };
}

function buildAbTokenSuffix(selection: AbTestSelection | null): string | null {
  if (!selection) {
    return null;
  }

  return createHash("sha256")
    .update([
      selection.assignment_key,
      selection.config.version,
      selection.assignment.variant,
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
}

function applySubscriptionPlanOverrides<T extends {
  sku: string;
  amount_xtr: number;
  amount_rub?: number | null;
  days?: number;
  title: string;
  description: string;
  label: string;
  button_text: string;
}>(
  plans: T[],
  params: SubscriptionOfferExperimentParams,
): T[] {
  const overrides = new Map(
    (params.plans ?? []).map((override) => [override.sku, override]),
  );

  return plans.flatMap((plan) => {
    const override = overrides.get(plan.sku);
    if (override?.enabled === false) {
      return [];
    }

    return [{
      ...plan,
      days: override?.days ?? plan.days,
      amount_xtr: override?.amount_xtr ?? plan.amount_xtr,
      amount_rub:
        "amount_rub" in (override ?? {})
          ? override?.amount_rub ?? null
          : plan.amount_rub ?? null,
      title: override?.title ?? plan.title,
      description: override?.description ?? plan.description,
      label: override?.label ?? plan.label,
      button_text: override?.button_text ?? plan.button_text,
    } as T];
  });
}

function applySceneUnlockOverride<T extends {
  amount_xtr: number;
  amount_rub?: number | null;
  title: string;
  description: string;
  label: string;
  button_text: string;
}>(
  plan: T | null,
  params: SubscriptionOfferExperimentParams,
): T | null {
  if (!plan || params.scene_unlock?.enabled === false) {
    return null;
  }

  const override = params.scene_unlock;
  return {
    ...plan,
    amount_xtr: override?.amount_xtr ?? plan.amount_xtr,
    amount_rub:
      override && "amount_rub" in override
        ? override.amount_rub ?? null
        : plan.amount_rub ?? null,
    title: override?.title ?? plan.title,
    description: override?.description ?? plan.description,
    label: override?.label ?? plan.label,
    button_text: override?.button_text ?? plan.button_text,
  };
}

function resolveSubscriptionOfferText(
  params: SubscriptionOfferExperimentParams,
  reason: MediaSubscriptionOfferReason | null,
): string | null {
  if (reason === "daily_turn_limit") {
    return params.daily_limit_offer_text ?? params.text ?? null;
  }

  if (reason === "subscription_command") {
    return params.command_offer_text ?? params.text ?? null;
  }

  return params.text ?? null;
}

export class MediaCommerceOperationError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly code: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaCommerceOperationError";
  }
}

function extractErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error != null
    && "code" in error
    && typeof error.code === "string"
    && error.code.trim().length > 0
  ) {
    return error.code.trim();
  }

  return null;
}

function toOperationError(operation: string, error: unknown): MediaCommerceOperationError {
  if (error instanceof MediaCommerceOperationError) {
    return error;
  }

  return new MediaCommerceOperationError(
    "MediaCommerce operation failed",
    operation,
    extractErrorCode(error),
    { cause: error instanceof Error ? error : undefined },
  );
}

function toSafeTelegramStarsDetails(details: unknown): Record<string, unknown> | null {
  if (typeof details !== "object" || details == null || Array.isArray(details)) {
    return null;
  }

  const source = details as Record<string, unknown>;
  const safeDetails: Record<string, unknown> = {};
  if (typeof source.ok === "boolean") safeDetails.ok = source.ok;
  if (typeof source.error_code === "number" && Number.isInteger(source.error_code)) {
    safeDetails.error_code = source.error_code;
  }
  if (typeof source.description === "string" && source.description.trim().length > 0) {
    safeDetails.description = source.description.trim();
  }

  return Object.keys(safeDetails).length > 0 ? safeDetails : null;
}

function getSbpPaymentError(error: unknown): SbpPaymentError | null {
  if (error instanceof SbpPaymentError) return error;
  if (
    error instanceof MediaCommerceOperationError
    && error.cause instanceof SbpPaymentError
  ) {
    return error.cause;
  }
  return null;
}

function getSbpCheckoutEligibilityError(row: StoredInvoiceToken): string | null {
  if (normalizeString(row.kind) !== INVOICE_PAYLOAD_KIND) return "sbp_invoice_kind_invalid";
  if (normalizePaymentSource(row.payment_source) !== "sbp") return "sbp_payment_source_invalid";
  if (normalizeString(row.status) !== "invoice_sent") return "sbp_invoice_status_invalid";
  if (!normalizePaymentActionKind(row.action_kind)) return "sbp_invoice_action_invalid";

  if (isExpired(row.expires_at)) {
    return "sbp_invoice_expired";
  }
  return null;
}

export function buildPaymentOption(row: StoredInvoiceToken): MediaPaymentOption {
  const paymentSource = normalizePaymentSource(row.payment_source);
  if (!paymentSource) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "payment_source",
      reason: "invalid",
    });
  }

  const paymentCurrency = normalizePaymentCurrency(row.currency);
  if (!paymentCurrency) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "currency",
      reason: "invalid",
    });
  }

  const amount = normalizePositiveInteger(row.amount);
  if (amount == null) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "amount",
      reason: "invalid",
    });
  }

  const checkoutUrl = paymentSource === "stars"
    ? normalizeString(row.checkout_url) ?? normalizeString(row.invoice_link)
    : normalizeString(row.checkout_url);
  if (!checkoutUrl) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: paymentSource === "stars" ? "checkout_url/invoice_link" : "checkout_url",
      reason: "missing",
    });
  }

  const payload = parseStrictJsonObject(row.payload_json, "buildPaymentOption");

  return {
    token: row.token,
    source: paymentSource,
    amount,
    currency: paymentCurrency,
    checkout_url: checkoutUrl,
    external_payment_id: normalizeString(row.external_payment_id),
    sku: row.sku,
    action_kind:
      typeof payload.action_kind === "string"
        ? payload.action_kind
        : row.action_kind ?? null,
    payment_kind:
      payload.action_kind === "subscription_payment"
        ? "subscription" as const
        : payload.action_kind === "feature_payment"
          ? "feature" as const
          : payload.action_kind === "photo_payment"
            ? "photo" as const
          : null,
    feature_key:
      typeof payload.feature_key === "string"
        ? payload.feature_key
        : null,
    scene_session_id: row.scene_session_id,
    sort_order: normalizeNonNegativeInteger(payload.sort_order) ?? 100,
    subscription_days:
      normalizePositiveInteger(payload.subscription_days) ?? null,
    original_amount:
      paymentSource === "sbp"
        ? normalizePositiveInteger(payload.original_amount_rub)
        : normalizePositiveInteger(payload.original_amount_xtr),
    promo_key:
      normalizeString(
        typeof payload.promo_key === "string"
          ? payload.promo_key
          : null,
      ) ?? null,
    title: row.invoice_title,
    description: row.invoice_description,
    label: row.invoice_label,
    button_text: row.invoice_button_text,
  };
}

function buildOfferItem(rows: StoredInvoiceToken[]): MediaOfferItem | null {
  if (rows.length === 0) {
    return null;
  }

  const sortedRows = rows
    .slice()
    .sort((left, right) =>
      getSourceSortOrder(normalizePaymentSource(left.payment_source))
      - getSourceSortOrder(normalizePaymentSource(right.payment_source))
      || (normalizeNonNegativeInteger(left.payload_json.sort_order) ?? 100)
      - (normalizeNonNegativeInteger(right.payload_json.sort_order) ?? 100),
    );
  const primaryRow = sortedRows[0] ?? rows[0];
  if (!primaryRow) {
    return null;
  }
  const payload = parseStrictJsonObject(primaryRow.payload_json, "buildOfferItem");

  return {
    sku: primaryRow.sku,
    action_kind:
      typeof payload.action_kind === "string"
        ? payload.action_kind
        : primaryRow.action_kind ?? null,
    payment_kind:
      payload.action_kind === "subscription_payment"
        ? "subscription"
        : payload.action_kind === "feature_payment"
          ? "feature"
          : payload.action_kind === "photo_payment"
            ? "photo"
            : null,
    feature_key:
      typeof payload.feature_key === "string"
        ? payload.feature_key
        : null,
    scene_session_id: primaryRow.scene_session_id,
    sort_order: normalizeNonNegativeInteger(payload.sort_order) ?? 100,
    subscription_days:
      normalizePositiveInteger(payload.subscription_days) ?? null,
    promo_key:
      normalizeString(
        typeof payload.promo_key === "string"
          ? payload.promo_key
          : null,
      ) ?? null,
    title: primaryRow.invoice_title,
    description: primaryRow.invoice_description,
    label: primaryRow.invoice_label,
    payment_options: sortedRows.map((row) => buildPaymentOption(row)),
  };
}

function buildOfferGroupKey(row: StoredInvoiceToken): string {
  const payload = parseStrictJsonObject(row.payload_json, "buildOfferGroupKey");

  return JSON.stringify([
    normalizeString(row.action_kind) ?? null,
    normalizeString(row.sku) ?? null,
    normalizeString(row.scene_session_id) ?? null,
    normalizeString(
      typeof payload.feature_key === "string" ? payload.feature_key : null,
    ) ?? null,
    normalizePositiveInteger(payload.subscription_days) ?? null,
    normalizeNonNegativeInteger(payload.sort_order) ?? 100,
  ]);
}

function getInvoicePurchaseId(row: StoredInvoiceToken | LoadedInvoiceToken): string | null {
  const payload = parseJsonObject(row.payload_json) ?? {};
  return normalizeString(
    typeof payload.idempotency_key === "string" ? payload.idempotency_key : null,
  );
}

function getInvoiceFeatureKey(row: StoredInvoiceToken | LoadedInvoiceToken): string | null {
  const payload = parseJsonObject(row.payload_json) ?? {};
  return normalizeFeatureKeyValue(
    typeof payload.feature_key === "string" ? payload.feature_key : null,
  );
}

function buildPurchaseGroupKey(row: StoredInvoiceToken): string | null {
  const purchaseId = getInvoicePurchaseId(row);
  const sku = normalizeString(row.sku);
  if (!purchaseId || !sku) return null;
  return `${purchaseId}\u001f${sku}`;
}

function isRenderableStoredInvoiceRow(row: StoredInvoiceToken): boolean {
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

function getTelegramStarsInvoiceError(error: unknown): TelegramStarsInvoiceError | null {
  if (error instanceof TelegramStarsInvoiceError) return error;
  if (error instanceof Error && error.cause instanceof TelegramStarsInvoiceError) {
    return error.cause;
  }
  return null;
}

function isTransientStarsInvoiceError(error: unknown): boolean {
  const starsError = getTelegramStarsInvoiceError(error);
  return starsError != null
    && (
      starsError.stage === "request"
      || starsError.statusCode === 429
      || (starsError.statusCode != null && starsError.statusCode >= 500)
    );
}

function buildSbpGatewayRow(row: StoredInvoiceToken): StoredInvoiceToken {
  return {
    ...row,
    checkout_url: buildSbpGatewayCheckoutUrl(row.token),
    external_payment_id: null,
  };
}

function normalizePositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function groupOfferItems(rows: StoredInvoiceToken[]): MediaOfferItem[] {
  const grouped = new Map<string, StoredInvoiceToken[]>();

  for (const row of rows) {
    const key = buildOfferGroupKey(row);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  return Array.from(grouped.values())
    .map((rows) => buildOfferItem(rows))
    .filter((item): item is MediaOfferItem => item != null)
    .sort(
      (left, right) =>
        (normalizeNonNegativeInteger(left.sort_order) ?? 100)
        - (normalizeNonNegativeInteger(right.sort_order) ?? 100)
        || (normalizePositiveInteger(left.subscription_days) ?? 0)
        - (normalizePositiveInteger(right.subscription_days) ?? 0),
    );
}

function selectLegacyPrimaryRow(rows: StoredInvoiceToken[]): StoredInvoiceToken | null {
  if (rows.length === 0) {
    return null;
  }

  const starsRow = rows.find(
    (row) => normalizePaymentSource(row.payment_source) === "stars",
  );
  return starsRow ?? rows[0] ?? null;
}

function buildTopLevelPaymentFields(
  rows: StoredInvoiceToken[],
): Pick<
  MediaCommerceDecisionResponse,
  | "payment_source"
  | "payment_amount"
  | "payment_currency"
  | "checkout_url"
  | "external_payment_id"
  | "invoice_token"
  | "invoice_link"
  | "payment_options"
> {
  const primary = selectLegacyPrimaryRow(rows);

  return {
    payment_source: primary ? normalizePaymentSource(primary.payment_source) : null,
    payment_amount:
      primary != null
        ? normalizeNonNegativeInteger(primary.amount ?? primary.amount_xtr)
        : null,
    payment_currency: primary?.currency ?? null,
    checkout_url:
      primary != null
        ? normalizeString(primary.checkout_url) ?? normalizeString(primary.invoice_link)
        : null,
    external_payment_id:
      primary != null ? normalizeString(primary.external_payment_id) : null,
    invoice_token: primary?.token ?? null,
    invoice_link:
      primary != null && normalizePaymentSource(primary.payment_source) === "stars"
        ? normalizeString(primary.checkout_url) ?? normalizeString(primary.invoice_link)
        : null,
    payment_options: rows.map((row) => buildPaymentOption(row)).sort(
      (left, right) =>
        getSourceSortOrder(left.source) - getSourceSortOrder(right.source),
    ),
  };
}

type OperationLogContext = {
  chat_id?: number | null;
  payment_kind?: string | null;
  sku?: string | null;
  invoice_status?: string | null;
  input_is_array?: boolean;
  input_length?: number | null;
};

function classifyRoute(input: MediaCommerceDecisionRequest): MediaCommerceRoute {
  const mode = normalizeString(input.interaction_mode);
  const eventType = normalizeString(input.event_type);

  if (mode === "prepare_offer") return "prepare_offer";
  if (mode === "finalize_offer") return "finalize_offer";
  if (mode === "feature_offer") return "feature_offer";
  if (mode === "subscription_offer") return "subscription_offer";
  if (mode === "finalize_photo_event") return "finalize_photo_event";
  if (mode === "finalize_subscription_offer") return "finalize_subscription_offer";
  if (eventType === "callback_query.received") return "callback";
  if (eventType === "payment.pre_checkout.received") return "pre_checkout";
  if (
    eventType === "payment.success.received"
    || eventType === "payment.confirmed.received"
    || eventType === "payment.canceled.received"
    || eventType === "payment.chargebacked.received"
  ) {
    return "payment_success";
  }
  return "noop";
}

export class MediaCommerceDecisionService {
  private readonly uncertainSbpCheckouts = new Map<
    string,
    { external_payment_id: string | null; checkout_url: string | null }
  >();

  constructor(
    private readonly repository: MediaRepository,
    private readonly starsClient: StarsInvoiceClient = new TelegramStarsPaymentAdapter(),
    private readonly sbpClient: SbpPaymentClient | null = config.SBP_ENABLED
      ? new SbpPaymentAdapter()
      : null,
  ) {}

  private async runOperation<T>(
    operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    const requestId = getRequestContext()?.requestId ?? null;
    const startedAt = Date.now();

    try {
      return await execute();
    } catch (error) {
      const operationError = toOperationError(operation, error);
      const starsError = error instanceof TelegramStarsInvoiceError ? error : null;
      console.error(`[media_commerce] ${operation}`, {
        request_id: requestId,
        operation,
        status: "error",
        duration_ms: Date.now() - startedAt,
        ...context,
        code: operationError.code,
        message: error instanceof Error ? error.message : "Unknown error",
        ...(starsError
          ? {
              stage: starsError.stage,
              statusCode: starsError.statusCode,
              description: starsError.description,
              details: toSafeTelegramStarsDetails(starsError.details),
            }
          : {}),
      });
      throw operationError;
    }
  }

  private async runRepositoryOperation<T>(
    operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.runOperation(operation, context, execute);
  }

  private async upsertCurrentPaymentAttempts(
    inputs: UpsertInvoiceTokenInput[],
    operationPrefix: string,
  ): Promise<StoredInvoiceToken[]> {
    const rows = await this.runRepositoryOperation(
      `${operationPrefix}.upsertInvoiceTokens`,
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => this.repository.upsertInvoiceTokens(inputs),
    );
    const mergedRows = rows.slice();

    for (const row of rows) {
      if (!isRetryableSbpCancellation(row)) continue;
      const successor = await this.createSbpSuccessorAttempt(row, operationPrefix);
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

  private async canCreateSbpSuccessor(
    row: StoredInvoiceToken,
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
      const activeOfferId = await this.runRepositoryOperation(
        `${operationPrefix}.loadActiveSubscriptionOfferId`,
        {
          chat_id: row.chat_id,
          payment_kind: action.payment_kind,
          sku: normalizeString(row.sku),
          invoice_status: normalizeString(row.status),
        },
        () => this.repository.loadActiveSubscriptionOfferId(row.chat_id),
      );
      return activeOfferId === offerId;
    }

    const sceneSessionId = normalizeString(row.scene_session_id)
      ?? normalizeString(
        typeof payload.scene_session_id === "string" ? payload.scene_session_id : null,
      );
    if (!sceneSessionId) return true;

    const sceneStatus = await this.runRepositoryOperation(
      `${operationPrefix}.loadSceneAccessStatus`,
      {
        chat_id: row.chat_id,
        payment_kind: action.payment_kind,
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => this.repository.loadSceneAccessStatus({
        chat_id: row.chat_id,
        scene_session_id: sceneSessionId,
      }),
    );

    return sceneStatus?.scene_is_active === true
      && normalizeString(sceneStatus.active_scene_session_id) === sceneSessionId;
  }

  private async createSbpSuccessorAttempt(
    row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken | null> {
    if (!await this.canCreateSbpSuccessor(row, operationPrefix)) {
      return null;
    }

    const successorInput = buildSbpSuccessorInput(row);
    const [successor] = await this.runRepositoryOperation(
      `${operationPrefix}.upsertSbpSuccessor`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => this.repository.upsertInvoiceTokens([successorInput]),
    );

    return successor ?? null;
  }

  private async reloadSbpPredecessor(
    row: StoredInvoiceToken,
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

    const [reloaded] = await this.runRepositoryOperation(
      `${operationPrefix}.reloadSbpPredecessor`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => this.repository.loadStoredInvoiceTokens([token]),
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

  private async reconcileExpiredSbpInvoice(
    row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const externalPaymentId = normalizeString(row.external_payment_id);
    if (!externalPaymentId) {
      const updated = await this.runRepositoryOperation(
        `${operationPrefix}.markSbpInvoiceExpired`,
        {
          chat_id: row.chat_id,
          payment_kind: normalizeString(row.action_kind),
          sku: normalizeString(row.sku),
          invoice_status: normalizeString(row.status),
        },
        () => this.repository.markSbpInvoiceExpired(row.token, row.chat_id),
      );
      if (updated !== 1) {
        return this.reloadSbpPredecessor(row, operationPrefix);
      }
      return {
        ...row,
        status: "canceled",
        failure_reason: "sbp_expired",
      };
    }

    let providerStatus: SbpTransactionStatus | null = null;
    try {
      providerStatus = await this.sbpClient?.getTransactionStatus?.(externalPaymentId) ?? null;
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

    const updated = await this.runRepositoryOperation(
      `${operationPrefix}.markInvoiceCanceled`,
      {
        chat_id: row.chat_id,
        payment_kind: normalizeString(row.action_kind),
        sku: normalizeString(row.sku),
        invoice_status: normalizeString(row.status),
      },
      () => this.repository.markSbpInvoiceCanceled(externalPaymentId),
    );
    if (updated !== 1) {
      return this.reloadSbpPredecessor(row, operationPrefix);
    }
    return {
      ...row,
      status: "canceled",
      failure_reason: "sbp_canceled",
    };
  }

  private async resolveSbpSuccessorChain(
    row: StoredInvoiceToken,
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
        current = await this.reconcileExpiredSbpInvoice(current, operationPrefix);
      }

      if (!isRetryableSbpCancellation(current)) {
        return current;
      }

      const successorToken = buildSbpRetryToken(current.token);
      const [existing] = await this.runRepositoryOperation(
        `${operationPrefix}.loadSbpSuccessor`,
        {
          chat_id: current.chat_id,
          payment_kind: normalizeString(current.action_kind),
          sku: normalizeString(current.sku),
          invoice_status: normalizeString(current.status),
        },
        () => this.repository.loadStoredInvoiceTokens([successorToken]),
      );
      if (existing) {
        current = existing;
        continue;
      }

      const successor = await this.createSbpSuccessorAttempt(current, operationPrefix);
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

  private async persistSbpCheckoutCreationUncertain(
    token: string,
    chatId: number,
    operationPrefix: string,
    context: OperationLogContext,
  ): Promise<void> {
    const updated = await this.runRepositoryOperation(
      `${operationPrefix}.markCheckoutCreationUncertain`,
      context,
      () => this.repository.markSbpCheckoutCreationUncertain(token, chatId),
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

  private async ensureStarsInvoiceLink(
    row: StoredInvoiceToken,
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
    const created = await this.runOperation(
      `${operationPrefix}.createInvoiceLink`,
      context,
      () => this.starsClient.createStarsInvoice({
        title,
        description,
        payload,
        label,
        amount_xtr: amountXtr,
      }),
    );

    await this.runRepositoryOperation(
      `${operationPrefix}.storeInvoiceLink`,
      context,
      () => this.repository.storeInvoiceLinks([{
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

  private async ensureSbpCheckout(
    row: StoredInvoiceToken,
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

    if (!this.sbpClient) {
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

    const uncertain = this.uncertainSbpCheckouts.get(token);
    if (uncertain) {
      const reloaded = await this.repository.loadInvoiceToken(token, chatId);
      if (
        uncertain.external_payment_id != null
        && uncertain.checkout_url != null
        && normalizeString(reloaded?.status) === "invoice_sent"
        && !isExpired(reloaded?.expires_at)
        && normalizeString(reloaded?.external_payment_id) === uncertain.external_payment_id
        && normalizeString(reloaded?.checkout_url) === uncertain.checkout_url
      ) {
        this.uncertainSbpCheckouts.delete(token);
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
    let claim = await this.runRepositoryOperation(
      `${operationPrefix}.claimSbpCheckoutCreation`,
      claimContext,
      () => this.repository.claimSbpCheckoutCreation(token, chatId),
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

      claim = await this.runRepositoryOperation(
        `${operationPrefix}.claimSbpCheckoutCreation`,
        claimContext,
        () => this.repository.claimSbpCheckoutCreation(token, chatId),
      );
    }

    if (!await this.canCreateSbpSuccessor(row, operationPrefix)) {
      await this.runRepositoryOperation(
        `${operationPrefix}.releaseSbpCheckoutCreation`,
        claimContext,
        () => this.repository.releaseSbpCheckoutCreation(token, chatId),
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
      created = await this.runOperation(
        `${operationPrefix}.createPayment`,
        {
          chat_id: chatId,
          payment_kind: normalizeString(row.action_kind),
          sku,
          invoice_status: normalizeString(row.status),
        },
        () => this.sbpClient!.createPayment({
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
        await this.runRepositoryOperation(
          `${operationPrefix}.releaseSbpCheckoutCreation`,
          claimContext,
          () => this.repository.releaseSbpCheckoutCreation(token, chatId),
        );
      } else {
        this.uncertainSbpCheckouts.set(token, {
          external_payment_id: null,
          checkout_url: null,
        });
        await this.persistSbpCheckoutCreationUncertain(
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

    this.uncertainSbpCheckouts.set(token, created);
    let updatedCount: number;
    try {
      updatedCount = await this.runRepositoryOperation(
        `${operationPrefix}.storeCheckout`,
        claimContext,
        () => this.repository.storeInvoiceLinks([{
          token,
          chat_id: chatId,
          invoice_link: null,
          checkout_url: created.checkout_url,
          external_payment_id: created.external_payment_id,
          expires_at: created.provider_expires_at,
        }]),
      );
    } catch (error) {
      await this.persistSbpCheckoutCreationUncertain(
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
      await this.persistSbpCheckoutCreationUncertain(
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

    const saved = await this.runRepositoryOperation(
      `${operationPrefix}.reloadCheckout`,
      claimContext,
      () => this.repository.loadInvoiceToken(token, chatId),
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
    this.uncertainSbpCheckouts.delete(token);

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

  async resolveSbpCheckout(tokenInput: string): Promise<string> {
    const token = normalizeString(tokenInput);
    if (!token) {
      throw new MediaCommerceOperationError(
        "SBP invoice token is required",
        "sbpRedirect.loadInvoiceToken",
        "sbp_invoice_not_found",
      );
    }

    const rows = await this.runRepositoryOperation(
      "sbpRedirect.loadInvoiceToken",
      {
        chat_id: null,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadStoredInvoiceTokens([token]),
    );
    const row = rows.find((candidate) => candidate.token === token);

    if (!row) {
      throw new MediaCommerceOperationError(
        "SBP invoice token was not found",
        "sbpRedirect.loadInvoiceToken",
        "sbp_invoice_not_found",
      );
    }
    const resolvedRow = await this.resolveSbpSuccessorChain(row, "sbpRedirect");
    const eligibilityError = getSbpCheckoutEligibilityError(resolvedRow);
    if (eligibilityError) {
      throw new MediaCommerceOperationError(
        "Invoice token is not eligible for SBP checkout",
        "sbpRedirect.validateCheckoutEligibility",
        eligibilityError,
      );
    }

    const ready = await this.ensureSbpCheckout(resolvedRow, "sbpRedirect");
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

  private async prepareRenderablePaymentRows(
    rows: StoredInvoiceToken[],
    operationPrefix: string,
  ): Promise<StoredInvoiceToken[]> {
    const renderableRows = rows.filter(isRenderableStoredInvoiceRow);
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
        preparedRows.push(await this.ensureStarsInvoiceLink(row, operationPrefix));
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

  async evaluate(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const route = classifyRoute(input);

    switch (route) {
      case "prepare_offer":
        return this.evaluatePrepareOffer(input);
      case "finalize_offer":
        return this.evaluateFinalizeOffer(input);
      case "feature_offer":
        return this.evaluateFeatureOffer(input);
      case "callback":
        return this.evaluateCallback(input);
      case "pre_checkout":
        return this.evaluatePrecheckout(input);
      case "payment_success":
        return this.evaluatePaymentSuccess(input);
      case "subscription_offer":
        return this.evaluateSubscriptionOffer(input);
      case "finalize_photo_event":
        return this.evaluateFinalizePhotoEvent(input);
      case "finalize_subscription_offer":
        return this.evaluateFinalizeSubscriptionOffer(input);
      case "noop":
        return buildBaseResponse(input, route);
    }
  }

  private async buildSceneUnlockEntryTokenRows(input: {
    chat_id: number;
    scene_session_id: string | null;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature?: string | null;
    target_message_id?: number | null;
    current_uuid?: string | null;
    base_price_xtr?: number | null;
    subscription_active: boolean;
    scene_access_active: boolean;
    ab_selection?: AbTestSelection | null;
  }): Promise<InteractionTokenRow[]> {
    if (
      input.subscription_active
      || input.scene_access_active
      || !input.scene_session_id
    ) {
      return [];
    }

    const abSelection = input.ab_selection === undefined
      ? await this.resolveAbTestSelection(input.chat_id, "subscription_offer")
      : input.ab_selection;
    if (abSelection?.params.scene_unlock?.enabled === false) {
      return [];
    }

    return [
      buildFreeActionTokenRow({
        action_kind: "free_scene_unlock",
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        target_message_id: input.target_message_id,
        current_uuid: input.current_uuid,
        base_price_xtr: input.base_price_xtr,
        feature_key: "scene_unlock",
        action_button_text: config.TELEGRAM_UX_COPY_JSON.media.scene_unlock_button,
        ab_test: toAbTestContext(abSelection),
      }),
    ];
  }

  private async buildSceneUnlockPaymentOptionsAtClick(input: {
    token: string;
    chat_id: number;
    scene_session_id: string;
    target_message_id: number | null;
  }): Promise<MediaPaymentOption[]> {
    const abSelection = await this.resolveAbTestSelection(
      input.chat_id,
      "subscription_offer",
    );
    const plan = applySceneUnlockOverride(
      resolveActionPlanByFeatureKey("scene_unlock"),
      abSelection?.params ?? {},
    );
    if (!plan) {
      return [];
    }

    const rows = await this.upsertCurrentPaymentAttempts(
      buildSceneUnlockPaymentInputs({
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        idempotency_key: `scene-unlock-click:${input.token}`,
        turn_limit: config.TURN_LIMIT,
        target_message_id: input.target_message_id,
        plan,
        ab_test: toAbTestContext(abSelection),
      }),
      "sceneUnlock.click",
    );
    const readyRows = await this.prepareRenderablePaymentRows(
      rows,
      "sceneUnlock.click",
    );

    return buildOfferItem(readyRows)?.payment_options ?? [];
  }

  private buildPhotoUnlockEntryTokenRow(input: {
    chat_id: number;
    scene_session_id: string;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    target_message_id: number | null;
    current_uuid: string | null;
    base_price_xtr: number;
    photo_sku?: string | null;
    requested_action: string;
    panel_text?: string | null;
    panel_entities_json?: unknown[] | null;
  }): InteractionTokenRow {
    return buildFreeActionTokenRow({
      action_kind: "free_photo_unlock",
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      target_message_id: input.target_message_id,
      current_uuid: input.current_uuid,
      base_price_xtr: input.base_price_xtr,
      photo_sku: input.photo_sku,
      feature_key: "photo_unlock",
      requested_action: input.requested_action,
      panel_text: input.panel_text,
      panel_entities_json: input.panel_entities_json,
      action_button_text: config.TELEGRAM_UX_COPY_JSON.media.get_photo_button,
    });
  }

  private async buildPhotoPaymentOptionsAtClick(input: {
    token: string;
    chat_id: number;
    scene_session_id: string;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    target_message_id: number | null;
    current_uuid: string | null;
    base_price_xtr: number;
    photo_sku: string | null;
    requested_action: string;
    panel_text: string | null;
    panel_entities_json: unknown[];
  }): Promise<MediaPaymentOption[]> {
    const plan = resolvePhotoPlanBySku(input.photo_sku);
    if (!plan) {
      throw new MediaCommerceOperationError(
        `Unknown configured photo SKU: ${input.photo_sku ?? "<missing>"}`,
        "photoUnlock.resolvePlan",
        "unknown_photo_sku",
      );
    }
    const stored = await this.repository.upsertInvoiceToken(
      buildPhotoInvoiceInput({
        token: `photo-unlock-click:${input.token}`,
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        target_message_id: input.target_message_id,
        current_uuid: input.current_uuid,
        base_price_xtr: input.base_price_xtr,
        amount_xtr: plan.amount_xtr,
        original_amount_xtr: plan.original_amount_xtr,
        promo_key: plan.promo_key,
        invoice_sku: plan.sku,
        invoice_title: plan.title,
        invoice_description: plan.description,
        invoice_label: plan.label,
        invoice_button_text: plan.button_text,
        payload_json: {
          action_kind: "photo_payment",
          chat_id: input.chat_id,
          scene_session_id: input.scene_session_id,
          turn_no: input.turn_no,
          scene_turn_no: input.scene_turn_no,
          media_signature: input.media_signature,
          target_message_id: input.target_message_id,
          current_uuid: input.current_uuid,
          base_price_xtr: input.base_price_xtr,
          photo_sku: plan.sku,
          requested_action: input.requested_action,
          panel_text: input.panel_text,
          panel_entities_json: input.panel_entities_json,
          idempotency_key: `photo-unlock-click:${input.token}`,
          original_amount_xtr: plan.original_amount_xtr,
          promo_key: plan.promo_key,
        },
      }),
    );
    const ready = stored
      ? await this.ensureStarsInvoiceLink(stored, "photoUnlock.click")
      : null;

    return ready ? buildTopLevelPaymentFields([ready]).payment_options ?? [] : [];
  }

  private async evaluatePrepareOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "prepare_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const stats = await this.repository.loadOfferStats({
      chat_id: chatId,
      scene_session_id: normalizeString(input.scene_session_id),
      turn_no: normalizeNonNegativeInteger(input.turn_no),
      media_signature: normalizeString(input.media_signature),
      scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
      base_price_xtr: normalizePositiveInteger(input.base_price_xtr) ?? 10,
      should_offer: normalizeBoolean(input.should_offer),
    });

    return this.resolvePrepareOffer(base, stats, normalizeString(input.photo_sku));
  }

  private async resolvePrepareOffer(
    base: MediaCommerceDecisionResponse,
    stats: MediaOfferStats,
    photoSku: string | null,
  ): Promise<MediaCommerceDecisionResponse> {
    const deliveredInScene = normalizeNonNegativeInteger(stats.delivered_in_scene) ?? 0;
    const subscriptionActive = stats.subscription_active === true;
    const sceneAccessActive = stats.scene_access_active === true;
    const totalAvailable = normalizeNonNegativeInteger(stats.total_available) ?? 0;
    const unseenAvailable = normalizeNonNegativeInteger(stats.unseen_available) ?? 0;
    const existingPanel = normalizePositiveInteger(stats.existing_panel_message_id);
    const basePrice = normalizePositiveInteger(stats.base_price_xtr) ?? 10;
    const priceRequired = calculateMediaPriceRequired({
      subscription_active: subscriptionActive,
      scene_access_active: sceneAccessActive,
      delivered_in_scene: deliveredInScene,
      base_price_xtr: basePrice,
    });
    const mediaSignature = normalizeString(stats.media_signature);
    if (
      !stats.should_offer
      || !mediaSignature
      || totalAvailable < 1
      || unseenAvailable < 1
      || existingPanel
    ) {
      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_none",
        has_media_offer: false,
      };
    }

    const sceneUnlockTokenRows = await this.buildSceneUnlockEntryTokenRows({
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      target_message_id: null,
      current_uuid: null,
      base_price_xtr: basePrice,
      subscription_active: subscriptionActive,
      scene_access_active: sceneAccessActive,
    });

    if (priceRequired > 0) {
      if (!stats.scene_session_id) {
        return { ...base, reason: "scene_session_id_required" };
      }
      const photoUnlockTokenRow = this.buildPhotoUnlockEntryTokenRow({
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        target_message_id: null,
        current_uuid: null,
        base_price_xtr: basePrice,
        photo_sku: photoSku,
        requested_action: "photo_request",
      });
      const tokenRows = [photoUnlockTokenRow, ...sceneUnlockTokenRows];
      const tokenRowsInserted = await this.repository.upsertCallbackTokens(tokenRows);

      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_callback",
        has_media_offer: true,
        token_rows: tokenRows,
        token_rows_prepared: tokenRows.length,
        token_rows_inserted: tokenRowsInserted,
        scene_unlock_offer_item: null,
        reason: "photo_unlock_entry_ready",
      };
    }

    const tokenRow = buildCallbackTokenRow({
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      target_message_id: null,
      current_uuid: null,
      base_price_xtr: basePrice,
      next_action: "photo_request",
      requested_action: "photo_request",
      button_text: config.TELEGRAM_UX_COPY_JSON.media.get_photo_button,
      extraPayload: { photo_sku: photoSku },
    });
    const tokenRows = [tokenRow, ...sceneUnlockTokenRows];
    const insertedCount = await this.repository.upsertCallbackTokens(tokenRows);

    return {
      ...base,
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      base_price_xtr: basePrice,
      price_required: 0,
      operation: "prepare_offer_callback",
      has_media_offer: true,
      token_rows: tokenRows,
      token_rows_prepared: tokenRows.length,
      token_rows_inserted: insertedCount,
      reason: "free_offer_ready",
    };
  }

  private async evaluateFinalizeOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const result = await this.repository.storePanel({
      chat_id: chatId,
      scene_session_id: normalizeString(input.scene_session_id),
      turn_no: normalizeNonNegativeInteger(input.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
      media_signature: normalizeString(input.media_signature),
      panel_message_id: normalizePositiveInteger(input.panel_message_id),
      price_xtr: normalizeNonNegativeInteger(input.price_required) ?? 0,
      invoice_token: normalizeString(input.invoice_token),
      invoice_link: normalizeString(input.invoice_link),
      panel_text: normalizeString(input.panel_text),
      panel_entities_json: parseJsonArray(input.panel_entities_json) ?? [],
    });

    return {
      ...base,
      operation: "finalized_panel",
      chat_id: result.chat_id,
      turn_no: result.n,
      scene_session_id: result.scene_session_id,
      scene_turn_no: result.scene_turn_no,
      media_signature: result.media_signature,
      price_required: result.price_required,
      panel_message_id: result.panel_message_id,
      stored_count: result.stored_count,
      invoice_rows_updated: result.invoice_rows_updated,
      reason: result.stored_count > 0 ? "panel_stored" : "panel_already_stored",
    };
  }

  private async evaluateFeatureOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "feature_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const featureKey = normalizeFeatureKeyValue(
      typeof input.feature_key === "string" ? input.feature_key : null,
    );
    if (!featureKey) {
      return { ...base, reason: "feature_key_invalid" };
    }

    const actionPlan = resolveActionPlanByFeatureKey(featureKey);
    if (!actionPlan) {
      return { ...base, feature_key: featureKey, reason: "feature_key_invalid" };
    }

    const freeFastSkipButton =
      config.TELEGRAM_UX_COPY_JSON.free_actions.fast_scene_skip_button;
    const freeCredits =
      featureKey === "fast_scene_skip"
        ? await this.repository.loadFreeCredits(chatId)
        : null;
    const sceneSessionId =
      normalizeString(input.scene_session_id)
      ?? normalizeString(freeCredits?.active_scene_session_id);
    if (featureKey === "fast_scene_skip" && sceneSessionId) {
      const freeFastSkips = normalizeNonNegativeInteger(freeCredits?.free_fast_scene_skips) ?? 0;
      if (freeFastSkips > 0) {
        const tokenRow = buildFreeActionTokenRow({
          action_kind: "free_fast_scene_skip",
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          turn_no: normalizeNonNegativeInteger(input.turn_no),
          scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
          character_i: normalizePositiveInteger(input.character_i),
          scene_mode: normalizeString(input.scene_mode),
          media_signature: normalizeString(input.media_signature),
          target_message_id: normalizePositiveInteger(input.target_message_id),
          current_uuid: normalizeLowerString(input.current_uuid),
          base_price_xtr: normalizePositiveInteger(input.base_price_xtr),
          feature_key: "fast_scene_skip",
          action_button_text: replaceCount(freeFastSkipButton, freeFastSkips),
        });
        const insertedCount = await this.repository.upsertCallbackTokens([tokenRow]);

        return {
          ...base,
          operation: "feature_offer_required",
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          feature_key: featureKey,
          token_rows: [tokenRow],
          token_rows_prepared: 1,
          token_rows_inserted: insertedCount,
          payment_options: [],
          reason: "free_fast_scene_skip_available",
        };
      }
    }

    const storedFeatureInvoices = await this.upsertCurrentPaymentAttempts(
      buildFeaturePaymentInputs({
        chat_id: chatId,
        scene_session_id: normalizeString(input.scene_session_id),
        turn_no: normalizeNonNegativeInteger(input.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
        character_i: normalizePositiveInteger(input.character_i),
        scene_mode: normalizeString(input.scene_mode),
        media_signature: normalizeString(input.media_signature),
        target_message_id: normalizePositiveInteger(input.target_message_id),
        current_uuid: normalizeLowerString(input.current_uuid),
        base_price_xtr: normalizePositiveInteger(input.base_price_xtr),
        idempotency_key: [
          "feature",
          chatId,
          normalizeString(input.scene_session_id) ?? "no-scene",
          normalizeNonNegativeInteger(input.turn_no) ?? "no-turn",
          normalizeNonNegativeInteger(input.scene_turn_no) ?? "no-scene-turn",
          featureKey,
        ].join(":"),
        requested_action: `${featureKey}_purchase`,
        plan: actionPlan,
      }),
      "featureOffer",
    );
    const featureInvoices = await this.prepareRenderablePaymentRows(
      storedFeatureInvoices,
      "featureOffer",
    );
    const featureInvoice = selectLegacyPrimaryRow(featureInvoices);
    const featurePaymentOptions = featureInvoices
      .map((row) => buildPaymentOption(row))
      .sort((left, right) => getSourceSortOrder(left.source) - getSourceSortOrder(right.source));
    const revealTokenRows =
      featurePaymentOptions.length > 0
        ? [
            buildPaymentUiTokenRow({
              action_kind: "reveal_feature_payment_options",
              chat_id: chatId,
              scene_session_id: normalizeString(input.scene_session_id),
              turn_no: normalizeNonNegativeInteger(input.turn_no),
              scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
              target_message_id: normalizePositiveInteger(input.target_message_id),
              feature_key: featureKey,
              invoice_tokens: storedFeatureInvoices.map((row) => row.token),
              idempotency_key: [
                "feature-ui",
                chatId,
                normalizeString(input.scene_session_id) ?? "no-scene",
                normalizeNonNegativeInteger(input.turn_no) ?? "no-turn",
                normalizeNonNegativeInteger(input.scene_turn_no) ?? "no-scene-turn",
                featureKey,
              ].join(":"),
            }),
          ]
        : [];
    const revealTokenRowsInserted = revealTokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(revealTokenRows)
      : 0;

 return {
  ...base,
  operation: "feature_offer_required",
  chat_id: chatId,
  feature_key: featureKey,
  invoice_kind: "feature",
  invoice_sku: featureInvoice?.sku ?? actionPlan.sku,
  invoice_amount: featureInvoice?.amount_xtr ?? actionPlan.amount_xtr,
  original_invoice_amount:
    normalizePositiveInteger(featureInvoice?.payload_json.original_amount_xtr)
    ?? actionPlan.original_amount_xtr
    ?? null,
  promo_key:
    normalizeString(
      typeof featureInvoice?.payload_json.promo_key === "string"
        ? featureInvoice.payload_json.promo_key
        : null,
    )
    ?? actionPlan.promo_key
    ?? null,
  invoice_title: featureInvoice?.invoice_title ?? actionPlan.title,
  invoice_description:
    featureInvoice?.invoice_description ?? actionPlan.description,
  invoice_label: featureInvoice?.invoice_label ?? actionPlan.label,
  invoice_button_text: actionPlan.button_text,
  invoice_payload_json: featureInvoice?.payload_json ?? null,
  token_rows: revealTokenRows,
  token_rows_prepared: revealTokenRows.length,
  token_rows_inserted: revealTokenRowsInserted,
  ...buildTopLevelPaymentFields(featureInvoices),
  reason: "feature_offer_required",
};
}

  private async evaluateCallback(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "callback");
    const token = normalizeString(input.callback_data);
    const chatId = normalizePositiveInteger(input.chat_id);
    const callbackRow = await this.repository.loadCallbackToken(
      token,
      chatId,
    );
    const payload = parseJsonObject(callbackRow?.payload_json) ?? {};
    const actionKind =
      normalizeString(callbackRow?.action_kind)
      ?? normalizeString(
        typeof payload.action_kind === "string" ? payload.action_kind : null,
      );
    const rawPanel = extractPanelFromRawUpdate(input.raw_update);
    const panelText =
      rawPanel.panel_text
      ?? (typeof input.panel_text === "string" && input.panel_text.length > 0
        ? input.panel_text
        : null);
    const panelEntities =
      rawPanel.panel_entities_json ?? parseJsonArray(input.panel_entities_json);

    const callbackStatus = normalizeString(callbackRow?.status);
    const isFreeActionReplay =
      callbackStatus === "fulfilled"
      && (
        actionKind === "free_fast_scene_skip"
        || actionKind === "free_scene_unlock"
        || actionKind === "free_photo_unlock"
      );
    const valid =
      Boolean(callbackRow?.found && callbackRow?.token)
      && !isExpired(callbackRow?.expires_at)
      && (callbackStatus === "active" || isFreeActionReplay);
    const answerText = !valid
      ? config.TELEGRAM_UX_COPY_JSON.payment_errors.stale
      : (actionKind === "photo_request" || actionKind === "photo_regen")
        ? config.TELEGRAM_UX_COPY_JSON.media.generating
        : "";

    const callbackBase = {
      ...base,
      callback_valid: valid,
      callback_answer_text: answerText,
      callback_show_alert: false,
      chat_id:
        normalizePositiveInteger(callbackRow?.chat_id)
        ?? normalizePositiveInteger(payload.chat_id)
        ?? base.chat_id,
      scene_session_id:
        normalizeString(callbackRow?.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        )
        ?? base.scene_session_id,
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(callbackRow?.turn_no)
        ?? base.turn_no,
      scene_turn_no:
        normalizeNonNegativeInteger(payload.scene_turn_no) ?? base.scene_turn_no,
      media_signature:
        normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ) ?? base.media_signature,
      photo_sku:
        normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ) ?? base.photo_sku,
      target_message_id:
        normalizePositiveInteger(payload.target_message_id)
        ?? normalizePositiveInteger(input.inbound_message_id)
        ?? base.target_message_id,
      current_uuid:
        normalizeLowerString(
          typeof payload.current_uuid === "string" ? payload.current_uuid : null,
        ) ?? base.current_uuid,
      base_price_xtr:
        normalizePositiveInteger(payload.base_price_xtr) ?? base.base_price_xtr,
      panel_text: panelText,
      panel_entities_json: panelEntities,
      message_kind: rawPanel.message_kind,
      current_reply_markup: rawPanel.reply_markup,
    } satisfies MediaCommerceDecisionResponse;

    if (!valid || !callbackBase.chat_id) {
      return {
        ...callbackBase,
        operation: "noop",
        reason: valid ? "chat_id_required" : "callback_invalid",
      };
    }

    if (
      actionKind === "free_fast_scene_skip"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreeFastSceneSkipCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "free_scene_unlock"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreeSceneUnlockCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "free_photo_unlock"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreePhotoUnlockCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "reveal_feature_payment_options"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateRevealFeaturePaymentOptionsCallback(
        callbackBase,
        payload,
      );
    }

    if (
      actionKind === "subscription_payment_source_toggle"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateSubscriptionPaymentSourceToggleCallback(
        callbackBase,
        payload,
      );
    }

    const loadedContext = await this.repository.loadMediaContext({
      chat_id: callbackBase.chat_id,
      scene_session_id: callbackBase.scene_session_id ?? null,
      turn_no: callbackBase.turn_no ?? null,
      scene_turn_no: callbackBase.scene_turn_no ?? null,
      media_signature: callbackBase.media_signature ?? null,
      current_uuid: callbackBase.current_uuid ?? null,
      target_message_id: callbackBase.target_message_id ?? null,
      base_price_xtr: callbackBase.base_price_xtr ?? 10,
      action_kind: actionKind,
      requested_action: normalizeString(
        typeof payload.requested_action === "string"
          ? payload.requested_action
          : null,
      ),
      invoice_token: null,
      force_deliver_after_payment: false,
      paid_access_mode: null,
      callback_valid: true,
      panel_text: panelText,
      panel_entities_json: panelEntities ?? [],
    });
    const context = {
      ...loadedContext,
      photo_sku: callbackBase.photo_sku ?? null,
    };

    return this.applyMediaActionDecision(callbackBase, context);
  }

  private async evaluateRevealFeaturePaymentOptionsCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const invoiceTokens =
      normalizeInvoiceTokens(payload.invoice_tokens).length > 0
        ? normalizeInvoiceTokens(payload.invoice_tokens)
        : extractLegacyPaymentOptionTokens(payload.payment_options);
    const featureKey = normalizeString(
      typeof payload.feature_key === "string" ? payload.feature_key : null,
    );
    if (!base.chat_id || invoiceTokens.length === 0 || !featureKey) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const rows = await this.repository.loadStoredInvoiceTokens(invoiceTokens);
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const orderedRows = invoiceTokens.flatMap((token) => {
      const row = byToken.get(token);
      return row ? [row] : [];
    });
    const groups = new Set<string>();
    let sceneSessionId: string | null = null;
    for (const row of orderedRows) {
      const purchaseGroup = buildPurchaseGroupKey(row);
      const actionKind = normalizeString(row.action_kind);
      const isPhotoUnlockRow =
        featureKey === "photo_unlock" && actionKind === "photo_payment";
      if (
        normalizePositiveInteger(row.chat_id) !== base.chat_id
        || (!isPhotoUnlockRow && actionKind !== "feature_payment")
        || (!isPhotoUnlockRow && getInvoiceFeatureKey(row) !== featureKey)
        || !purchaseGroup
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
      groups.add(purchaseGroup);
      sceneSessionId = sceneSessionId ?? normalizeString(row.scene_session_id);
    }
    if (orderedRows.length !== invoiceTokens.length || groups.size !== 1) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    if (sceneSessionId) {
      const sceneStatus = await this.repository.loadSceneAccessStatus({
        chat_id: base.chat_id,
        scene_session_id: sceneSessionId,
      });
      if (
        sceneStatus?.scene_is_active !== true
        || normalizeString(sceneStatus.active_scene_session_id) !== sceneSessionId
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
    }

    const readyRows = await this.prepareRenderablePaymentRows(
      orderedRows,
      "featurePayment.rebuild",
    );
    if (readyRows.length === 0) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const paymentOptions = readyRows
      .map((row) => buildPaymentOption(row))
      .sort((left, right) => getSourceSortOrder(left.source) - getSourceSortOrder(right.source));

    return {
      ...base,
      operation: "feature_payment_options_revealed",
      callback_valid: true,
      callback_answer_text: "",
      payment_options: paymentOptions,
      feature_key: featureKey,
      feature_payment_hint_text:
        getFeaturePaymentHint(featureKey),
      payment_ui: buildPaymentUiCopy(),
      reason: "feature_payment_options_revealed",
    };
  }

  private async evaluateSubscriptionPaymentSourceToggleCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const selectedPaymentSource = normalizePaymentSource(
      typeof payload.selected_payment_source === "string"
        ? payload.selected_payment_source
        : null,
    );
    const callbackOfferId = normalizeString(
      typeof payload.offer_id === "string" ? payload.offer_id : null,
    );
    const invoiceTokens =
      normalizeInvoiceTokens(payload.invoice_tokens).length > 0
        ? normalizeInvoiceTokens(payload.invoice_tokens)
        : extractLegacySubscriptionInvoiceTokens(payload.subscription_offer_items);
    if (!base.chat_id || invoiceTokens.length === 0 || !selectedPaymentSource) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const rows = await this.repository.loadStoredInvoiceTokens(invoiceTokens);
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const orderedRows = invoiceTokens.flatMap((token) => {
      const row = byToken.get(token);
      return row ? [row] : [];
    });
    const offerIds = new Set<string>();
    for (const row of orderedRows) {
      const offerId = getInvoicePurchaseId(row);
      if (
        normalizePositiveInteger(row.chat_id) !== base.chat_id
        || normalizeString(row.action_kind) !== "subscription_payment"
        || !offerId
        || !normalizeString(row.sku)
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
      offerIds.add(offerId);
    }
    const [offerId] = Array.from(offerIds);
    const activeOfferId = await this.repository.loadActiveSubscriptionOfferId(base.chat_id);
    if (
      orderedRows.length !== invoiceTokens.length
      || offerIds.size !== 1
      || (callbackOfferId != null && callbackOfferId !== offerId)
      || activeOfferId !== offerId
    ) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const readyRows = await this.prepareRenderablePaymentRows(
      orderedRows,
      "subscription.rebuild",
    );
    const offerItems = groupOfferItems(readyRows);
    if (offerItems.length === 0) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const hasRequestedSource = offerItems.some((item) =>
      item.payment_options.some((option) => option.source === selectedPaymentSource));
    const hasSbpOption = offerItems.some((item) =>
      item.payment_options.some((option) => option.source === "sbp"));
    const effectivePaymentSource: PaymentSource = hasRequestedSource
      ? selectedPaymentSource
      : hasSbpOption
        ? "sbp"
        : "stars";

    return {
      ...base,
      operation: "subscription_offer_ready",
      callback_valid: true,
      callback_answer_text: "",
      selected_payment_source: effectivePaymentSource,
      subscription_offer_items: offerItems,
      token_rows: [],
      token_rows_prepared: 0,
      text: base.panel_text,
      free_balance_text: null,
      offer_message_id:
        base.target_message_id
        ?? base.inbound_message_id
        ?? null,
      payment_source_toggle_tokens:
        parseJsonObject(payload.payment_source_toggle_tokens) as
          | Partial<Record<PaymentSource, string>>
          | null,
      payment_ui: buildPaymentUiCopy(),
      reason: "subscription_payment_source_toggled",
    };
  }

  private async evaluateFreeFastSceneSkipCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await this.runRepositoryOperation(
      "callback.freeFastSceneSkip.redeem",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreeFastSceneSkip(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};

    if (redeemed?.redeemed === true || redeemed?.already_consumed === true) {
      return {
        ...base,
        operation: "feature_fulfillment_required",
        callback_valid: true,
        callback_answer_text: "",
        chat_id:
          normalizePositiveInteger(redeemed.chat_id)
          ?? normalizePositiveInteger(payload.chat_id)
          ?? chatId,
        scene_session_id:
          normalizeString(redeemed.scene_session_id)
          ?? normalizeString(
            typeof payload.scene_session_id === "string"
              ? payload.scene_session_id
              : null,
          ),
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        character_i: normalizePositiveInteger(payload.character_i),
        scene_mode: normalizeString(
          typeof payload.scene_mode === "string" ? payload.scene_mode : null,
        ),
        media_signature: normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        payment_kind: "feature",
        payment_token: token,
        feature_key: "fast_scene_skip",
        reason: redeemed.already_consumed
          ? "free_fast_scene_skip_already_consumed"
          : "free_fast_scene_skip_redeemed",
      };
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "feature",
      payment_token: token,
      feature_key: "fast_scene_skip",
      reason: redeemed?.reason ?? "free_fast_scene_skip_invalid",
    };
  }

  private async evaluateFreeSceneUnlockCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await this.runRepositoryOperation(
      "callback.freeSceneUnlock.redeem",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreeSceneUnlock(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};

    if (redeemed?.redeemed === true || redeemed?.already_fulfilled === true) {
      return {
        ...base,
        operation: "scene_access_activated",
        text: config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated,
        callback_valid: true,
        callback_answer_text: "",
        chat_id:
          normalizePositiveInteger(redeemed.chat_id)
          ?? normalizePositiveInteger(payload.chat_id)
          ?? chatId,
        scene_session_id:
          normalizeString(redeemed.scene_session_id)
          ?? normalizeString(
            typeof payload.scene_session_id === "string"
              ? payload.scene_session_id
              : null,
          ),
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        payment_kind: "feature",
        payment_token: token,
        feature_key: "scene_unlock",
        stored_count: redeemed.redeemed ? 1 : 0,
        reason: redeemed.already_fulfilled
          ? "already_active"
          : "free_scene_unlock_redeemed",
      };
    }

    if (redeemed?.reason === "free_credit_unavailable") {
      const resolvedChatId =
        normalizePositiveInteger(redeemed.chat_id)
        ?? normalizePositiveInteger(payload.chat_id)
        ?? chatId;
      const resolvedSceneSessionId =
        normalizeString(redeemed.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        );
      const resolvedTargetMessageId =
        normalizePositiveInteger(payload.target_message_id)
        ?? base.target_message_id
        ?? null;
      if (!resolvedSceneSessionId) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
          callback_show_alert: false,
          reason: "scene_session_id_required",
        };
      }
      const paymentOptions = await this.buildSceneUnlockPaymentOptionsAtClick({
        token,
        chat_id: resolvedChatId,
        scene_session_id: resolvedSceneSessionId,
        target_message_id: resolvedTargetMessageId,
      });
      if (paymentOptions.length === 0) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
          callback_show_alert: false,
          reason: "scene_unlock_plan_missing",
        };
      }

      return this.evaluateRevealFeaturePaymentOptionsCallback(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          chat_id: resolvedChatId,
          scene_session_id: resolvedSceneSessionId,
          target_message_id: resolvedTargetMessageId,
        },
        {
          ...payload,
          invoice_tokens: paymentOptions.map((option) => option.token),
        },
      );
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "feature",
      payment_token: token,
      feature_key: "scene_unlock",
      reason: redeemed?.reason ?? "free_scene_unlock_invalid",
    };
  }

  private async evaluateFreePhotoUnlockCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await this.runRepositoryOperation(
      "callback.freePhotoUnlock.redeem",
      {
        chat_id: chatId,
        payment_kind: "photo",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreePhotoUnlock(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};
    const sceneSessionId =
      normalizeString(redeemed?.scene_session_id)
      ?? normalizeString(
        typeof payload.scene_session_id === "string"
          ? payload.scene_session_id
          : null,
      );
    const requestedAction = normalizeString(
      typeof payload.requested_action === "string"
        ? payload.requested_action
        : null,
    ) ?? "photo_request";

    const usedFreeCredit =
      redeemed?.redeemed === true || redeemed?.reason === "already_consumed";
    if (redeemed?.reason === "already_fulfilled") {
      return {
        ...base,
        operation: "noop",
        callback_valid: true,
        callback_answer_text: "",
        payment_kind: "photo",
        payment_token: token,
        feature_key: "photo_unlock",
        reason: "already_fulfilled",
      };
    }
    if (
      (usedFreeCredit || redeemed?.reason === "free_credit_not_required")
      && sceneSessionId
    ) {
      const boundPhotoUuid = usedFreeCredit
        ? normalizeLowerString(
            typeof payload.free_photo_uuid === "string"
              ? payload.free_photo_uuid
              : null,
          )
        : null;
      if (usedFreeCredit && !boundPhotoUuid) {
        return { ...base, operation: "noop", reason: "free_photo_uuid_missing" };
      }
      const loadedContext = await this.repository.loadMediaContext({
        chat_id: chatId,
        scene_session_id: sceneSessionId,
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
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
          ?? base.target_message_id
          ?? null,
        base_price_xtr: normalizePositiveInteger(payload.base_price_xtr) ?? 10,
        action_kind: requestedAction,
        requested_action: requestedAction,
        invoice_token: token,
        force_deliver_after_payment: usedFreeCredit,
        paid_access_mode: usedFreeCredit ? "free_credit" : null,
        callback_valid: true,
        panel_text: normalizeString(
          typeof payload.panel_text === "string" ? payload.panel_text : base.panel_text,
        ),
        panel_entities_json:
          parseJsonArray(payload.panel_entities_json)
          ?? base.panel_entities_json
          ?? [],
      });
      const context = {
        ...loadedContext,
        photo_sku: normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ),
      };
      if (boundPhotoUuid) {
        const boundPhoto = await this.repository.loadPhotoByUuid(boundPhotoUuid);
        if (!boundPhoto?.photo_url) {
          return {
            ...base,
            operation: "noop",
            callback_valid: false,
            reason: "free_photo_not_found",
          };
        }
        context.next_unseen_json = boundPhoto;
      }

      const response = await this.applyMediaActionDecision(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          payment_kind: "photo",
          payment_token: token,
        },
        context,
      );
      return usedFreeCredit
        ? {
            ...response,
            action_kind: "free_photo_unlock",
            fulfillment_invoice_token: token,
          }
        : response;
    }

    if (redeemed?.reason === "free_credit_unavailable" && sceneSessionId) {
      const paymentOptions = await this.buildPhotoPaymentOptionsAtClick({
        token,
        chat_id: chatId,
        scene_session_id: sceneSessionId,
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        media_signature: normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        current_uuid: normalizeLowerString(
          typeof payload.current_uuid === "string" ? payload.current_uuid : null,
        ),
        base_price_xtr: normalizePositiveInteger(payload.base_price_xtr) ?? 10,
        photo_sku: normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ),
        requested_action: requestedAction,
        panel_text: normalizeString(
          typeof payload.panel_text === "string" ? payload.panel_text : base.panel_text,
        ),
        panel_entities_json:
          parseJsonArray(payload.panel_entities_json)
          ?? base.panel_entities_json
          ?? [],
      });

      return this.evaluateRevealFeaturePaymentOptionsCallback(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          payment_kind: "photo",
          payment_token: token,
          scene_session_id: sceneSessionId,
        },
        {
          ...payload,
          feature_key: "photo_unlock",
          invoice_tokens: paymentOptions.map((option) => option.token),
        },
      );
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "photo",
      payment_token: token,
      feature_key: "photo_unlock",
      reason: redeemed?.reason ?? "free_photo_unlock_invalid",
    };
  }

  private async applyMediaActionDecision(
    base: MediaCommerceDecisionResponse,
    context: MediaContext,
  ): Promise<MediaCommerceDecisionResponse> {
    const decision = buildMediaAction(context);
    if (decision.operation === "noop") {
      return {
        ...base,
        operation: "noop",
        caption_text: decision.caption_text,
        caption_entities_json: decision.caption_entities_json,
        reason: "noop_media_action",
      };
    }

    let tokenRowsInserted = 0;
    const shouldOfferPhotoUnlock =
      decision.invoice_kind === "photo"
      && Boolean(base.chat_id)
      && Boolean(context.scene_session_id);
    const requestedPhotoAction = normalizeString(
      decision.invoice_payload_json?.requested_action,
    ) ?? "photo_regen";
    const photoUnlockTokenRows = shouldOfferPhotoUnlock
      ? [
          this.buildPhotoUnlockEntryTokenRow({
            chat_id: base.chat_id as number,
            scene_session_id: context.scene_session_id as string,
            turn_no: context.turn_no,
            scene_turn_no: context.scene_turn_no,
            media_signature: context.media_signature,
            target_message_id: context.target_message_id,
            current_uuid: decision.current_uuid,
            base_price_xtr: normalizePositiveInteger(context.base_price_xtr) ?? 10,
            photo_sku: normalizeString(context.photo_sku),
            requested_action: requestedPhotoAction,
            panel_text: decision.caption_text,
            panel_entities_json: decision.caption_entities_json,
          }),
        ]
      : [];
    const sceneUnlockTokenRows = base.chat_id
      ? await this.buildSceneUnlockEntryTokenRows({
        chat_id: base.chat_id as number,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: context.target_message_id,
        current_uuid: decision.current_uuid,
        base_price_xtr: normalizePositiveInteger(context.base_price_xtr) ?? 10,
        subscription_active: context.subscription_active === true,
        scene_access_active: context.scene_access_active === true,
      })
      : [];

    const allTokenRows = [
      ...decision.token_rows,
      ...photoUnlockTokenRows,
      ...sceneUnlockTokenRows,
    ];
    tokenRowsInserted = allTokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(allTokenRows)
      : 0;

    return {
      ...base,
      operation: decision.operation,
      chat_id: context.chat_id,
      scene_session_id: context.scene_session_id,
      turn_no: context.turn_no,
      scene_turn_no: context.scene_turn_no,
      media_signature: context.media_signature,
      photo_sku: normalizeString(context.photo_sku),
      target_message_id: context.target_message_id,
      current_uuid: decision.current_uuid,
      photo_url: decision.photo_url,
      selected_uuid: decision.selected_uuid,
      token_rows: allTokenRows,
      token_rows_prepared: allTokenRows.length,
      token_rows_inserted: tokenRowsInserted,
      log_event_type: decision.log_event_type,
      access_mode: decision.access_mode,
      log_price_xtr: decision.log_price_xtr,
      price_required: decision.price_required,
      invoice_kind: decision.invoice_kind,
      invoice_sku: decision.invoice_sku,
      invoice_amount: decision.invoice_amount,
      original_invoice_amount: decision.original_invoice_amount,
      promo_key: decision.promo_key,
      invoice_title: decision.invoice_title,
      invoice_description: decision.invoice_description,
      invoice_label: decision.invoice_label,
      invoice_payload_json: decision.invoice_payload_json,
      invoice_button_text: decision.invoice_button_text,
      ...buildTopLevelPaymentFields([]),
      scene_unlock_offer_item: null,
      fulfillment_invoice_token: decision.fulfillment_invoice_token,
      caption_text: decision.caption_text,
      caption_entities_json: decision.caption_entities_json,
      subscription_active: context.subscription_active,
      subscription_sku: context.subscription_sku,
      subscription_until: context.subscription_until,
      scene_access_active: context.scene_access_active,
      reason: "media_ready",
    };
  }

  private async evaluatePrecheckout(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "pre_checkout");
    const chatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!chatId || !invoicePayload) {
      return {
        ...base,
        operation: "answer_precheckout",
        precheckout_ok: false,
        precheckout_error: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        reason: !chatId ? "chat_id_required" : "invoice_payload_required",
      };
    }

    const tokenRow = await this.runRepositoryOperation(
      "payment.precheckout.loadInvoiceToken",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceToken(invoicePayload, chatId),
    );
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
        const activeOfferId = await this.runRepositoryOperation(
          "payment.precheckout.loadActiveSubscriptionOfferId",
          {
            chat_id: chatId,
            payment_kind: validation.action.payment_kind,
            sku: normalizeString(tokenRow?.sku),
            invoice_status: normalizeString(tokenRow?.status),
          },
          () => this.repository.loadActiveSubscriptionOfferId(chatId),
        );
        if (!offerId || activeOfferId !== offerId) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
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
        const sceneStatus = await this.runRepositoryOperation(
          "payment.precheckout.loadSceneAccessStatus",
          {
            chat_id: chatId,
            payment_kind: validationAction.payment_kind,
            sku: normalizeString(tokenRow?.sku),
            invoice_status: normalizeString(tokenRow?.status),
          },
          () => this.repository.loadSceneAccessStatus({
            chat_id: chatId,
            scene_session_id: invoiceSceneSessionId,
          }),
        );
        if (!invoiceSceneSessionId || sceneStatus?.scene_is_active !== true) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.different_scene,
            reason: "scene_invoice_not_active",
          };
        } else if (sceneStatus.subscription_active) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.subscription_active,
            reason: "subscription_already_active",
          };
        } else if (sceneStatus.scene_access_active) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.scene_already_unlocked,
            reason: "scene_access_already_active",
          };
        }
      }
    }

    if (tokenRow?.token != null) {
      const token = tokenRow.token;
      await this.runRepositoryOperation(
        "payment.precheckout.storePrecheckoutResult",
        {
          chat_id: normalizePositiveInteger(tokenRow.chat_id) ?? chatId,
          payment_kind: validation.action?.payment_kind ?? null,
          sku: normalizeString(tokenRow.sku),
          invoice_status: normalizeString(tokenRow.status),
        },
        () => this.repository.storePrecheckoutResult({
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
      chat_id: normalizePositiveInteger(tokenRow?.chat_id) ?? base.chat_id,
      scene_session_id: tokenRow?.scene_session_id ?? base.scene_session_id,
      turn_no: normalizeNonNegativeInteger(tokenRow?.turn_no) ?? base.turn_no,
      payment_kind: validation.action?.payment_kind ?? null,
      feature_key: validation.action?.feature_key ?? null,
      precheckout_ok: validation.ok,
      precheckout_error: validation.error,
      reason: validation.reason,
    };
  }

  private async evaluatePaymentSuccess(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "payment_success");
    if (normalizeString(input.event_type) === "payment.chargebacked.received") {
      return this.evaluateExternalPaymentChargeback(base, input);
    }
    if (normalizeString(input.event_type) === "payment.canceled.received") {
      return this.evaluateExternalPaymentCancellation(base, input);
    }
    const inputPaymentSource = normalizePaymentSource(input.payment_source);
    if (
      inputPaymentSource === "sbp"
      || normalizeString(input.event_type) === "payment.confirmed.received"
    ) {
      return this.evaluateExternalPaymentSuccess(base, input);
    }

    const chatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!chatId || !invoicePayload) {
      return {
        ...base,
        reason: !chatId ? "chat_id_required" : "invoice_payload_required",
      };
    }

    const loaded = await this.runRepositoryOperation(
      "payment.success.loadInvoiceToken",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceToken(invoicePayload, chatId),
    );
    if (!loaded?.found || !loaded.token) {
      return { ...base, reason: "invoice_not_found" };
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
        && resolvedAction.feature_key === "scene_unlock"
      ) {
        return {
          ...base,
          operation: "scene_access_activated",
          text: config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated,
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
      paidRow = await this.runRepositoryOperation(
        "payment.success.markInvoicePaid",
        {
          chat_id: chatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => this.repository.markInvoicePaid({
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
        const reloaded = await this.runRepositoryOperation(
          "payment.success.reloadInvoiceToken",
          {
            chat_id: chatId,
            payment_kind: actionResolution.action.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => this.repository.loadInvoiceToken(invoicePayload, chatId),
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
      return this.fulfillSubscriptionPayment(
        base,
        paidRow,
        resolvedAction,
      );
    }

    if (resolvedAction.payment_kind === "feature") {
      if (resolvedAction.feature_key === "scene_unlock") {
        return this.fulfillSceneAccessPayment(
          base,
          paidRow,
          payload,
          resolvedAction,
        );
      }
      return this.buildFeatureFulfillmentResponse(
        base,
        paidRow,
        payload,
        resolvedAction,
      );
    }

    return this.fulfillPhotoPayment(base, paidRow, payload);
  }

  private async recordSbpProviderEvent(
    input: MediaCommerceDecisionRequest,
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

    const updatedCount = await this.runRepositoryOperation(
      `${operationPrefix}.recordProviderEvent`,
      {
        chat_id: normalizePositiveInteger(loaded.chat_id),
        payment_kind: normalizeString(loaded.action_kind),
        sku: normalizeString(loaded.sku),
        invoice_status: normalizeString(loaded.status),
      },
      () => this.repository.recordSbpProviderEvent({
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

  private async evaluateExternalPaymentCancellation(
    base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);
    if (!externalPaymentId) {
      return { ...base, payment_source: "sbp", reason: "external_payment_id_required" };
    }

    const loaded = await this.runRepositoryOperation(
      "payment.external.loadCanceledInvoice",
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
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

    await this.recordSbpProviderEvent(
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
      const conflictRecorded = await this.runRepositoryOperation(
        "payment.externalCanceled.recordStatusConflict",
        {
          chat_id: normalizePositiveInteger(loaded.chat_id),
          payment_kind: normalizePaymentKindFromActionKind(loaded.action_kind),
          sku: normalizeString(loaded.sku),
          invoice_status: status,
        },
        () => this.repository.recordSbpStatusConflict(externalPaymentId, "CANCELED"),
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

    const updated = await this.runRepositoryOperation(
      "payment.external.markInvoiceCanceled",
      {
        chat_id: normalizePositiveInteger(loaded.chat_id),
        payment_kind: normalizeString(loaded.action_kind),
        sku: normalizeString(loaded.sku),
        invoice_status: status,
      },
      () => this.repository.markSbpInvoiceCanceled(externalPaymentId),
    );
    if (updated !== 1) {
      const reloaded = await this.repository.loadInvoiceTokenByExternalPaymentId(
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

  private async evaluateExternalPaymentChargeback(
    base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);
    if (!externalPaymentId) {
      return { ...base, payment_source: "sbp", reason: "external_payment_id_required" };
    }

    const loaded = await this.runRepositoryOperation(
      "payment.externalChargeback.loadInvoiceTokenByExternalPaymentId",
      { chat_id: null, payment_kind: null, sku: null, invoice_status: null },
      () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
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

    await this.recordSbpProviderEvent(
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

  private async evaluateExternalPaymentSuccess(
    base: MediaCommerceDecisionResponse,
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

    const loaded = await this.runRepositoryOperation(
      "payment.external.loadInvoiceTokenByExternalPaymentId",
      {
        chat_id: null,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
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

    await this.recordSbpProviderEvent(
      input,
      "CONFIRMED",
      loaded,
      "payment.externalConfirmed",
    );

    if (existingStatus === "canceled") {
      const conflictRecorded = await this.runRepositoryOperation(
        "payment.external.recordStatusConflict",
        {
          chat_id: loadedChatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => this.repository.recordSbpStatusConflict(externalPaymentId, "CONFIRMED"),
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
      paidRow = await this.runRepositoryOperation(
        "payment.external.markInvoicePaid",
        {
          chat_id: loadedChatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => this.repository.markInvoicePaid({
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
        const reloaded = await this.runRepositoryOperation(
          "payment.external.reloadInvoiceTokenByExternalPaymentId",
          {
            chat_id: loadedChatId,
            payment_kind: resolvedAction.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
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
          const conflictRecorded = await this.runRepositoryOperation(
            "payment.external.recordStatusConflict",
            {
              chat_id: loadedChatId,
              payment_kind: resolvedAction.payment_kind,
              sku: normalizeString(loaded.sku),
              invoice_status: reloadedStatus,
            },
            () => this.repository.recordSbpStatusConflict(externalPaymentId, "CONFIRMED"),
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
      return this.fulfillSubscriptionPayment(base, paidRow, resolvedAction);
    }

    if (resolvedAction.payment_kind === "feature") {
      if (resolvedAction.feature_key === "scene_unlock") {
        return this.fulfillSceneAccessPayment(base, paidRow, payload, resolvedAction);
      }
      return this.buildFeatureFulfillmentResponse(base, paidRow, payload, resolvedAction);
    }

    return this.fulfillPhotoPayment(base, paidRow, payload);
  }

  private async fulfillSubscriptionPayment(
    base: MediaCommerceDecisionResponse,
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

    const activatedCount = await this.runRepositoryOperation(
      "payment.subscription.activateSubscription",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "subscription",
        sku: subscriptionSku,
        invoice_status: paidRow.status,
      },
      () => this.repository.activateSubscription({
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
      await this.runRepositoryOperation(
        "payment.subscription.clearActiveOffer",
        {
          chat_id: paidRow.chat_id,
          payment_kind: "subscription",
          sku: subscriptionSku,
          invoice_status: paidRow.status,
        },
        () => this.repository.clearActiveSubscriptionOffer(paidRow.chat_id, offerId),
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

  private buildFeatureFulfillmentResponse(
    base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
    action: FeaturePaymentAction,
  ): MediaCommerceDecisionResponse {
    return {
      ...base,
      operation: "feature_fulfillment_required",
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
      character_i: normalizePositiveInteger(payload.character_i),
      scene_mode: normalizeString(
        typeof payload.scene_mode === "string"
          ? payload.scene_mode
          : null,
      ),
      media_signature: normalizeString(
        typeof payload.media_signature === "string"
          ? payload.media_signature
          : null,
      ),
      target_message_id: normalizePositiveInteger(payload.target_message_id),
      payment_kind: "feature",
      payment_token: paidRow.token,
      feature_key: action.feature_key,
      reason: `feature_${action.feature_key}_fulfillment_required`,
    };
  }

  private async fulfillSceneAccessPayment(
    base: MediaCommerceDecisionResponse,
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

    const activatedCount = await this.runRepositoryOperation(
      "payment.sceneAccess.activateSceneAccess",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "feature",
        sku: sceneAccessSku,
        invoice_status: paidRow.status,
      },
      () => this.repository.activateSceneAccess({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        scene_session_id: sceneSessionId,
        scene_access_sku: sceneAccessSku,
      }),
    );
    const failureReason = activatedCount > 0
      ? null
      : await this.resolveSceneAccessActivationFailure(
        paidRow.chat_id,
        sceneSessionId,
      );

    return {
      ...base,
      operation: activatedCount > 0 ? "scene_access_activated" : "noop",
      text: activatedCount > 0
        ? config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated
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
  }

  private async resolveSceneAccessActivationFailure(
    chatId: number,
    sceneSessionId: string,
  ): Promise<"already_active" | "scene_not_active" | "invoice_invalid"> {
    const sceneStatus = await this.runRepositoryOperation(
      "payment.sceneAccess.loadSceneAccessStatus",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: "payment_action_2",
        invoice_status: "paid",
      },
      () => this.repository.loadSceneAccessStatus({
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

  private async fulfillPhotoPayment(
    base: MediaCommerceDecisionResponse,
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
    const loadedContext = await this.runRepositoryOperation(
      "payment.photo.loadMediaContext",
      {
        chat_id: mediaContextInput.chat_id,
        payment_kind: "photo",
        sku: normalizeString(paidRow.sku),
        invoice_status: paidRow.status,
      },
      () => this.repository.loadMediaContext(mediaContextInput),
    );
    const context = {
      ...loadedContext,
      photo_sku: photoSku,
    };

    const response = await this.applyMediaActionDecision(
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

  private async resolveAbTestSelection(
    chatId: number,
    key: "subscription_offer",
  ): Promise<AbTestSelection | null> {
    const experiment = findActiveExperiment(config.EXPERIMENTS, key);
    if (!experiment) {
      return null;
    }

    const buildSelection = (
      assignment: NonNullable<ReturnType<typeof parseAbTestAssignment>>,
    ): AbTestSelection | null => {
      const params = experiment.variants[assignment.variant];
      if (!params) {
        console.error("[media_commerce] ab_test_variant_missing", {
          chat_id: chatId,
          key,
          starts_at: experiment.starts_at,
          version: experiment.version,
          variant: assignment.variant,
        });
        return null;
      }

      return {
        assignment_key: experiment.assignment_key,
        config: experiment,
        assignment,
        params,
      };
    };

    const existingAssignment = parseAbTestAssignment(
      await this.repository.loadAbTestAssignment(
        chatId,
        experiment.assignment_key,
      ),
    );
    if (existingAssignment) {
      return buildSelection(existingAssignment);
    }

    const assignment = buildAssignment({
      variant: chooseVariant(experiment.distribution),
    });
    const storedAssignment = parseAbTestAssignment(
      await this.repository.storeAbTestAssignment(
        chatId,
        experiment.assignment_key,
        assignment,
      ),
    ) ?? assignment;

    return buildSelection(storedAssignment);
  }

  private async evaluateSubscriptionOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "subscription_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const subscriptionOfferReason =
      input.subscription_offer_reason === "daily_turn_limit"
      || input.subscription_offer_reason === "subscription_command"
        ? input.subscription_offer_reason
        : null;
    const offerId = normalizeString(input.idempotency_key);
    if (!offerId) {
      return { ...base, chat_id: chatId, reason: "subscription_offer_id_required" };
    }
    const turnLimit = normalizePositiveInteger(input.turn_limit) ?? config.TURN_LIMIT;
    const turnsToday =
      normalizeNonNegativeInteger(input.turns_today) ?? turnLimit;
    const turnLimitResetText =
      normalizeString(input.turn_limit_reset_text) ?? config.TURN_LIMIT_RESET_TEXT;
    const abSelection = await this.resolveAbTestSelection(
      chatId,
      "subscription_offer",
    );
    const abContext = toAbTestContext(abSelection);
    const abParams = abSelection?.params ?? {};
    const abTokenSuffix = buildAbTokenSuffix(abSelection);
    const effectiveIdempotencyKey =
      abTokenSuffix != null
        ? `${offerId}:ab_${abTokenSuffix}`
        : offerId;
    const offerText = resolveSubscriptionOfferText(
      abParams,
      subscriptionOfferReason,
    );
    const freeBalanceText = formatFreeBalances(input);
    const offerAccessStatus = await this.runRepositoryOperation(
      "subscription.loadSceneAccessStatus",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadSceneAccessStatus({
        chat_id: chatId,
        scene_session_id: null,
      }),
    );
    const subscriptionActive = offerAccessStatus?.subscription_active === true;
    const requestSceneSessionId = normalizeString(input.scene_session_id);
    const requestSceneTurnNo = normalizeNonNegativeInteger(input.scene_turn_no);
    const inActiveScene =
      Boolean(requestSceneSessionId)
      && offerAccessStatus?.scene_is_active === true
      && normalizeString(offerAccessStatus.active_scene_session_id) === requestSceneSessionId;
    const activeSceneSessionId =
      inActiveScene ? requestSceneSessionId : null;
    const canOfferSceneUnlock =
      !subscriptionActive
      && inActiveScene
      && activeSceneSessionId
      && abParams.scene_unlock?.enabled !== false;
    const subscriptionPlans = applySubscriptionPlanOverrides(
      resolveSubscriptionPlans(),
      abParams,
    );
    const invoiceInputs = subscriptionPlans.flatMap((plan, index) =>
      buildSubscriptionPaymentInputs({
        chat_id: chatId,
        idempotency_key: offerId,
        subscription_offer_reason: subscriptionOfferReason,
        turn_limit: turnLimit,
        turns_today: turnsToday,
        turn_limit_reset_text: turnLimitResetText,
        sort_order: index + 1,
        plan,
        ab_test: abContext,
      }));

    const upsertedRows = await this.upsertCurrentPaymentAttempts(
      invoiceInputs,
      "subscription",
    );
    if (invoiceInputs.length > 0 && upsertedRows.length === 0) {
      return {
        ...base,
        chat_id: chatId,
        scene_session_id: activeSceneSessionId,
        reason: "subscription_payment_attempts_missing",
      };
    }
    const tokenList = upsertedRows.map((row) => row.token);
    const rows = await this.prepareRenderablePaymentRows(
      upsertedRows,
      "subscription",
    );

    const sortedRows = rows
      .slice()
      .sort(
        (left, right) =>
          (normalizeNonNegativeInteger(left.payload_json.sort_order) ?? 100)
          - (normalizeNonNegativeInteger(right.payload_json.sort_order) ?? 100)
          || (normalizePositiveInteger(left.payload_json.subscription_days) ?? 0)
          - (normalizePositiveInteger(right.payload_json.subscription_days) ?? 0)
          || getSourceSortOrder(normalizePaymentSource(left.payment_source))
          - getSourceSortOrder(normalizePaymentSource(right.payment_source)),
      );
    const subscriptionOfferItems = groupOfferItems(sortedRows);
    const hasUsableSubscriptionOption = subscriptionOfferItems.some(
      (item) => item.payment_options.length > 0,
    );
    if (invoiceInputs.length > 0 && !hasUsableSubscriptionOption) {
      return {
        ...base,
        chat_id: chatId,
        scene_session_id: activeSceneSessionId,
        reason: "subscription_payment_options_missing",
      };
    }
    const sceneUnlockEntryTokenRows =
      canOfferSceneUnlock && activeSceneSessionId
        ? await this.buildSceneUnlockEntryTokenRows({
          chat_id: chatId,
          scene_session_id: activeSceneSessionId,
          turn_no: null,
          scene_turn_no: requestSceneTurnNo,
          target_message_id: null,
          subscription_active: subscriptionActive,
          scene_access_active: offerAccessStatus?.scene_access_active === true,
          ab_selection: abSelection,
        })
        : [];
    const hasSbpSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "sbp"));
    const hasStarsSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "stars"));
    const defaultPaymentSource: PaymentSource =
      hasSbpSubscriptionOption ? "sbp" : "stars";
    const offerMessageId =
      sortedRows
        .map((row) => normalizePositiveInteger(row.telegram_invoice_message_id))
        .find((value) => value != null)
      ?? null;
    const subscriptionPaymentToggleTokenRows =
      hasSbpSubscriptionOption && hasStarsSubscriptionOption
        ? (["stars", "sbp"] as const).map((source) =>
            buildPaymentUiTokenRow({
              action_kind: "subscription_payment_source_toggle",
              chat_id: chatId,
              scene_session_id: activeSceneSessionId,
              turn_no: null,
              scene_turn_no: null,
              target_message_id: offerMessageId,
              invoice_tokens: tokenList,
              offer_id: offerId,
              selected_payment_source: source,
              idempotency_key: `subscription-source-ui:${effectiveIdempotencyKey}`,
            }))
        : [];
    const paymentSourceToggleTokens = buildPaymentSourceToggleTokenMap(
      subscriptionPaymentToggleTokenRows,
    );
    const tokenRows = [
      ...sceneUnlockEntryTokenRows,
      ...subscriptionPaymentToggleTokenRows.map((row) => ({
        ...row,
        payload_json: {
          ...row.payload_json,
          payment_source_toggle_tokens: paymentSourceToggleTokens,
        },
      })),
    ];
    const tokenRowsInserted = tokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(tokenRows)
      : 0;

    return {
      ...base,
      operation: "subscription_offer_ready",
      chat_id: chatId,
      scene_session_id: activeSceneSessionId,
      offer_message_id: offerMessageId,
      offer_sent: false,
      offer_reused: offerMessageId != null,
      subscription_offer_reason: subscriptionOfferReason,
      turn_limit: turnLimit,
      turns_today: turnsToday,
      turn_limit_reset_text: turnLimitResetText,
      token_rows: tokenRows,
      token_rows_prepared: tokenRows.length,
      token_rows_inserted: tokenRowsInserted,
      text: offerText,
      free_balance_text: freeBalanceText,
      ab_test: abContext,
      subscription_offer_items: subscriptionOfferItems,
      selected_payment_source: defaultPaymentSource,
      payment_source_toggle_tokens: paymentSourceToggleTokens,
      payment_ui: buildPaymentUiCopy(),
      subscription_invoice_tokens: tokenList,
      reason:
        offerMessageId != null
          ? "subscription_offer_reused"
          : "subscription_offer_ready",
    };
  }

  private async evaluateFinalizePhotoEvent(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_photo_event");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const actionKind = normalizeString(input.action_kind);
    const accessMode = normalizeString(input.access_mode);
    const sceneSessionId = normalizeString(input.scene_session_id);
    const turnNo = normalizeNonNegativeInteger(input.turn_no);
    const sceneTurnNo = normalizeNonNegativeInteger(input.scene_turn_no);
    const mediaSignature = normalizeString(input.media_signature);
    const uuid = normalizeLowerString(input.selected_uuid);
    const panelMessageId =
      normalizePositiveInteger(input.panel_message_id)
      ?? normalizePositiveInteger(input.target_message_id);
    const fulfillmentToken = normalizeString(input.fulfillment_invoice_token);
    const isFreePhotoCredit =
      actionKind === "free_photo_unlock" && accessMode === "free_credit";
    const result = isFreePhotoCredit
      && sceneSessionId
      && turnNo != null
      && mediaSignature
      && uuid
      && panelMessageId
      && fulfillmentToken
      ? await this.repository.finalizeFreePhotoUnlock({
          token: fulfillmentToken,
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          turn_no: turnNo,
          scene_turn_no: sceneTurnNo,
          media_signature: mediaSignature,
          uuid,
          panel_message_id: panelMessageId,
        })
      : await this.repository.storePhotoEvent({
      chat_id: chatId,
      scene_session_id: sceneSessionId,
      turn_no: turnNo,
      scene_turn_no: sceneTurnNo,
      event_type: normalizeString(input.log_event_type),
      media_signature: mediaSignature,
      uuid,
      panel_message_id: panelMessageId,
      price_xtr: normalizeNonNegativeInteger(input.log_price_xtr) ?? 0,
      access_mode: accessMode,
      action_kind: actionKind,
      fulfillment_invoice_token: fulfillmentToken,
      next_invoice_token: normalizeString(input.invoice_token),
      next_invoice_link: normalizeString(input.invoice_link),
      price_required: normalizeNonNegativeInteger(input.price_required) ?? 0,
    });

    return {
      ...base,
      operation: "photo_event_stored",
      chat_id: result.chat_id,
      turn_no: result.n,
      scene_session_id: result.scene_session_id,
      scene_turn_no: result.scene_turn_no,
      media_signature: result.media_signature,
      panel_message_id: result.panel_message_id,
      price_required: result.price_required,
      stored_count: result.stored_count,
      invoice_rows_updated: result.invoice_rows_updated,
      reason: result.stored_count > 0 ? "photo_event_stored" : "photo_event_skipped",
    };
  }

  private async evaluateFinalizeSubscriptionOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_subscription_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    const offerMessageId = normalizePositiveInteger(input.offer_message_id);
    const tokens = (input.subscription_invoice_tokens ?? [])
      .map((token) => normalizeString(token))
      .filter((token): token is string => token != null);

    if (!chatId || !offerMessageId || tokens.length === 0) {
      return { ...base, reason: "finalize_subscription_offer_input_invalid" };
    }

    const updatedCount = await this.runRepositoryOperation(
      "subscription.storeOfferMessageId",
      {
        chat_id: chatId,
        input_is_array: Array.isArray(tokens),
        input_length: tokens.length,
      },
      () => this.repository.storeSubscriptionOfferMessageId(
        tokens,
        chatId,
        offerMessageId,
      ),
    );
    const abTest = parseJsonObject(input.ab_test) ?? {};
    const abTestKey = normalizeString(
      typeof abTest.key === "string" ? abTest.key : null,
    );
    const abTestStartsAt = normalizeString(
      typeof abTest.starts_at === "string" ? abTest.starts_at : null,
    );
    const abTestVersion = normalizeString(
      typeof abTest.version === "string" ? abTest.version : null,
    );
    const abTestVariant = normalizeString(
      typeof abTest.variant === "string" ? abTest.variant : null,
    );
    const deliveredAbTest =
      abTestKey && abTestStartsAt && abTestVersion && abTestVariant
        ? {
            key: abTestKey,
            starts_at: abTestStartsAt,
            version: abTestVersion,
            variant: abTestVariant,
          }
        : null;
    const abDeliveredEventsInserted = deliveredAbTest
      ? await this.runRepositoryOperation(
        "subscription.recordAbTestDelivered",
        {
          chat_id: chatId,
          payment_kind: null,
          sku: null,
          invoice_status: null,
        },
        () => this.repository.recordAbTestDelivered({
          chat_id: chatId,
          scene_session_id: normalizeString(input.scene_session_id),
          turn_no: normalizeNonNegativeInteger(input.turn_no),
          scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
          ab_test: deliveredAbTest,
        }),
      )
      : 0;

    return {
      ...base,
      operation: "subscription_offer_finalized",
      chat_id: chatId,
      offer_message_id: offerMessageId,
      subscription_invoice_tokens: tokens,
      offer_sent: updatedCount > 0,
      offer_reused: false,
      stored_count: updatedCount,
      inserted_count: abDeliveredEventsInserted,
      ab_test: deliveredAbTest,
      reason:
        updatedCount > 0
          ? "subscription_offer_message_stored"
          : "subscription_offer_message_already_stored",
    };
  }
}
