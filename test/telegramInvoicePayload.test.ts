import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([{
  sku: "payment_plan_7",
  days: 7,
  amount_xtr: 100,
  title: "title",
  description: "description",
  label: "label",
  button_text: "button",
}]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([{
  sku: "payment_media_1",
  amount_xtr: 10,
  title: "title",
  description: "description",
  label: "label",
  button_text: "button",
}]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([{
  sku: "payment_action_2",
  feature_key: "scene_unlock",
  amount_xtr: 80,
  title: "title",
  description: "description",
  label: "label",
  button_text: "button",
}]);

const {
  buildTelegramInvoicePayload,
  TELEGRAM_INVOICE_PAYLOAD_MAX_BYTES,
} = await import("../src/mediaCommerce/utils.js");
const { buildPhotoInvoiceInput } = await import("../src/mediaCommerce/mediaAction.js");
const {
  buildFeaturePaymentInputs,
  buildSceneUnlockPaymentInputs,
  buildSubscriptionPaymentInputs,
} = await import("../src/mediaCommerce/subscriptionFlow.js");
const { config } = await import("../src/config.js");

const plan = {
  sku: "payment_action_2",
  feature_key: "scene_unlock",
  amount_xtr: 80,
  title: "title",
  description: "description",
  label: "label",
  button_text: "button",
};

function assertShortPaymentTokens(rows: Array<{ payment_source: string; token: string }>): void {
  const stars = rows.find((row) => row.payment_source === "stars");
  const sbp = rows.find((row) => row.payment_source === "sbp");

  assert.ok(stars);
  assert.ok(sbp);
  assert.match(stars.token, /^pay_[0-9a-f]{32}$/u);
  assert.match(sbp.token, /^pay_[0-9a-f]{32}:sbp$/u);
  assert.ok(Buffer.byteLength(stars.token, "utf8") < 64);
  assert.ok(Buffer.byteLength(sbp.token, "utf8") < 64);
}

function assertValidTelegramPayload(payload: string | null, internalToken: string): void {
  assert.ok(payload);
  assert.match(payload, /^stars_[0-9a-f]{64}$/u);
  assert.ok(Buffer.byteLength(payload, "utf8") <= TELEGRAM_INVOICE_PAYLOAD_MAX_BYTES);
  assert.notEqual(payload, internalToken);
}

test("Telegram Stars payload is short, stable, and distinct per internal payment token", () => {
  const longToken = `internal_${"очень-длинный-контекст-".repeat(40)}`;
  const first = buildTelegramInvoicePayload(longToken);
  const second = buildTelegramInvoicePayload(longToken);
  const other = buildTelegramInvoicePayload(`${longToken}:other`);

  assert.equal(first, second);
  assert.notEqual(first, other);
  assertValidTelegramPayload(first, longToken);
});

test("scene unlock and subscription Stars rows use bounded hashed payloads", () => {
  const sceneRows = buildSceneUnlockPaymentInputs({
    chat_id: 101,
    scene_session_id: "scene-" + "x".repeat(300),
    idempotency_key: "scene-click-" + "y".repeat(300),
    plan,
  });
  const subscriptionRows = buildSubscriptionPaymentInputs({
    chat_id: 101,
    idempotency_key: "subscription-" + "z".repeat(300),
    subscription_offer_reason: "subscription_command",
    turn_limit: 20,
    turns_today: 0,
    turn_limit_reset_text: "00:00 МСК",
    sort_order: 1,
    plan: {
      ...plan,
      sku: "payment_plan_7",
      days: 7,
    },
  });

  const sceneStars = sceneRows.find((row) => row.payment_source === "stars");
  const subscriptionStars = subscriptionRows.find((row) => row.payment_source === "stars");
  assert.ok(sceneStars);
  assert.ok(subscriptionStars);
  assertValidTelegramPayload(sceneStars.telegram_invoice_payload, sceneStars.token);
  assertValidTelegramPayload(subscriptionStars.telegram_invoice_payload, subscriptionStars.token);
});

test("feature Stars and SBP payment tokens are short, stable, and sku-sensitive", () => {
  const previousEnabled = config.SBP_ENABLED;
  config.SBP_ENABLED = true;

  try {
    const input = {
      chat_id: 101,
      scene_session_id: "scene-" + "s".repeat(300),
      turn_no: 5,
      scene_turn_no: 3,
      idempotency_key: "feature-" + "i".repeat(500),
      requested_action: "fast_scene_skip_purchase",
      plan: {
        ...plan,
        sku: "payment_action_feature",
        feature_key: "fast_scene_skip",
        amount_rub: 120,
      },
    };
    const first = buildFeaturePaymentInputs(input);
    const second = buildFeaturePaymentInputs(input);
    const otherSku = buildFeaturePaymentInputs({
      ...input,
      plan: { ...input.plan, sku: "payment_action_feature_other" },
    });

    assertShortPaymentTokens(first);
    assert.deepEqual(second.map((row) => row.token), first.map((row) => row.token));
    assert.notDeepEqual(otherSku.map((row) => row.token), first.map((row) => row.token));
  } finally {
    config.SBP_ENABLED = previousEnabled;
  }
});

test("scene unlock Stars and SBP payment tokens are short, stable, and scene-sensitive", () => {
  const previousEnabled = config.SBP_ENABLED;
  config.SBP_ENABLED = true;

  try {
    const input = {
      chat_id: 101,
      scene_session_id: "scene-" + "s".repeat(300),
      idempotency_key: "scene-unlock-" + "i".repeat(500),
      plan: { ...plan, amount_rub: 120 },
    };
    const first = buildSceneUnlockPaymentInputs(input);
    const second = buildSceneUnlockPaymentInputs(input);
    const otherScene = buildSceneUnlockPaymentInputs({
      ...input,
      scene_session_id: "scene-other-" + "s".repeat(300),
    });

    assertShortPaymentTokens(first);
    assert.deepEqual(second.map((row) => row.token), first.map((row) => row.token));
    assert.notDeepEqual(otherScene.map((row) => row.token), first.map((row) => row.token));
  } finally {
    config.SBP_ENABLED = previousEnabled;
  }
});

test("photo Stars rows use the same bounded hashed payload", () => {
  const internalToken = `photo_${"p".repeat(400)}`;
  const row = buildPhotoInvoiceInput({
    token: internalToken,
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "signature",
    target_message_id: 777,
    current_uuid: "uuid",
    base_price_xtr: 10,
    amount_xtr: 10,
    invoice_sku: "payment_media_1",
    invoice_title: "title",
    invoice_description: "description",
    invoice_label: "label",
    invoice_button_text: "button",
    payload_json: {
      action_kind: "photo_payment",
      chat_id: 101,
    },
  });

  assertValidTelegramPayload(row.telegram_invoice_payload, row.token);
});
