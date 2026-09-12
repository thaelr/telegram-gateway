import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

process.env.NODE_ENV = "test";
installTestEnv();
process.env.INTERNAL_API_KEY_HEADER ??= "x-internal-api-key";
process.env.TURN_LIMIT ??= "20";
process.env.BUSINESS_TIME_ZONE ??= "Europe/Moscow";
process.env.TURN_LIMIT_RESET_TEXT ??= "00:00 МСК";
process.env.MEDIA_PAYMENT_CURRENCY ??= "XTR";
process.env.MEDIA_STORAGE_BASE_URL ??= "https://media.example.com";
process.env.MEDIA_DEFAULT_BUCKET_NAME ??= "media_bucket";
process.env.MEDIA_BUCKET_ALIAS_MAP_JSON ??= "{}";
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_2",
    days: 14,
    amount_xtr: 111,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 11,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_action_1",
    feature_key: "fast_scene_skip",
    amount_xtr: 55,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
  {
    sku: "payment_action_2",
    feature_key: "scene_unlock",
    amount_xtr: 80,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);

const { buildApp } = await import("../src/server.js");
const { MediaCommerceOperationError } = await import(
  "../src/mediaCommerceDecisionService.js"
);

test("media-commerce endpoint rejects missing internal api key", async (t) => {
  let called = false;
  const app = buildApp({
    logger: false,
    mediaCommerceDecisionService: {
      async evaluate() {
        called = true;
        return {
          route: "noop",
          operation: "noop",
          interaction_mode: null,
          event_type: null,
          chat_id: null,
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/media-commerce-decision",
    payload: {},
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "unauthorized" });
  assert.equal(called, false);
});

test("media-commerce endpoint accepts valid internal api key and coerces request body", async (t) => {
  let receivedChatId: number | null = null;
  const app = buildApp({
    logger: false,
    mediaCommerceDecisionService: {
      async evaluate(input) {
        receivedChatId = input.chat_id ?? null;
        return {
          route: "noop",
          operation: "noop",
          interaction_mode: input.interaction_mode ?? null,
          event_type: input.event_type ?? null,
          chat_id: input.chat_id ?? null,
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/media-commerce-decision",
    headers: {
      "x-internal-api-key": "test-internal-key",
    },
    payload: {
      chat_id: "123",
      turn_no: "0",
      scene_turn_no: "0",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(receivedChatId, 123);
  assert.equal(response.json().chat_id, 123);
});

test("media-commerce endpoint returns 400 invalid_request for invalid body", async (t) => {
  let called = false;
  const app = buildApp({
    logger: false,
    mediaCommerceDecisionService: {
      async evaluate() {
        called = true;
        return {
          route: "noop",
          operation: "noop",
          interaction_mode: null,
          event_type: null,
          chat_id: null,
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/media-commerce-decision",
    headers: {
      "x-internal-api-key": "test-internal-key",
    },
    payload: {
      chat_id: "0",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid_request");
  assert.equal(called, false);
});

test("media-commerce endpoint returns safe diagnostics for internal errors", async (t) => {
  const app = buildApp({
    logger: false,
    mediaCommerceDecisionService: {
      async evaluate() {
        throw new MediaCommerceOperationError(
          "MediaCommerce operation failed",
          "payment.success.markInvoicePaid",
          "22023",
        );
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/media-commerce-decision",
    headers: {
      "x-internal-api-key": "test-internal-key",
    },
    payload: {
      chat_id: "123",
      turn_no: "0",
      scene_turn_no: "0",
    },
  });

  const body = response.json();
  assert.equal(response.statusCode, 500);
  assert.equal(body.statusCode, 500);
  assert.equal(body.error, "Internal Server Error");
  assert.equal(body.message, "MediaCommerce operation failed");
  assert.equal(body.operation, "payment.success.markInvoicePaid");
  assert.equal(body.code, "22023");
  assert.equal(typeof body.request_id, "string");
  assert.ok(body.request_id.length > 0);
  assert.equal("stack" in body, false);
});

test("router endpoint is registered and uses the same auth and validation wiring", async (t) => {
  let receivedChatId: number | null = null;
  let receivedPanelText: string | null = null;
  let receivedPanelEntities: unknown = null;
  let receivedRawUpdate: unknown = null;
  const app = buildApp({
    logger: false,
    accessDecisionService: {
      async evaluate(input) {
        receivedChatId = input.chat_id;
        receivedPanelText = input.panel_text ?? null;
        receivedPanelEntities = input.panel_entities_json ?? null;
        receivedRawUpdate = input.raw_update ?? null;
        return {
          decision: "noop",
          action: "ignore",
          allowed: false,
          domain: "command",
          intent: "unknown_command",
          chat_id: input.chat_id,
          source: input.source ?? "telegram",
          update_id: input.update_id ?? null,
          idempotency_key: null,
          panel_text: input.panel_text ?? null,
          panel_entities_json: input.panel_entities_json ?? null,
          raw_update: input.raw_update ?? null,
        };
      },
    },
  });
  t.after(() => app.close());

  const unauthorized = await app.inject({
    method: "POST",
    url: "/v1/router-decision",
    payload: {
      chat_id: 42,
    },
  });
  assert.equal(unauthorized.statusCode, 401);

  const response = await app.inject({
    method: "POST",
    url: "/v1/router-decision",
    headers: {
      "x-internal-api-key": "test-internal-key",
    },
    payload: {
      chat_id: "42",
      command: "/menu",
      panel_text: "panel caption",
      panel_entities_json: [{ type: "italic", offset: 0, length: 5 }],
      raw_update: { callback_query: { id: "cbq-1" } },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(receivedChatId, 42);
  assert.equal(receivedPanelText, "panel caption");
  assert.deepEqual(receivedPanelEntities, [{ type: "italic", offset: 0, length: 5 }]);
  assert.deepEqual(receivedRawUpdate, { callback_query: { id: "cbq-1" } });
  assert.equal(response.json().chat_id, 42);
  assert.equal(response.json().panel_text, "panel caption");
  assert.deepEqual(response.json().raw_update, { callback_query: { id: "cbq-1" } });
});

test("reward slot endpoint returns claim UI result", async (t) => {
  const app = buildApp({
    logger: false,
    rewardService: {
      async claimConfiguredSlot(input) {
        return {
          grant_id: 10,
          chat_id: input.chatId,
          campaign_id: "campaign-1",
          slot: input.slot,
          telegram_message_id: input.telegramMessageId,
          status: "claimed",
          free_scene_unlocks: 1,
          free_fast_scene_skips: 2,
          free_photo_unlocks: 3,
          subscription_until: null,
          success_text: "Gift claimed",
          callback_answer_text: "Gift claimed",
          next_action: "show_character_gallery",
          reward_slot: input.slot,
        };
      },
      async claimReward() {
        throw new Error("not used");
      },
      async assignConfiguredSlot() {
        throw new Error("not used");
      },
      async bindGrantMessage() {
        throw new Error("not used");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/claim-slot",
    headers: { "x-internal-api-key": "test-internal-key" },
    payload: { chat_id: "42", reward_slot: "1", inbound_message_id: "100" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "claimed");
  assert.equal(response.json().next_action, "show_character_gallery");
});

test("reward grant endpoint assigns the configured campaign before broadcast delivery", async (t) => {
  let received: unknown = null;
  const app = buildApp({
    logger: false,
    rewardService: {
      async claimConfiguredSlot() {
        throw new Error("not used");
      },
      async claimReward() {
        throw new Error("not used");
      },
      async assignConfiguredSlot(input) {
        received = input;
        return {
          grant_id: 10,
          chat_id: input.chatId,
          slot: input.slot,
          campaign_id: "campaign-1",
          status: "assigned" as const,
          assigned_at: "2026-09-12T00:00:00Z",
          claimed_at: null,
          telegram_message_id: null,
        };
      },
      async bindGrantMessage() {
        throw new Error("not used");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/grants",
    headers: { "x-internal-api-key": "test-internal-key" },
    payload: { chat_id: "42", reward_slot: "1" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, { chatId: 42, slot: 1 });
  assert.equal(response.json().campaign_id, "campaign-1");
});

test("reward grant message binding endpoint updates an existing grant", async (t) => {
  let received: unknown = null;
  const app = buildApp({
    logger: false,
    rewardService: {
      async claimConfiguredSlot() { throw new Error("not used"); },
      async claimReward() { throw new Error("not used"); },
      async assignConfiguredSlot() { throw new Error("not used"); },
      async bindGrantMessage(input) {
        received = input;
        return {
          grant_id: input.grantId,
          chat_id: 42,
          slot: 1,
          campaign_id: "campaign-1",
          status: "assigned" as const,
          assigned_at: "2026-09-12T00:00:00Z",
          claimed_at: null,
          telegram_message_id: input.telegramMessageId,
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/grants/10/bind-message",
    headers: { "x-internal-api-key": "test-internal-key" },
    payload: { telegram_message_id: "100" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, { grantId: 10, telegramMessageId: 100 });
  assert.equal(response.json().telegram_message_id, 100);
});

test("direct reward endpoint invokes the campaign service without Telegram context", async (t) => {
  let received: unknown = null;
  const app = buildApp({
    logger: false,
    rewardService: {
      async claimConfiguredSlot() {
        throw new Error("not used");
      },
      async claimReward(input) {
        received = input;
        return {
          chat_id: input.chatId,
          campaign_id: input.campaignId,
          status: "already_claimed",
          free_scene_unlocks: 1,
          free_fast_scene_skips: 2,
          free_photo_unlocks: 3,
          subscription_until: null,
        };
      },
      async assignConfiguredSlot() {
        throw new Error("not used");
      },
      async bindGrantMessage() {
        throw new Error("not used");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/claim",
    headers: { "x-internal-api-key": "test-internal-key" },
    payload: { chat_id: 42, campaign_id: "campaign-1" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, { chatId: 42, campaignId: "campaign-1" });
  assert.equal(response.json().status, "already_claimed");
});
