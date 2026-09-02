export type MediaCommerceRoute =
  | "prepare_offer"
  | "finalize_offer"
  | "feature_offer"
  | "callback"
  | "pre_checkout"
  | "payment_success"
  | "subscription_offer"
  | "finalize_photo_event"
  | "finalize_subscription_offer"
  | "noop";

export type MediaCommerceOperation =
  | "prepare_offer_none"
  | "prepare_offer_callback"
  | "prepare_offer_invoice_link"
  | "finalized_panel"
  | "edit_photo"
  | "edit_photo_with_invoice_link"
  | "answer_precheckout"
  | "subscription_activated"
  | "scene_access_activated"
  | "feature_offer_required"
  | "feature_fulfillment_required"
  | "subscription_offer_links_needed"
  | "subscription_offer_ready"
  | "subscription_offer_finalized"
  | "photo_event_stored"
  | "noop";

export type MediaSubscriptionOfferReason =
  | "subscription_command"
  | "daily_turn_limit";

export interface MediaButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface MediaReplyMarkup {
  inline_keyboard: MediaButton[][];
}

export interface CreatedInvoiceLink {
  token: string;
  invoice_link: string;
}

export interface InteractionTokenRow {
  token: string;
  kind: string;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  payload_json: Record<string, unknown>;
  status: string;
  action_kind: string | null;
  expires_at: string | null;
}

export interface InvoiceTokenPayload extends Record<string, unknown> {
  action_kind?: string | null;
  feature_key?: string | null;
  chat_id?: number | null;
  scene_session_id?: string | null;
  turn_no?: number | null;
  scene_turn_no?: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  media_signature?: string | null;
  target_message_id?: number | null;
  current_uuid?: string | null;
  base_price_xtr?: number | null;
  requested_action?: string | null;
  panel_text?: string | null;
  panel_entities_json?: unknown;
  subscription_days?: number | null;
  subscription_sku?: string | null;
  subscription_offer_reason?: MediaSubscriptionOfferReason | null;
  turn_limit?: number | null;
  turns_today?: number | null;
  turn_limit_reset_text?: string | null;
  idempotency_key?: string | null;
  original_amount_xtr?: number | null;
  promo_key?: string | null;
}

export interface MediaCommerceDecisionResponse {
  route: MediaCommerceRoute;
  operation: MediaCommerceOperation;
  interaction_mode: string | null;
  event_type: string | null;
  chat_id: number | null;
  scene_session_id?: string | null;
  turn_no?: number | null;
  scene_turn_no?: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  media_signature?: string | null;
  base_price_xtr?: number | null;
  price_required?: number | null;
  has_media_offer?: boolean;
  reply_markup?: MediaReplyMarkup | null;
  token_rows?: InteractionTokenRow[];
  token_rows_prepared?: number | null;
  token_rows_inserted?: number | null;
  invoice_kind?: "photo" | "subscription" | "feature" | null;
  invoice_sku?: string | null;
  invoice_amount?: number | null;
  original_invoice_amount?: number | null;
  promo_key?: string | null;
  invoice_title?: string | null;
  invoice_description?: string | null;
  invoice_label?: string | null;
  invoice_button_text?: string | null;
  invoice_payload_json?: InvoiceTokenPayload | null;
  invoice_token?: string | null;
  invoice_link?: string | null;
  needs_invoice_link?: boolean;
  callback_valid?: boolean;
  callback_answer_text?: string;
  callback_show_alert?: boolean;
  callback_query_id?: string | null;
  precheckout_ok?: boolean;
  precheckout_error?: string | null;
  target_message_id?: number | null;
  current_uuid?: string | null;
  photo_url?: string | null;
  selected_uuid?: string | null;
  caption_text?: string | null;
  caption_entities_json?: unknown;
  log_event_type?: string | null;
  access_mode?: string | null;
  log_price_xtr?: number | null;
  fulfillment_invoice_token?: string | null;
  payment_kind?: "photo" | "subscription" | "feature" | null;
  payment_token?: string | null;
  feature_key?: string | null;
  subscription_sku?: string | null;
  subscription_days?: number | null;
  subscription_active?: boolean;
  subscription_until?: string | null;
  active_scene_session_id?: string | null;
  scene_access_active?: boolean;
  subscription_offer_reason?: MediaSubscriptionOfferReason | null;
  turn_limit?: number | null;
  turns_today?: number | null;
  turn_limit_reset_text?: string | null;
  text?: string | null;
  offer_message_id?: number | null;
  offer_sent?: boolean;
  offer_reused?: boolean;
  missing_invoice_links?: boolean;
  missing_invoice_link_count?: number | null;
  missing_invoice_items?: Array<{
    token: string;
    telegram_invoice_payload: string;
    amount_xtr: number;
    action_kind?: string | null;
    payment_kind?: "subscription" | "feature" | null;
    feature_key?: string | null;
    scene_session_id?: string | null;
    sort_order?: number | null;
    original_amount_xtr?: number | null;
    promo_key?: string | null;
    invoice_title: string;
    invoice_description: string;
    invoice_label: string;
    invoice_button_text: string;
  }>;
  subscription_offer_items?: Array<{
    token: string;
    sku: string | null;
    action_kind?: string | null;
    payment_kind?: "subscription" | "feature" | null;
    feature_key?: string | null;
    scene_session_id?: string | null;
    sort_order?: number | null;
    subscription_days: number | null;
    invoice_link: string | null;
    amount_xtr: number;
    original_amount_xtr?: number | null;
    promo_key?: string | null;
    invoice_title: string;
    invoice_description: string;
    invoice_label: string;
    invoice_button_text: string;
  }>;
  subscription_invoice_tokens?: string[] | null;
  created_invoice_links?: CreatedInvoiceLink[] | null;
  stored_count?: number | null;
  invoice_rows_updated?: number | null;
  inserted_count?: number | null;
  reason?: string | null;
  source?: string | null;
  update_id?: number | null;
  idempotency_key?: string | null;
  callback_data?: string | null;
  inbound_message_id?: number | null;
  invoice_payload?: string | null;
  pre_checkout_query_id?: string | null;
  telegram_payment_charge_id?: string | null;
  provider_payment_charge_id?: string | null;
  payment_currency?: string | null;
  payment_total_amount?: number | null;
  panel_message_id?: number | null;
  panel_text?: string | null;
  panel_entities_json?: unknown[] | null;
}

export interface MediaOfferStats {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  base_price_xtr: number;
  should_offer: boolean;
  subscription_active: boolean;
  subscription_sku: string | null;
  subscription_until: string | null;
  delivered_in_scene: number;
  total_available: number;
  unseen_available: number;
  existing_panel_message_id: number | null;
  scene_access_active: boolean;
}

export interface LoadedCallbackToken {
  requested_token: string | null;
  token: string | null;
  kind: string | null;
  chat_id: number | null;
  scene_session_id: string | null;
  turn_no: number | null;
  payload_json: Record<string, unknown> | null;
  status: string | null;
  action_kind: string | null;
  expires_at: string | null;
  found: boolean;
}

export interface MediaUnlockedItem {
  uuid: string;
  photo_url: string;
  sort_order: number;
  first_unlocked_at?: string | null;
}

export interface MediaContext {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  current_uuid: string | null;
  target_message_id: number | null;
  base_price_xtr: number;
  action_kind: string | null;
  requested_action: string | null;
  invoice_token: string | null;
  force_deliver_after_payment: boolean;
  paid_access_mode: string | null;
  callback_valid: boolean;
  panel_text: string | null;
  panel_entities_json: unknown[] | null;
  subscription_active: boolean;
  subscription_sku: string | null;
  subscription_until: string | null;
  scene_access_active: boolean;
  delivered_in_scene: number;
  total_available: number;
  unseen_available: number;
  unlocked_items_json: unknown;
  next_unseen_json: unknown;
}

export interface StoredInvoiceToken {
  token: string;
  kind: string;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  payload_json: Record<string, unknown>;
  sku: string | null;
  amount_xtr: number | null;
  telegram_invoice_payload: string | null;
  expires_at: string | null;
  telegram_invoice_message_id: number | null;
  invoice_link: string | null;
  stored: boolean;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
  status?: string | null;
  action_kind?: string | null;
}

export interface LoadedInvoiceToken {
  requested_token: string | null;
  token: string | null;
  kind: string | null;
  chat_id: number | null;
  scene_session_id: string | null;
  turn_no: number | null;
  payload_json: Record<string, unknown> | null;
  status: string | null;
  action_kind: string | null;
  sku: string | null;
  amount_xtr: number | null;
  expires_at: string | null;
  telegram_invoice_message_id?: number | null;
  found: boolean;
}

export interface PaidInvoiceToken {
  token: string;
  kind: string | null;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  payload_json: Record<string, unknown> | null;
  status: string;
  action_kind: string | null;
  sku: string | null;
  amount_xtr: number | null;
  telegram_invoice_message_id: number | null;
}

export interface MediaFinalizeResult {
  chat_id: number | null;
  n: number | null;
  scene_session_id: string | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  price_required: number | null;
  panel_message_id: number | null;
  stored_count: number;
  invoice_rows_updated: number;
}
