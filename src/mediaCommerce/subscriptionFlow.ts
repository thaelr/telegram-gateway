import { createHash } from "node:crypto";
import { config, type MediaActionPlan } from "../config.js";
import type { UpsertInvoiceTokenInput } from "../mediaCommerceRepository/shared.js";
import type {
  AbTestContext,
  InvoiceTokenPayload,
  MediaSubscriptionOfferReason,
  PaymentCurrency,
  PaymentSource,
} from "../mediaCommerceTypes.js";
import { buildTelegramInvoicePayload, INVOICE_TTL_MS } from "./utils.js";
import { MediaRepositoryContractError } from "../mediaCommerceRepository/errors.js";

type CommercePlan = {
  sku: string;
  amount_xtr: number;
  amount_rub?: number | null;
  title: string;
  description: string;
  label: string;
  button_text: string;
  original_amount_xtr?: number | null;
  original_amount_rub?: number | null;
  promo_key?: string | null;
};

function buildPaymentToken(baseToken: string, source: PaymentSource): string {
  return source === "stars" ? baseToken : `${baseToken}:${source}`;
}

function buildHashedPaymentToken(parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `pay_${hash}`;
}

function buildAbIdentity(abTest: AbTestContext | null | undefined): string | null {
  return abTest
    ? [
      abTest.key,
      abTest.starts_at,
      abTest.version,
      abTest.variant,
    ].join("|")
    : null;
}

function applyPaymentTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function buildStarsButtonText(amountXtr: number): string {
  return applyPaymentTemplate(
    config.TELEGRAM_UX_COPY_JSON.payment_ui.stars_payment_button,
    { amount: Math.trunc(amountXtr) },
  );
}

function buildSbpButtonText(amountRub: number): string {
  return applyPaymentTemplate(
    config.TELEGRAM_UX_COPY_JSON.payment_ui.sbp_payment_button,
    { amount: Math.trunc(amountRub) },
  );
}

function buildPaymentInputRow(input: {
  source: PaymentSource;
  token: string;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  payload_json: InvoiceTokenPayload;
  action_kind: string;
  expires_at: string;
  plan: CommercePlan;
}): UpsertInvoiceTokenInput {
  const isStars = input.source === "stars";
  const amount = isStars ? input.plan.amount_xtr : input.plan.amount_rub;
  if (amount == null || !Number.isInteger(amount) || amount <= 0) {
    throw new MediaRepositoryContractError("buildPaymentInputRow", {
      field: input.source === "sbp" ? "amount_rub" : "amount_xtr",
      reason: "invalid",
    });
  }
  const currency: PaymentCurrency = isStars ? "XTR" : "RUB";

  return {
    token: input.token,
    kind: "invoice_payload",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    payload_json: input.payload_json,
    action_kind: input.action_kind,
    sku: input.plan.sku,
    payment_source: input.source,
    amount,
    currency,
    amount_xtr: isStars ? input.plan.amount_xtr : null,
    telegram_invoice_payload: isStars
      ? buildTelegramInvoicePayload(input.token)
      : null,
    checkout_url: null,
    external_payment_id: null,
    expires_at: input.expires_at,
    invoice_title: input.plan.title,
    invoice_description: input.plan.description,
    invoice_label: input.plan.label,
    invoice_button_text: isStars
      ? buildStarsButtonText(input.plan.amount_xtr)
      : buildSbpButtonText(amount),
  };
}

function buildPaymentInputs(input: {
  base_token: string;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  payload_json: InvoiceTokenPayload;
  action_kind: string;
  plan: CommercePlan;
}): UpsertInvoiceTokenInput[] {
  const expiresAt = new Date(Date.now() + INVOICE_TTL_MS).toISOString();
  const sources: PaymentSource[] = ["stars"];

  if (config.SBP_ENABLED && input.plan.amount_rub != null) {
    sources.push("sbp");
  }

  return sources.map((source) =>
    buildPaymentInputRow({
      source,
      token: buildPaymentToken(input.base_token, source),
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      payload_json: input.payload_json,
      action_kind: input.action_kind,
      expires_at: expiresAt,
      plan: input.plan,
    }));
}

export function buildSceneUnlockPaymentInputs(input: {
  chat_id: number;
  scene_session_id: string;
  idempotency_key: string;
  subscription_offer_reason?: MediaSubscriptionOfferReason | null;
  turn_limit?: number | null;
  turns_today?: number | null;
  turn_limit_reset_text?: string | null;
  target_message_id?: number | null;
  plan: MediaActionPlan & {
    amount_rub?: number | null;
    original_amount_xtr?: number | null;
    original_amount_rub?: number | null;
    promo_key?: string | null;
  };
  ab_test?: AbTestContext | null;
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
    original_amount_rub: input.plan.original_amount_rub ?? input.plan.amount_rub ?? null,
    promo_key: input.plan.promo_key ?? null,
    sort_order: 0,
    ab_test: input.ab_test ?? null,
  };
  const baseToken = `${input.idempotency_key}:${input.scene_session_id}:${input.plan.sku}`;

  return buildPaymentInputs({
    base_token: baseToken,
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: null,
    scene_turn_no: null,
    payload_json: payloadJson,
    action_kind: "feature_payment",
    plan: input.plan,
  });
}

export function buildFeaturePaymentInputs(input: {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  media_signature?: string | null;
  target_message_id?: number | null;
  current_uuid?: string | null;
  base_price_xtr?: number | null;
  idempotency_key: string;
  requested_action: string;
  plan: MediaActionPlan & {
    amount_rub?: number | null;
    original_amount_xtr?: number | null;
    original_amount_rub?: number | null;
    promo_key?: string | null;
  };
  ab_test?: AbTestContext | null;
}) {
  const payloadJson: InvoiceTokenPayload = {
    action_kind: "feature_payment",
    feature_key: input.plan.feature_key,
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    character_i: input.character_i ?? null,
    scene_mode: input.scene_mode ?? null,
    media_signature: input.media_signature ?? null,
    target_message_id: input.target_message_id ?? null,
    current_uuid: input.current_uuid ?? null,
    base_price_xtr: input.base_price_xtr ?? 0,
    requested_action: input.requested_action,
    original_amount_xtr: input.plan.original_amount_xtr ?? input.plan.amount_xtr,
    original_amount_rub: input.plan.original_amount_rub ?? input.plan.amount_rub ?? null,
    promo_key: input.plan.promo_key ?? null,
    ab_test: input.ab_test ?? null,
  };
  const baseToken = `${input.idempotency_key}:${input.plan.sku}`;

  return buildPaymentInputs({
    base_token: baseToken,
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    payload_json: payloadJson,
    action_kind: "feature_payment",
    plan: input.plan,
  });
}

export function buildSubscriptionPaymentInputs(input: {
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
    amount_rub?: number | null;
    title: string;
    description: string;
    label: string;
    button_text: string;
    original_amount_xtr?: number | null;
    original_amount_rub?: number | null;
    promo_key?: string | null;
  };
  ab_test?: AbTestContext | null;
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
    original_amount_rub: input.plan.original_amount_rub ?? input.plan.amount_rub ?? null,
    promo_key: input.plan.promo_key ?? null,
    sort_order: input.sort_order,
    ab_test: input.ab_test ?? null,
  };
  const baseToken = buildHashedPaymentToken([
    input.idempotency_key,
    input.plan.sku,
    buildAbIdentity(input.ab_test),
  ]);

  return buildPaymentInputs({
    base_token: baseToken,
    chat_id: input.chat_id,
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    payload_json: payloadJson,
    action_kind: "subscription_payment",
    plan: input.plan,
  });
}
