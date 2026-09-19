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
  buildSceneUnlockPaymentInputs,
  buildSubscriptionPaymentInputs,
} = await import("../src/mediaCommerce/subscriptionFlow.js");

const plan = {
  sku: "payment_action_2",
  feature_key: "scene_unlock",
  amount_xtr: 80,
  title: "title",
  description: "description",
  label: "label",
  button_text: "button",
};

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
