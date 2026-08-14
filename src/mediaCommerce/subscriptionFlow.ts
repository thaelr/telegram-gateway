import { config } from "../config.js";
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
    return `Упс! Похоже, на сегодня бесплатный лимит исчерпан — ${turnsToday} из ${turnLimit} сообщений использованы.\n\nОн обновится после ${resetText}.\n\nНе хочешь ждать — подписка снимет лимит на диалог и откроет безлимитные генерации.\n\nВыбери подходящий план:`;
  }

  return "Подписка снимает лимит на диалог и открывает безлимитный доступ к генерациям.\n\nВыбери подходящий план:";
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
} {
  const sortedRows = rows
    .slice()
    .sort(
      (left, right) =>
        Number(left.payload_json.subscription_days ?? 0)
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
      const text = normalizeString(row.invoice_button_text) ?? "Оплатить";
      return url ? [{ text, url }] : [];
    })
    .filter((row) => row.length > 0);

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
  plan: {
    sku: string;
    days: number;
    amount_xtr: number;
    title: string;
    description: string;
    label: string;
    button_text: string;
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
