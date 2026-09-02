import { config } from "../config.js";
import type { MediaActionPlan } from "../config.js";
import type {
  InvoiceTokenPayload,
  MediaReplyMarkup,
  MediaSubscriptionOfferReason,
  StoredInvoiceToken,
} from "../mediaCommerceTypes.js";
import { INVOICE_TTL_MS, normalizePositiveInteger, normalizeString } from "./utils.js";

export function buildSubscriptionOfferText(
  reason: MediaSubscriptionOfferReason | null,
  turnLimit: number,
  turnsToday: number,
  resetText: string,
): string {
  if (reason === "daily_turn_limit") {
    return config.TELEGRAM_UX_COPY_JSON.subscription.daily_limit_offer
      .replaceAll("{turns_today}", String(turnsToday))
      .replaceAll("{turn_limit}", String(turnLimit))
      .replaceAll("{turn_limit_reset_text}", resetText);
  }

  return config.TELEGRAM_UX_COPY_JSON.subscription.command_offer
    .replaceAll("{turns_today}", String(turnsToday))
    .replaceAll("{turn_limit}", String(turnLimit))
    .replaceAll("{turn_limit_reset_text}", resetText);
}

export function buildSubscriptionOfferMessage(rows: StoredInvoiceToken[]): {
  text: string;
  reply_markup: MediaReplyMarkup;
  offer_message_id: number | null;
  subscription_invoice_tokens: string[];
  offer_reason: MediaSubscriptionOfferReason | null;
  turn_limit: number;
  turns_today: number;
  turn_limit_reset_text: string;
  offer_items: Array<{
    token: string;
    sku: string | null;
    action_kind: string | null;
    payment_kind: "subscription" | "feature" | null;
    feature_key: string | null;
    scene_session_id: string | null;
    sort_order: number | null;
    subscription_days: number | null;
    invoice_link: string | null;
    amount_xtr: number;
    original_amount_xtr: number | null;
    promo_key: string | null;
    invoice_title: string;
    invoice_description: string;
    invoice_label: string;
    invoice_button_text: string;
  }>;
} {
  const sortedRows = rows
    .slice()
    .sort(
      (left, right) =>
        Number(left.payload_json.sort_order ?? 100)
        - Number(right.payload_json.sort_order ?? 100)
        || Number(left.payload_json.subscription_days ?? 0)
        - Number(right.payload_json.subscription_days ?? 0),
    );

  const first = sortedRows[0];
  const offerReason =
    first?.payload_json.subscription_offer_reason === "daily_turn_limit"
      ? "daily_turn_limit"
      : first?.payload_json.subscription_offer_reason === "subscription_command"
        ? "subscription_command"
        : null;
  const turnLimit = Number(first?.payload_json.turn_limit ?? config.TURN_LIMIT);
  const turnsToday = Number(first?.payload_json.turns_today ?? turnLimit);
  const turnLimitResetText = String(
    first?.payload_json.turn_limit_reset_text ?? config.TURN_LIMIT_RESET_TEXT,
  );
  const offerMessageId =
    sortedRows
      .map((row) => normalizePositiveInteger(row.telegram_invoice_message_id))
      .find((value) => value != null)
    ?? null;
  const keyboard = sortedRows
    .map((row) => {
      const url = normalizeString(row.invoice_link);
      const text = normalizeString(row.invoice_button_text) ?? "text";
      return url ? [{ text, url }] : [];
    })
    .filter((row) => row.length > 0);
  const offerItems = sortedRows.map((row) => ({
    token: row.token,
    sku: row.sku,
    action_kind:
      typeof row.payload_json.action_kind === "string"
        ? row.payload_json.action_kind
        : row.action_kind ?? null,
    payment_kind: (
      row.payload_json.action_kind === "subscription_payment"
        ? "subscription"
        : row.payload_json.action_kind === "feature_payment"
          ? "feature"
          : null
    ) as "subscription" | "feature" | null,
    feature_key:
      typeof row.payload_json.feature_key === "string"
        ? row.payload_json.feature_key
        : null,
    scene_session_id: row.scene_session_id,
    sort_order: Number(row.payload_json.sort_order ?? 100),
    subscription_days: Number(row.payload_json.subscription_days ?? 0) || null,
    invoice_link: normalizeString(row.invoice_link),
    amount_xtr: Number(row.amount_xtr ?? 0),
    original_amount_xtr:
      normalizePositiveInteger(row.payload_json.original_amount_xtr) ?? null,
    promo_key:
      normalizeString(
        typeof row.payload_json.promo_key === "string"
          ? row.payload_json.promo_key
          : null,
      ) ?? null,
    invoice_title: row.invoice_title,
    invoice_description: row.invoice_description,
    invoice_label: row.invoice_label,
    invoice_button_text: row.invoice_button_text,
  }));

  return {
    text: buildSubscriptionOfferText(
      offerReason,
      turnLimit,
      turnsToday,
      turnLimitResetText,
    ),
    reply_markup: { inline_keyboard: keyboard },
    offer_message_id: offerMessageId,
    subscription_invoice_tokens: sortedRows.map((row) => row.token),
    offer_reason: offerReason,
    turn_limit: turnLimit,
    turns_today: turnsToday,
    turn_limit_reset_text: turnLimitResetText,
    offer_items: offerItems,
  };
}

export function buildSceneUnlockInvoiceInput(input: {
  chat_id: number;
  scene_session_id: string;
  idempotency_key: string;
  subscription_offer_reason?: MediaSubscriptionOfferReason | null;
  turn_limit?: number | null;
  turns_today?: number | null;
  turn_limit_reset_text?: string | null;
  target_message_id?: number | null;
  plan: MediaActionPlan & {
    original_amount_xtr?: number | null;
    promo_key?: string | null;
  };
}) {
  const payloadJson: InvoiceTokenPayload = {
    action_kind: "feature_payment",
    feature_key: "scene_unlock",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: null,
    scene_turn_no: null,
    media_signature: null,
    target_message_id: input.target_message_id ?? null,
    current_uuid: null,
    base_price_xtr: 0,
    requested_action: "scene_unlock_purchase",
    subscription_offer_reason: input.subscription_offer_reason ?? null,
    turn_limit: input.turn_limit ?? config.TURN_LIMIT,
    turns_today: input.turns_today ?? null,
    turn_limit_reset_text:
      input.turn_limit_reset_text ?? config.TURN_LIMIT_RESET_TEXT,
    idempotency_key: input.idempotency_key,
    original_amount_xtr: input.plan.original_amount_xtr ?? input.plan.amount_xtr,
    promo_key: input.plan.promo_key ?? null,
    sort_order: 0,
  };
  const token = `${input.idempotency_key}:${input.scene_session_id}:${input.plan.sku}`;

  return {
    token,
    kind: "invoice_payload",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: null,
    scene_turn_no: null,
    payload_json: payloadJson,
    action_kind: "feature_payment",
    sku: input.plan.sku,
    amount_xtr: input.plan.amount_xtr,
    telegram_invoice_payload: token,
    expires_at: new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
    invoice_title: input.plan.title,
    invoice_description: input.plan.description,
    invoice_label: input.plan.label,
    invoice_button_text: input.plan.button_text,
  };
}

export function mergeStoredRowsWithMetadata(
  storedRows: StoredInvoiceToken[],
  sourceRows: StoredInvoiceToken[],
): StoredInvoiceToken[] {
  const metadataByToken = new Map(
    sourceRows.map((row) => [row.token, row]),
  );

  return storedRows.map((row) => {
    const source = metadataByToken.get(row.token);
    return {
      ...row,
      scene_turn_no: source?.scene_turn_no ?? row.scene_turn_no,
      stored: source?.stored ?? row.stored,
      invoice_title: source?.invoice_title ?? row.invoice_title,
      invoice_description:
        source?.invoice_description ?? row.invoice_description,
      invoice_label: source?.invoice_label ?? row.invoice_label,
      invoice_button_text:
        source?.invoice_button_text ?? row.invoice_button_text,
    };
  });
}

export function buildSubscriptionInvoiceInput(input: {
  chat_id: number;
  idempotency_key: string;
  subscription_offer_reason: MediaSubscriptionOfferReason | null;
  turn_limit: number;
  turns_today: number;
  turn_limit_reset_text: string;
  sort_order: number;
  plan: {
    sku: string;
    days: number;
    amount_xtr: number;
    title: string;
    description: string;
    label: string;
    button_text: string;
    original_amount_xtr?: number | null;
    promo_key?: string | null;
  };
}) {
  const payloadJson: InvoiceTokenPayload = {
    action_kind: "subscription_payment",
    chat_id: input.chat_id,
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    media_signature: null,
    target_message_id: null,
    current_uuid: null,
    base_price_xtr: 0,
    requested_action: "subscription_purchase",
    subscription_offer_reason: input.subscription_offer_reason,
    turn_limit: input.turn_limit,
    turns_today: input.turns_today,
    turn_limit_reset_text: input.turn_limit_reset_text,
    idempotency_key: input.idempotency_key,
    subscription_days: input.plan.days,
    subscription_sku: input.plan.sku,
    original_amount_xtr: input.plan.original_amount_xtr ?? input.plan.amount_xtr,
    promo_key: input.plan.promo_key ?? null,
    sort_order: input.sort_order,
  };
  const token = `${input.idempotency_key}:${input.plan.sku}`;

  return {
    token,
    kind: "invoice_payload",
    chat_id: input.chat_id,
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    payload_json: payloadJson,
    action_kind: "subscription_payment",
    sku: input.plan.sku,
    amount_xtr: input.plan.amount_xtr,
    telegram_invoice_payload: token,
    expires_at: new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
    invoice_title: input.plan.title,
    invoice_description: input.plan.description,
    invoice_label: input.plan.label,
    invoice_button_text: input.plan.button_text,
  };
}
