import type { InvoiceTokenPayload } from '../../mediaCommerceTypes.js';
import type { UpsertInvoiceTokenInput } from '../../mediaCommerceRepository/shared.js';
import { buildRandomToken, buildTelegramInvoicePayload, normalizeString } from '../../mediaCommerce/utils.js';

export function buildPhotoInvoiceInput(input: {
  token?: string | null;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  target_message_id: number | null;
  current_uuid: string | null;
  base_price_xtr: number;
  amount_xtr: number;
  original_amount_xtr?: number | null;
  promo_key?: string | null;
  invoice_sku: string;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
  payload_json: InvoiceTokenPayload;
}): UpsertInvoiceTokenInput {
  const token = normalizeString(input.token) ?? buildRandomToken("inv");

  return {
    token,
    kind: "invoice_payload",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    payload_json: {
      ...input.payload_json,
      original_amount_xtr: input.original_amount_xtr ?? input.amount_xtr,
      promo_key: input.promo_key ?? null,
    },
    action_kind: "photo_payment",
    sku: input.invoice_sku,
    payment_source: "stars",
    amount: input.amount_xtr,
    currency: "XTR",
    amount_xtr: input.amount_xtr,
    telegram_invoice_payload: buildTelegramInvoicePayload(token),
    checkout_url: null,
    external_payment_id: null,
    expires_at: null,
    invoice_title: input.invoice_title,
    invoice_description: input.invoice_description,
    invoice_label: input.invoice_label,
    invoice_button_text: input.invoice_button_text,
  };
}
