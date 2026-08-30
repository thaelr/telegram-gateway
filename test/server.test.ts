import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.INTERNAL_API_KEY_HEADER ??= "x-internal-api-key";
process.env.TURN_LIMIT ??= "15";
process.env.BUSINESS_TIME_ZONE ??= "Europe/Moscow";
process.env.TURN_LIMIT_RESET_TEXT ??= "00:00 МСК";
process.env.MEDIA_PAYMENT_CURRENCY ??= "XTR";
process.env.MEDIA_STORAGE_BASE_URL ??= "https://media.example.com";
process.env.MEDIA_DEFAULT_BUCKET_NAME ??= "media_bucket";
process.env.MEDIA_BUCKET_ALIAS_MAP_JSON ??= "{}";
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_1",
    days: 14,
    amount_xtr: 111,
    title: "Payment plan 1",
    description: "Access plan option 1 for chat and media actions.",
    label: "Payment plan 1",
    button_text: "Payment plan 1",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 11,
    title: "Payment media 1",
    description: "Media payment option 1.",
    label: "Payment media 1",
    button_text: "Payment media 1",
  },
]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_action_1",
    feature_key: "fast_scene_skip",
    amount_xtr: 55,
    title: "Payment action 1",
    description: "Feature payment option 1.",
    label: "Payment action 1",
    button_text: "Payment action 1",
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
  const app = buildApp({
    logger: false,
    accessDecisionService: {
      async evaluate(input) {
        receivedChatId = input.chat_id;
        receivedPanelText = input.panel_text ?? null;
        receivedPanelEntities = input.panel_entities_json ?? null;
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
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(receivedChatId, 42);
  assert.equal(receivedPanelText, "panel caption");
  assert.deepEqual(receivedPanelEntities, [{ type: "italic", offset: 0, length: 5 }]);
  assert.equal(response.json().chat_id, 42);
  assert.equal(response.json().panel_text, "panel caption");
});
