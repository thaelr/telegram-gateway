import { z } from "zod";

export const mediaCommerceRequestSchema = z.object({
  interaction_mode: z.string().trim().nullable().optional(),
  event_type: z.string().trim().nullable().optional(),
  chat_id: z.coerce.number().int().positive().nullable().optional(),
  scene_session_id: z.string().trim().nullable().optional(),
  turn_no: z.coerce.number().int().nonnegative().nullable().optional(),
  scene_turn_no: z.coerce.number().int().nonnegative().nullable().optional(),
  character_i: z.coerce.number().int().positive().nullable().optional(),
  scene_mode: z.string().trim().nullable().optional(),
  media_signature: z.string().trim().nullable().optional(),
  base_price_xtr: z.coerce.number().int().nonnegative().nullable().optional(),
  should_offer: z.boolean().nullable().optional(),
  panel_message_id: z.coerce.number().int().positive().nullable().optional(),
  price_required: z.coerce.number().int().nonnegative().nullable().optional(),
  has_media_offer: z.boolean().nullable().optional(),
  reply_markup: z.unknown().nullable().optional(),
  token_rows_prepared: z.coerce.number().int().nonnegative().nullable().optional(),
  callback_data: z.string().trim().nullable().optional(),
  callback_query_id: z.string().trim().nullable().optional(),
  inbound_message_id: z.coerce.number().int().positive().nullable().optional(),
  panel_text: z.string().nullable().optional(),
  panel_entities_json: z.unknown().nullable().optional(),
  raw_update: z.unknown().nullable().optional(),
  invoice_payload: z.string().trim().nullable().optional(),
  pre_checkout_query_id: z.string().trim().nullable().optional(),
  telegram_payment_charge_id: z.string().trim().nullable().optional(),
  provider_payment_charge_id: z.string().trim().nullable().optional(),
  payment_currency: z.string().trim().nullable().optional(),
  payment_total_amount: z.coerce.number().int().nonnegative().nullable().optional(),
  feature_key: z.string().trim().nullable().optional(),
  invoice_link: z.string().trim().nullable().optional(),
  invoice_token: z.string().trim().nullable().optional(),
  fulfillment_invoice_token: z.string().trim().nullable().optional(),
  target_message_id: z.coerce.number().int().positive().nullable().optional(),
  current_uuid: z.string().trim().nullable().optional(),
  action_kind: z.string().trim().nullable().optional(),
  requested_action: z.string().trim().nullable().optional(),
  force_deliver_after_payment: z.boolean().nullable().optional(),
  paid_access_mode: z.string().trim().nullable().optional(),
  log_event_type: z.string().trim().nullable().optional(),
  access_mode: z.string().trim().nullable().optional(),
  log_price_xtr: z.coerce.number().int().nonnegative().nullable().optional(),
  photo_url: z.string().trim().nullable().optional(),
  selected_uuid: z.string().trim().nullable().optional(),
  caption_text: z.string().nullable().optional(),
  caption_entities_json: z.unknown().nullable().optional(),
  subscription_offer_reason: z
    .enum(["subscription_command", "daily_turn_limit"])
    .nullable()
    .optional(),
  turn_limit: z.coerce.number().int().positive().nullable().optional(),
  turns_today: z.coerce.number().int().nonnegative().nullable().optional(),
  turn_limit_reset_text: z.string().trim().nullable().optional(),
  idempotency_key: z.string().trim().nullable().optional(),
  created_invoice_links: z
    .array(
      z.object({
        token: z.string().trim().min(1),
        invoice_link: z.string().trim().min(1),
      }),
    )
    .nullable()
    .optional(),
  offer_message_id: z.coerce.number().int().positive().nullable().optional(),
  subscription_invoice_tokens: z
    .array(z.string().trim().min(1))
    .nullable()
    .optional(),
  source: z.string().trim().nullable().optional(),
  update_id: z.coerce.number().int().positive().nullable().optional(),
});

export type MediaCommerceDecisionRequest =
  z.infer<typeof mediaCommerceRequestSchema>;
