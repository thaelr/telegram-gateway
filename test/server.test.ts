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
const { MediaCommerceDecisionService, MediaCommerceOperationError } = await import(
  "../src/mediaCommerceDecisionService.js"
);
const { UnknownPhotoPriceError } = await import("../src/mediaCommerce/plans.js");

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

test("public SBP payment endpoint redirects without internal API auth", async (t) => {
  let checkout: {
    checkout_url: string;
    external_payment_id: string;
  } | null = null;
  let claimHeld = false;
  let createPaymentCalls = 0;
  const token = "subscription:plan:sbp";
  const repository = {
    async loadStoredInvoiceTokens(tokens: string[]) {
      if (!tokens.includes(token)) return [];
      return [{
        token,
        kind: "invoice_payload",
        chat_id: 101,
        scene_session_id: null,
        turn_no: null,
        scene_turn_no: null,
        payload_json: { action_kind: "subscription_payment" },
        sku: "plan",
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        checkout_url: checkout?.checkout_url ?? null,
        external_payment_id: checkout?.external_payment_id ?? null,
        amount_xtr: null,
        telegram_invoice_payload: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        telegram_invoice_message_id: null,
        invoice_link: null,
        stored: true,
        invoice_title: "Plan",
        invoice_description: "Subscription",
        invoice_label: "Plan",
        invoice_button_text: "Pay",
        status: "invoice_sent",
        action_kind: "subscription_payment",
      }];
    },
    async claimSbpCheckoutCreation(requestedToken: string, chatId: number) {
      return {
        token: requestedToken,
        chat_id: chatId,
        checkout_url: checkout?.checkout_url ?? null,
        external_payment_id: checkout?.external_payment_id ?? null,
        claim_acquired: checkout == null && !claimHeld
          ? (claimHeld = true)
          : false,
      };
    },
    async releaseSbpCheckoutCreation() {
      claimHeld = false;
      return 1;
    },
    async storeInvoiceLinks(items: Array<{
      checkout_url?: string | null;
      external_payment_id?: string | null;
    }>) {
      const [item] = items;
      if (item?.checkout_url && item.external_payment_id) {
        checkout = {
          checkout_url: item.checkout_url,
          external_payment_id: item.external_payment_id,
        };
      }
      return item ? 1 : 0;
    },
    async loadInvoiceToken() {
      return {
        found: true,
        token,
        requested_token: token,
        kind: "invoice_payload",
        chat_id: 101,
        scene_session_id: null,
        turn_no: null,
        payload_json: { action_kind: "subscription_payment" },
        status: "invoice_sent",
        action_kind: "subscription_payment",
        sku: "plan",
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        checkout_url: checkout?.checkout_url ?? null,
        external_payment_id: checkout?.external_payment_id ?? null,
        amount_xtr: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        telegram_invoice_message_id: null,
      };
    },
  };
  const sbpCheckoutService = new MediaCommerceDecisionService(
    repository as never,
    {} as never,
    {
      async createPayment() {
        createPaymentCalls += 1;
        return {
          external_payment_id: "platega-1",
          checkout_url: "https://platega.example/checkout/existing",
        };
      },
    },
  );
  const app = buildApp({
    logger: false,
    sbpCheckoutService,
  });
  t.after(() => app.close());

  const first = await app.inject({
    method: "GET",
    url: "/v1/pay/sbp/subscription%3Aplan%3Asbp",
  });
  const second = await app.inject({
    method: "GET",
    url: "/v1/pay/sbp/subscription%3Aplan%3Asbp",
  });

  assert.equal(first.statusCode, 302);
  assert.equal(first.headers.location, "https://platega.example/checkout/existing");
  assert.equal(second.statusCode, 302);
  assert.equal(second.headers.location, "https://platega.example/checkout/existing");
  assert.equal(createPaymentCalls, 1);
});

test("public SBP payment endpoint maps expected checkout states without 500", async (t) => {
  const cases = [
    { code: "sbp_invoice_not_found", status: 404, error: "payment_not_found" },
    { code: "sbp_invoice_expired", status: 410, error: "payment_unavailable" },
    { code: "sbp_invoice_status_invalid", status: 410, error: "payment_unavailable" },
    { code: "sbp_invoice_kind_invalid", status: 410, error: "payment_unavailable" },
    { code: "sbp_invoice_action_invalid", status: 410, error: "payment_unavailable" },
    { code: "sbp_payment_source_invalid", status: 410, error: "payment_unavailable" },
    { code: "sbp_checkout_creation_in_progress", status: 409, error: "payment_creation_in_progress" },
    { code: "sbp_checkout_creation_uncertain", status: 503, error: "payment_reconciliation_required" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.code, async (nested) => {
      const app = buildApp({
        logger: false,
        sbpCheckoutService: {
          async resolveSbpCheckout() {
            throw new MediaCommerceOperationError("unavailable", "sbpRedirect", entry.code);
          },
        },
      });
      nested.after(() => app.close());

      const response = await app.inject({ method: "GET", url: "/v1/pay/sbp/token" });
      assert.equal(response.statusCode, entry.status);
      assert.deepEqual(response.json(), { error: entry.error });
    });
  }
});

test("public SBP payment endpoint leaves true internal failures as 500", async (t) => {
  const app = buildApp({
    logger: false,
    sbpCheckoutService: {
      async resolveSbpCheckout() {
        throw new MediaCommerceOperationError(
          "database unavailable",
          "sbpRedirect.loadInvoiceToken",
          "database_unavailable",
        );
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/pay/sbp/token" });
  assert.equal(response.statusCode, 500);
});

test("unknown photo price keeps its typed code in the commerce HTTP response", async (t) => {
  const app = buildApp({
    logger: false,
    mediaCommerceDecisionService: {
      async evaluate() {
        throw new UnknownPhotoPriceError(999);
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/media-commerce-decision",
    headers: { "x-internal-api-key": "test-internal-key" },
    payload: { chat_id: 101 },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "unknown_photo_price");
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
