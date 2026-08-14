import type {
  MediaButton,
  MediaCommerceDecisionRequest,
  MediaCommerceDecisionResponse,
  MediaReplyMarkup,
  MediaCommerceRoute,
} from "../mediaCommerceTypes.js";
import { normalizeFeatureKey } from "./paymentFlow.js";
import {
  normalizeLowerString,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeString,
  parseJsonArray,
  parseJsonObject,
} from "./utils.js";

export function cloneReplyMarkup(
  value: MediaReplyMarkup | Record<string, unknown> | null | undefined,
): MediaReplyMarkup | null {
  const objectValue = parseJsonObject(value) ?? null;
  if (!objectValue) return null;
  const keyboardRaw = objectValue.inline_keyboard;
  if (!Array.isArray(keyboardRaw)) {
    return { inline_keyboard: [] };
  }

  const inline_keyboard: MediaButton[][] = keyboardRaw
    .map((row) => {
      if (!Array.isArray(row)) return [];
      return row
        .map((button) => {
          const source = parseJsonObject(button);
          const text = normalizeString(String(source?.text ?? ""));
          if (!source || !text) return null;
          const callbackData = normalizeString(
            typeof source.callback_data === "string"
              ? source.callback_data
              : null,
          );
          const url = normalizeString(
            typeof source.url === "string" ? source.url : null,
          );
          return {
            text,
            ...(callbackData ? { callback_data: callbackData } : {}),
            ...(url ? { url } : {}),
          };
        })
        .filter((button): button is MediaButton => button != null);
    })
    .filter((row) => row.length > 0);

  return { inline_keyboard };
}

export function appendInvoiceButton(
  markup: MediaReplyMarkup | null,
  text: string,
  url: string,
): MediaReplyMarkup {
  const base = markup ? cloneReplyMarkup(markup) : { inline_keyboard: [] };
  const inline_keyboard = base?.inline_keyboard ?? [];
  inline_keyboard.push([{ text, url }]);
  return { inline_keyboard };
}

export function buildBaseResponse(
  input: MediaCommerceDecisionRequest,
  route: MediaCommerceRoute,
): MediaCommerceDecisionResponse {
  return {
    route,
    operation: "noop",
    interaction_mode: normalizeString(input.interaction_mode),
    event_type: normalizeString(input.event_type),
    chat_id: normalizePositiveInteger(input.chat_id),
    scene_session_id: normalizeString(input.scene_session_id),
    turn_no: normalizeNonNegativeInteger(input.turn_no),
    scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
    character_i: normalizePositiveInteger(input.character_i),
    scene_mode: normalizeString(input.scene_mode),
    media_signature: normalizeString(input.media_signature),
    base_price_xtr: normalizePositiveInteger(input.base_price_xtr),
    price_required: normalizeNonNegativeInteger(input.price_required),
    callback_query_id: normalizeString(input.callback_query_id),
    callback_data: normalizeString(input.callback_data),
    inbound_message_id: normalizePositiveInteger(input.inbound_message_id),
    invoice_payload: normalizeString(input.invoice_payload),
    pre_checkout_query_id: normalizeString(input.pre_checkout_query_id),
    telegram_payment_charge_id: normalizeString(input.telegram_payment_charge_id),
    provider_payment_charge_id: normalizeString(input.provider_payment_charge_id),
    payment_currency: normalizeString(input.payment_currency),
    payment_total_amount: normalizeNonNegativeInteger(input.payment_total_amount),
    feature_key: normalizeFeatureKey(input.feature_key),
    invoice_link: normalizeString(input.invoice_link),
    invoice_token: normalizeString(input.invoice_token),
    fulfillment_invoice_token: normalizeString(input.fulfillment_invoice_token),
    target_message_id: normalizePositiveInteger(input.target_message_id),
    current_uuid: normalizeLowerString(input.current_uuid),
    log_event_type: normalizeString(input.log_event_type),
    access_mode: normalizeString(input.access_mode),
    log_price_xtr: normalizeNonNegativeInteger(input.log_price_xtr) ?? 0,
    photo_url: normalizeString(input.photo_url),
    selected_uuid: normalizeLowerString(input.selected_uuid),
    caption_text: normalizeString(input.caption_text),
    caption_entities_json: parseJsonArray(input.caption_entities_json),
    subscription_offer_reason:
      input.subscription_offer_reason ?? null,
    turn_limit: normalizePositiveInteger(input.turn_limit),
    turns_today: normalizeNonNegativeInteger(input.turns_today),
    turn_limit_reset_text: normalizeString(input.turn_limit_reset_text),
    idempotency_key: normalizeString(input.idempotency_key),
    offer_message_id: normalizePositiveInteger(input.offer_message_id),
    created_invoice_links: input.created_invoice_links ?? null,
    subscription_invoice_tokens: input.subscription_invoice_tokens ?? null,
    source: normalizeString(input.source),
    update_id: normalizePositiveInteger(input.update_id),
    panel_message_id: normalizePositiveInteger(input.panel_message_id),
    panel_text: normalizeString(input.panel_text),
    panel_entities_json: parseJsonArray(input.panel_entities_json),
  };
}

