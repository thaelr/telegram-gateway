export type RouterDecision =
  | "allow_scene"
  | "show_subscription_status"
  | "show_subscription_offer"
  | "show_terms_gate"
  | "noop";

export type RouterDomain =
  | "scene"
  | "command"
  | "interaction"
  | "reachability"
  | "noop";

export type RouterIntent =
  | "scene_message"
  | "scene_start"
  | "menu"
  | "new_scene"
  | "subscription"
  | "paysupport"
  | "terms_accept"
  | "newscene_confirm"
  | "character_select"
  | "character_back"
  | "scene_mode"
  | "commerce_callback"
  | "interaction_event"
  | "reachability_update"
  | "unknown_command"
  | "noop";

export type RouterAction =
  | "run_scene_core"
  | "show_character_gallery"
  | "show_character_mode_screen"
  | "show_scene_mode_choice"
  | "show_newscene_confirm"
  | "show_subscription_status"
  | "show_subscription_offer"
  | "show_terms_gate"
  | "send_paysupport_message"
  | "handle_terms_accept"
  | "handle_newscene_confirm"
  | "handle_character_back"
  | "handle_scene_mode"
  | "handle_commerce_interaction"
  | "update_reachability_state"
  | "ignore";

export interface AccessDecisionRequest {
  chat_id: number;
  source?: string | null;
  update_id?: number | null;
  source_user_id?: number | null;
  command?: string | null;
  event_type?: string | null;
  route_target?: string | null;
  message_type?: string | null;
  user_message?: string | null;
  inbound_message_id?: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  callback_data?: string | null;
  callback_query_id?: string | null;
  pre_checkout_query_id?: string | null;
  invoice_payload?: string | null;
  telegram_payment_charge_id?: string | null;
  provider_payment_charge_id?: string | null;
  payment_currency?: string | null;
  payment_total_amount?: number | null;
  reachability_status?: string | null;
  telegram_chat_status?: string | null;
}

export interface AccessDecisionResponse {
  decision: RouterDecision;
  domain: RouterDomain;
  intent: RouterIntent;
  action: RouterAction;
  allowed?: boolean;
  chat_id: number;
  source: string;
  update_id?: number | null;
  idempotency_key?: string | null;
  source_user_id?: number | null;
  command?: string | null;
  event_type?: string | null;
  route_target?: string | null;
  message_type?: string | null;
  user_message?: string | null;
  inbound_message_id?: number | null;
  callback_data?: string | null;
  callback_query_id?: string | null;
  pre_checkout_query_id?: string | null;
  invoice_payload?: string | null;
  telegram_payment_charge_id?: string | null;
  provider_payment_charge_id?: string | null;
  payment_currency?: string | null;
  payment_total_amount?: number | null;
  reachability_status?: string | null;
  telegram_chat_status?: string | null;
  terms_accepted_at?: string | null;
  subscription_active?: boolean;
  subscription_sku?: string | null;
  subscription_until?: string | null;
  turns_today?: number | null;
  turn_limit?: number | null;
  turn_limit_reset_text?: string | null;
  subscription_offer_reason?: "subscription_command" | "daily_turn_limit" | null;
  post_accept_intent?: "start" | "menu" | "subscription" | "paysupport" | null;
  reason?: string | null;
  text?: string | null;
  parse_mode?: "HTML" | null;
  disable_web_page_preview?: boolean;
  character_i?: number | null;
  scene_mode?: string | null;
  selected_character_i?: number | null;
  active_menu_screen?: string | null;
  active_menu_message_id?: number | null;
}

export interface AccessContext {
  chat_id: number;
  source: string | null;
  source_user_id: number | null;
  terms_accepted_at: string | null;
  subscription_sku: string | null;
  subscription_until: string | null;
  subscription_active: boolean;
  turns_today: number;
  selected_character_i: number | null;
  active_menu_screen: string | null;
  active_menu_message_id: number | null;
}
