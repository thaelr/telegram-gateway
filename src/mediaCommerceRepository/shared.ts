import { sql } from "../db.js";
import type { MediaContext, MediaFinalizeResult, MediaOfferStats } from "../mediaCommerceTypes.js";

export type QueryClient = typeof sql;

export type CatalogRow = {
  uuid: string | null;
  bucket_name: string | null;
  storage_path: string | null;
  sort_order: number | null;
  first_unlocked_at?: string | null;
};

export type SceneTurnRef = {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
};

export type MediaSceneLookupInput = SceneTurnRef & {
  media_signature: string | null;
  base_price_xtr: number;
};

export type LoadOfferStatsInput = MediaSceneLookupInput & {
  should_offer: boolean;
};

export type UpsertInvoiceTokenInput = SceneTurnRef & {
  token: string;
  kind: string;
  payload_json: Record<string, unknown>;
  action_kind: string;
  sku: string;
  amount_xtr: number;
  telegram_invoice_payload: string;
  expires_at: string;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
};

export type StorePanelInput = SceneTurnRef & {
  media_signature: string | null;
  panel_message_id: number | null;
  price_xtr: number;
  invoice_token: string | null;
  invoice_link: string | null;
  panel_text: string | null;
  panel_entities_json: unknown[];
};

export type LoadMediaContextInput = MediaSceneLookupInput & {
  current_uuid: string | null;
  target_message_id: number | null;
  action_kind: string | null;
  requested_action: string | null;
  invoice_token: string | null;
  force_deliver_after_payment: boolean;
  paid_access_mode: string | null;
  callback_valid: boolean;
  panel_text: string | null;
  panel_entities_json: unknown[];
};

export type StorePrecheckoutResultInput = {
  token: string;
  pre_checkout_query_id: string | null;
  ok: boolean;
  error_message: string | null;
};

export type MarkInvoicePaidInput = {
  token: string;
  chat_id: number;
  expected_kind: string;
  expected_action_kind: string;
  telegram_payment_charge_id: string | null;
  provider_payment_charge_id: string | null;
  payment_currency: string | null;
  payment_total_amount: number | null;
};

export type ActivateSubscriptionInput = {
  payment_token: string;
  chat_id: number;
  subscription_sku: string | null;
  subscription_days: number;
};

export type StorePhotoEventInput = SceneTurnRef & {
  event_type: string | null;
  media_signature: string | null;
  uuid: string | null;
  panel_message_id: number | null;
  price_xtr: number;
  access_mode: string | null;
  action_kind: string | null;
  fulfillment_invoice_token: string | null;
  next_invoice_token: string | null;
  next_invoice_link: string | null;
  price_required: number;
};

export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function buildEmptyOfferStats(input: LoadOfferStatsInput): MediaOfferStats {
  return {
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    media_signature: input.media_signature,
    base_price_xtr: input.base_price_xtr,
    should_offer: input.should_offer,
    subscription_active: false,
    subscription_sku: null,
    subscription_until: null,
    delivered_in_scene: 0,
    total_available: 0,
    unseen_available: 0,
    existing_panel_message_id: null,
  };
}

export function buildEmptyMediaContext(input: LoadMediaContextInput): MediaContext {
  return {
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    media_signature: input.media_signature,
    current_uuid: input.current_uuid,
    target_message_id: input.target_message_id,
    base_price_xtr: input.base_price_xtr,
    action_kind: input.action_kind,
    requested_action: input.requested_action,
    invoice_token: input.invoice_token,
    force_deliver_after_payment: input.force_deliver_after_payment,
    paid_access_mode: input.paid_access_mode,
    callback_valid: input.callback_valid,
    panel_text: input.panel_text,
    panel_entities_json: input.panel_entities_json,
    subscription_active: false,
    subscription_sku: null,
    subscription_until: null,
    delivered_in_scene: 0,
    total_available: 0,
    unseen_available: 0,
    unlocked_items_json: [],
    next_unseen_json: null,
  };
}

export function buildMediaFinalizeFallback(
  input: Pick<
    MediaFinalizeResult,
    | "chat_id"
    | "n"
    | "scene_session_id"
    | "scene_turn_no"
    | "media_signature"
    | "price_required"
    | "panel_message_id"
  >,
): MediaFinalizeResult {
  return {
    ...input,
    stored_count: 0,
    invoice_rows_updated: 0,
  };
}

const UTC_TIMESTAMP_MASK = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

export function sqlJsonObject(expr: string): string {
  return `COALESCE(${expr}, '{}'::jsonb)`;
}

export function sqlTrimmedText(expr: string): string {
  return `NULLIF(BTRIM(${expr}), '')`;
}

export function sqlTrimmedJsonText(jsonExpr: string, key: string): string {
  return sqlTrimmedText(`${jsonExpr} ->> '${key}'`);
}

export function sqlUtcTimestamp(expr: string, alias: string): string {
  return `CASE
    WHEN ${expr} IS NULL THEN NULL
    ELSE to_char(${expr} AT TIME ZONE 'UTC', '${UTC_TIMESTAMP_MASK}')
  END AS ${alias}`;
}

export function buildJsonTextRowsCte(paramRef: string): string {
  return `
      payload AS (
        SELECT COALESCE(${paramRef}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT ${sqlTrimmedText("value")} AS token
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.items) AS value
      )
    `;
}
