import { config } from "../config.js";
import type {
  LoadedInvoiceToken,
  PaidInvoiceToken,
} from "../mediaCommerceTypes.js";
import {
  isExpired,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeString,
  parseJsonObject,
} from "./utils.js";

const SUPPORTED_PAYMENT_ACTIONS = new Set([
  "subscription_payment",
  "photo_payment",
  "feature_payment",
]);

const SUPPORTED_FEATURE_KEYS = new Set(["fast_scene_skip"]);

export const INVOICE_PAYLOAD_KIND = "invoice_payload";

export type PrecheckoutValidationResult = {
  ok: boolean;
  error: string | null;
  reason: string;
  action: ResolvedInvoiceAction | null;
};

export type ResolvedInvoiceAction =
  | {
    action_kind: "subscription_payment";
    payment_kind: "subscription";
    feature_key: null;
    subscription_days: number;
    subscription_sku: string | null;
  }
  | {
    action_kind: "photo_payment";
    payment_kind: "photo";
    feature_key: null;
    subscription_days: 0;
    subscription_sku: null;
  }
  | {
    action_kind: "feature_payment";
    payment_kind: "feature";
    feature_key: "fast_scene_skip";
    subscription_days: 0;
    subscription_sku: null;
  };

export function normalizePaymentActionKind(
  value: string | null | undefined,
): "subscription_payment" | "photo_payment" | "feature_payment" | null {
  const normalized = normalizeString(value);
  if (!normalized || !SUPPORTED_PAYMENT_ACTIONS.has(normalized)) {
    return null;
  }
  return normalized as "subscription_payment" | "photo_payment" | "feature_payment";
}

export function normalizeFeatureKey(
  value: string | null | undefined,
): "fast_scene_skip" | null {
  const normalized = normalizeString(value);
  if (!normalized || !SUPPORTED_FEATURE_KEYS.has(normalized)) {
    return null;
  }
  return normalized as "fast_scene_skip";
}

export function hasExpectedPaymentDetails(
  amountXtr: number | null | undefined,
  currency: string | null | undefined,
  totalAmount: number | null | undefined,
): boolean {
  return (
    normalizeString(currency) === config.MEDIA_PAYMENT_CURRENCY
    && normalizeNonNegativeInteger(totalAmount) != null
    && normalizeNonNegativeInteger(totalAmount) === normalizeNonNegativeInteger(amountXtr)
  );
}

export function resolveInvoiceAction(
  payload: Record<string, unknown>,
  rowActionKind: string | null | undefined,
): ResolvedInvoiceAction | null {
  const payloadActionKind = normalizePaymentActionKind(
    typeof payload.action_kind === "string" ? payload.action_kind : null,
  );
  const normalizedRowActionKind = normalizePaymentActionKind(rowActionKind);

  if (
    normalizedRowActionKind
    && payloadActionKind
    && normalizedRowActionKind !== payloadActionKind
  ) {
    return null;
  }

  const actionKind = normalizedRowActionKind ?? payloadActionKind;
  if (!actionKind) {
    return null;
  }

  if (actionKind === "photo_payment") {
    return {
      action_kind: actionKind,
      payment_kind: "photo",
      feature_key: null,
      subscription_days: 0,
      subscription_sku: null,
    };
  }

  if (actionKind === "subscription_payment") {
    return {
      action_kind: actionKind,
      payment_kind: "subscription",
      feature_key: null,
      subscription_days: normalizePositiveInteger(payload.subscription_days) ?? 0,
      subscription_sku: normalizeString(
        typeof payload.subscription_sku === "string"
          ? payload.subscription_sku
          : null,
      ),
    };
  }

  const featureKey = normalizeFeatureKey(
    typeof payload.feature_key === "string" ? payload.feature_key : null,
  );
  if (!featureKey) {
    return null;
  }

  return {
    action_kind: actionKind,
    payment_kind: "feature",
    feature_key: featureKey,
    subscription_days: 0,
    subscription_sku: null,
  };
}

export function resolveInvoiceActionResult(
  payload: Record<string, unknown>,
  rowActionKind: string | null | undefined,
): { action: ResolvedInvoiceAction | null; reason: string | null } {
  const rawPayloadActionKind = normalizeString(
    typeof payload.action_kind === "string" ? payload.action_kind : null,
  );
  const payloadActionKind = normalizePaymentActionKind(rawPayloadActionKind);
  const rowActionKindNormalized = normalizePaymentActionKind(rowActionKind);

  if (rawPayloadActionKind && !payloadActionKind) {
    return { action: null, reason: "invoice_action_kind_invalid" };
  }
  if (normalizeString(rowActionKind) && !rowActionKindNormalized) {
    return { action: null, reason: "invoice_action_kind_invalid" };
  }
  if (!rowActionKindNormalized) {
    return { action: null, reason: "invoice_action_kind_invalid" };
  }
  if (
    rowActionKindNormalized
    && payloadActionKind
    && rowActionKindNormalized !== payloadActionKind
  ) {
    return { action: null, reason: "invoice_action_kind_mismatch" };
  }

  const action = resolveInvoiceAction(payload, rowActionKind);
  if (!action) {
    if ((rowActionKindNormalized ?? payloadActionKind) === "feature_payment") {
      return { action: null, reason: "feature_key_invalid" };
    }
    return { action: null, reason: "invoice_action_kind_invalid" };
  }

  return { action, reason: null };
}

export function toPaidInvoiceToken(
  row: LoadedInvoiceToken,
): PaidInvoiceToken | null {
  const token = normalizeString(row.token);
  const chatId = normalizePositiveInteger(row.chat_id);
  if (!token || !chatId) {
    return null;
  }

  return {
    token,
    kind: normalizeString(row.kind),
    chat_id: chatId,
    scene_session_id: normalizeString(row.scene_session_id),
    turn_no: normalizeNonNegativeInteger(row.turn_no),
    payload_json: parseJsonObject(row.payload_json) ?? {},
    status: normalizeString(row.status) ?? "paid",
    action_kind: normalizeString(row.action_kind),
    sku: normalizeString(row.sku),
    amount_xtr: normalizeNonNegativeInteger(row.amount_xtr),
    telegram_invoice_message_id:
      normalizePositiveInteger(row.telegram_invoice_message_id) ?? null,
  };
}

export function validatePrecheckout(
  tokenRow: LoadedInvoiceToken | null | undefined,
  paymentCurrency: string | null | undefined,
  paymentTotalAmount: number | null | undefined,
): PrecheckoutValidationResult {
  const payload = parseJsonObject(tokenRow?.payload_json) ?? {};
  const actionResolution = resolveInvoiceActionResult(
    payload,
    tokenRow?.action_kind,
  );

  if (!tokenRow?.found || !tokenRow.token) {
    return {
      ok: false,
      error: "Счёт больше не актуален.",
      reason: "invoice_not_found",
      action: actionResolution.action,
    };
  }

  if (normalizeString(tokenRow.kind) !== INVOICE_PAYLOAD_KIND) {
    return {
      ok: false,
      error: "Счёт больше не актуален.",
      reason: "invoice_kind_invalid",
      action: actionResolution.action,
    };
  }

  if (actionResolution.reason != null) {
    return {
      ok: false,
      error: "Этот счёт больше не поддерживается.",
      reason: actionResolution.reason,
      action: actionResolution.action,
    };
  }

  if (isExpired(tokenRow.expires_at)) {
    return {
      ok: false,
      error: "Срок оплаты истёк.",
      reason: "invoice_expired",
      action: actionResolution.action,
    };
  }

  if (normalizeString(tokenRow.status) !== "invoice_sent") {
    return {
      ok: false,
      error: "Этот счёт уже недоступен.",
      reason: "invoice_status_invalid",
      action: actionResolution.action,
    };
  }

  if (
    !hasExpectedPaymentDetails(
      tokenRow.amount_xtr,
      normalizeString(paymentCurrency),
      normalizeNonNegativeInteger(paymentTotalAmount),
    )
  ) {
    return {
      ok: false,
      error: "Сумма счёта больше не совпадает.",
      reason: "payment_details_mismatch",
      action: actionResolution.action,
    };
  }

  return {
    ok: true,
    error: null,
    reason: "precheckout_allowed",
    action: actionResolution.action,
  };
}
