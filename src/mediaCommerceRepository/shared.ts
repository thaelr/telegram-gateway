import type { JSONValue } from "postgres";
import type { AbTestAssignment, AbTestContext } from "../abTesting.js";
import { sql } from "../db.js";
import {
  parseJsonArray as parseLenientJsonArray,
  parseJsonObject as parseLenientJsonObject,
} from "../json.js";
import type {
  FreeActionRedeemResult,
  FreeCredits,
  MediaContext,
  MediaFinalizeResult,
  MediaOfferStats,
  PaymentCurrency,
  PaymentSource,
} from "../mediaCommerceTypes.js";
import { MediaRepositoryContractError } from "./errors.js";

export type QueryClient = typeof sql;

export type CatalogRow = {
  uuid: string | null;
  bucket_name: string | null;
  storage_path: string | null;
  sort_order: number | null;
  first_unlocked_at?: string | null;
};

export type MediaCatalogPhoto = CatalogRow & {
  uuid: string;
  photo_url: string | null;
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
  payment_source: PaymentSource;
  amount: number;
  currency: PaymentCurrency;
  amount_xtr: number | null;
  telegram_invoice_payload: string | null;
  checkout_url: string | null;
  external_payment_id?: string | null;
  expires_at: string;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
};

export type UpsertInvoiceTokenBatchInput = UpsertInvoiceTokenInput[];

export type SbpCheckoutCreationClaim = {
  token: string | null;
  chat_id: number | null;
  checkout_url: string | null;
  external_payment_id: string | null;
  claim_acquired: boolean;
  creation_state?: "idle" | "creating" | "uncertain" | "created" | null;
  eligible?: boolean;
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
  payment_source?: PaymentSource | null;
  telegram_payment_charge_id?: string | null;
  provider_payment_charge_id?: string | null;
  external_payment_id?: string | null;
  payment_currency?: string | null;
  payment_total_amount?: number | null;
  checkout_url?: string | null;
};

export type ActivateSubscriptionInput = {
  payment_token: string;
  chat_id: number;
  subscription_sku: string | null;
  subscription_days: number;
};

export type ActivateSceneAccessInput = {
  payment_token: string;
  chat_id: number;
  scene_session_id: string;
  scene_access_sku: string | null;
};

export type LoadAbTestAssignmentResult = {
  assignment: AbTestAssignment | null;
};

export type RecordAbTestDeliveredInput = SceneTurnRef & {
  ab_test: AbTestContext;
};

export type SceneAccessStatusInput = {
  chat_id: number;
  scene_session_id: string | null;
};

export type SceneAccessStatus = {
  chat_id: number | null;
  scene_session_id: string | null;
  active_scene_session_id: string | null;
  subscription_active: boolean;
  scene_access_active: boolean;
  scene_is_active: boolean;
};

export type LoadFreeCreditsResult = FreeCredits;

export type RedeemFreeActionResult = FreeActionRedeemResult;

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

export type FinalizeFreePhotoUnlockInput = SceneTurnRef & {
  token: string;
  media_signature: string;
  uuid: string;
  panel_message_id: number;
};

export function parseJsonArray(value: unknown): unknown[] {
  return parseLenientJsonArray(value) ?? [];
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return parseLenientJsonObject(value);
}

function describeJsonObjectFailure(value: unknown): string {
  if (value == null) return "missing";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? "array" : "scalar";
    } catch {
      return "malformed_json";
    }
  }
  if (Array.isArray(value)) return "array";
  return "scalar";
}

export function parseStrictJsonObject(
  value: unknown,
  operation: string,
  field = "payload_json",
): Record<string, unknown> {
  const parsed = parseJsonObject(value);
  if (parsed) return parsed;

  throw new MediaRepositoryContractError(operation, {
    field,
    reason: describeJsonObjectFailure(value),
  });
}

export function asJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}
