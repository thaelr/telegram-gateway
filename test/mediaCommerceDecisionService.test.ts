import test from "node:test";
import assert from "node:assert/strict";
import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  MediaContext,
  MediaOfferStats,
  PaidInvoiceToken,
  StoredInvoiceToken,
} from "../src/mediaCommerceTypes.js";
import type { MediaCommerceDecisionRequest } from "../src/mediaCommerce/requestSchema.js";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.TURN_LIMIT ??= "20";
process.env.BUSINESS_TIME_ZONE ??= "Europe/Moscow";
process.env.TURN_LIMIT_RESET_TEXT ??= "00:00 МСК";
process.env.MEDIA_STORAGE_BASE_URL ??= "https://media.example.com";
process.env.MEDIA_PROMOTIONS_JSON ??= "[]";
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_2",
    days: 14,
    amount_xtr: 200,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
  {
    sku: "payment_plan_3",
    days: 30,
    amount_xtr: 300,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 10,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
  {
    sku: "payment_media_2",
    amount_xtr: 25,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
  {
    sku: "payment_media_3",
    amount_xtr: 50,
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
    amount_xtr: 50,
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
  {
    sku: "payment_action_3",
    feature_key: "future_action_3",
    amount_xtr: 100,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);

const { MediaCommerceDecisionService } = await import(
  "../src/mediaCommerceDecisionService.js"
);
const { config } = await import("../src/config.js");

type MockRepository = {
  loadOfferStats: (
    input: unknown,
  ) => Promise<MediaOfferStats | null>;
  upsertCallbackTokens: (
    tokenRows: InteractionTokenRow[],
  ) => Promise<number>;
  upsertInvoiceToken: (
    input: unknown,
  ) => Promise<StoredInvoiceToken | null>;
  upsertInvoiceTokens: (
    inputs: unknown,
  ) => Promise<StoredInvoiceToken[]>;
  loadCallbackToken: (
    token: string | null,
    chatId: number | null,
  ) => Promise<LoadedCallbackToken | null>;
  loadMediaContext: (
    input: unknown,
  ) => Promise<MediaContext | null>;
  storePanel: (
    input: unknown,
  ) => Promise<{
    chat_id: number | null;
    n: number | null;
    scene_session_id: string | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    price_required: number | null;
    panel_message_id: number | null;
    stored_count: number;
    invoice_rows_updated: number;
  }>;
  loadInvoiceToken: (
    token: string | null,
    chatId: number | null,
  ) => Promise<LoadedInvoiceToken | null>;
  storePrecheckoutResult: (input: unknown) => Promise<void>;
  markInvoicePaid: (
    input: unknown,
  ) => Promise<PaidInvoiceToken | null>;
  activateSubscription: (
    input: unknown,
  ) => Promise<number>;
  activateSceneAccess: (
    input: unknown,
  ) => Promise<number>;
  loadSceneAccessStatus: (
    input: unknown,
  ) => Promise<{
    chat_id: number | null;
    scene_session_id: string | null;
    active_scene_session_id: string | null;
    subscription_active: boolean;
    scene_access_active: boolean;
    scene_is_active: boolean;
  } | null>;
  storePhotoEvent: (
    input: unknown,
  ) => Promise<{
    chat_id: number | null;
    n: number | null;
    scene_session_id: string | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    price_required: number | null;
    panel_message_id: number | null;
    stored_count: number;
    invoice_rows_updated: number;
  }>;
  storeInvoiceLinks: (items: unknown) => Promise<number>;
  loadStoredInvoiceTokens: (
    tokens: string[],
  ) => Promise<StoredInvoiceToken[]>;
  storeSubscriptionOfferMessageId: (
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ) => Promise<number>;
};

function buildOfferStats(
  overrides: Partial<MediaOfferStats> = {},
): MediaOfferStats {
  return {
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    base_price_xtr: 10,
    should_offer: true,
    subscription_active: false,
    subscription_sku: null,
    subscription_until: null,
    scene_access_active: false,
    delivered_in_scene: 0,
    total_available: 4,
    unseen_available: 4,
    existing_panel_message_id: null,
    ...overrides,
  };
}

function buildLoadedCallbackToken(
  overrides: Partial<LoadedCallbackToken> = {},
): LoadedCallbackToken {
  return {
    requested_token: "btn_token",
    token: "btn_token",
    kind: "button_callback",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    payload_json: {
      action_kind: "photo_request",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      media_signature: "hotel_corridor_close",
      target_message_id: 555,
      current_uuid: "u1",
      base_price_xtr: 10,
      requested_action: "photo_request",
    },
    status: "active",
    action_kind: "photo_request",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    found: true,
    ...overrides,
  };
}

function buildMediaContext(
  overrides: Partial<MediaContext> = {},
): MediaContext {
  return {
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    current_uuid: "u1",
    target_message_id: 555,
    base_price_xtr: 10,
    action_kind: "photo_request",
    requested_action: "photo_request",
    invoice_token: null,
    force_deliver_after_payment: false,
    paid_access_mode: null,
    callback_valid: true,
    panel_text: "Панель",
    panel_entities_json: [],
    subscription_active: false,
    subscription_sku: null,
    subscription_until: null,
    scene_access_active: false,
    delivered_in_scene: 0,
    total_available: 4,
    unseen_available: 3,
    unlocked_items_json: [],
    next_unseen_json: {
      uuid: "u2",
      photo_url: "https://cdn.test/u2.jpg",
      sort_order: 2,
    },
    ...overrides,
  };
}

function buildStoredInvoiceToken(
  overrides: Partial<StoredInvoiceToken> = {},
): StoredInvoiceToken {
  return {
    token: "inv_token",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    payload_json: {},
    sku: "payment_media_1",
    amount_xtr: 10,
    telegram_invoice_payload: "inv_token",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    telegram_invoice_message_id: null,
    invoice_link: null,
    stored: true,
    invoice_title: "text",
    invoice_description: "text",
    invoice_label: "text",
    invoice_button_text: "text",
    status: "invoice_sent",
    action_kind: "photo_payment",
    ...overrides,
  };
}

function buildLoadedInvoiceToken(
  overrides: Partial<LoadedInvoiceToken> = {},
): LoadedInvoiceToken {
  return {
    requested_token: "inv_payload",
    token: "inv_payload",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    payload_json: {
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      media_signature: "hotel_corridor_close",
      target_message_id: 555,
      current_uuid: "u1",
      base_price_xtr: 10,
      requested_action: "photo_request",
    },
    status: "invoice_sent",
    action_kind: "photo_payment",
    sku: "payment_media_1",
    amount_xtr: 10,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    telegram_invoice_message_id: null,
    found: true,
    ...overrides,
  };
}

function buildPaidInvoiceToken(
  overrides: Partial<PaidInvoiceToken> = {},
): PaidInvoiceToken {
  return {
    token: "inv_payload",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    payload_json: {
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      media_signature: "hotel_corridor_close",
      target_message_id: 555,
      current_uuid: "u1",
      base_price_xtr: 10,
      requested_action: "photo_request",
    },
    status: "paid",
    action_kind: "photo_payment",
    sku: "payment_media_1",
    amount_xtr: 10,
    telegram_invoice_message_id: null,
    ...overrides,
  };
}

function buildRequest(
  overrides: Partial<MediaCommerceDecisionRequest> = {},
): MediaCommerceDecisionRequest {
  return {
    interaction_mode: "prepare_offer",
    event_type: null,
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    base_price_xtr: 10,
    should_offer: true,
    ...overrides,
  };
}

function createRepository(
  overrides: Partial<MockRepository> = {},
) {
  const calls = {
    loadMediaContext: 0,
    storePrecheckoutResult: 0,
    storeInvoiceLinks: 0,
    loadStoredInvoiceTokens: 0,
    loadCallbackTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    loadInvoiceTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    markInvoicePaid: 0,
    activateSubscription: 0,
    activateSceneAccess: 0,
    loadSceneAccessStatus: 0,
  };

  const repository: MockRepository = {
    async loadOfferStats() {
      return buildOfferStats();
    },
    async upsertCallbackTokens(tokenRows) {
      return tokenRows.length;
    },
    async upsertInvoiceToken() {
      return buildStoredInvoiceToken();
    },
    async upsertInvoiceTokens(inputs) {
      const rows = Array.isArray(inputs) ? inputs : [];
      return rows.map((input, index) => {
        const row = input as {
          token?: string;
          kind?: string;
          chat_id?: number;
          payload_json?: Record<string, unknown>;
          sku?: string;
          amount_xtr?: number;
          telegram_invoice_payload?: string;
          expires_at?: string | null;
          invoice_title?: string;
          invoice_description?: string;
          invoice_label?: string;
          invoice_button_text?: string;
        };
        return buildStoredInvoiceToken({
          token: row.token ?? `token-${index + 1}`,
          kind: row.kind ?? "invoice_payload",
          chat_id: row.chat_id ?? 101,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
          payload_json: row.payload_json ?? {},
          sku: row.sku ?? `payment_plan_${index + 1}`,
          amount_xtr: row.amount_xtr ?? (index + 1) * 100,
          telegram_invoice_payload:
            row.telegram_invoice_payload ?? row.token ?? `token-${index + 1}`,
          expires_at: row.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
          invoice_title: row.invoice_title ?? "text",
          invoice_description: row.invoice_description ?? "text",
          invoice_label: row.invoice_label ?? "text",
          invoice_button_text: row.invoice_button_text ?? "text",
          invoice_link: null,
        });
      });
    },
    async loadCallbackToken(token, chatId) {
      calls.loadCallbackTokenArgs.push({ token, chatId });
      return buildLoadedCallbackToken();
    },
    async loadMediaContext(input) {
      calls.loadMediaContext += 1;
      const source = (input ?? {}) as { invoice_token?: string | null };
      return buildMediaContext({
        invoice_token:
          typeof source.invoice_token === "string"
            ? source.invoice_token
            : null,
      });
    },
    async storePanel() {
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 10,
        panel_message_id: 700,
        stored_count: 1,
        invoice_rows_updated: 1,
      };
    },
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken();
    },
    async storePrecheckoutResult() {
      calls.storePrecheckoutResult += 1;
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken();
    },
    async activateSubscription() {
      calls.activateSubscription += 1;
      return 1;
    },
    async activateSceneAccess() {
      calls.activateSceneAccess += 1;
      return 1;
    },
    async loadSceneAccessStatus(input) {
      calls.loadSceneAccessStatus += 1;
      const source = (input ?? {}) as {
        chat_id?: number | null;
        scene_session_id?: string | null;
      };
      return {
        chat_id: source.chat_id ?? 101,
        scene_session_id: source.scene_session_id ?? "scene-1",
        active_scene_session_id: source.scene_session_id ?? "scene-1",
        subscription_active: false,
        scene_access_active: false,
        scene_is_active: true,
      };
    },
    async storePhotoEvent() {
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 10,
        panel_message_id: 555,
        stored_count: 1,
        invoice_rows_updated: 1,
      };
    },
    async storeInvoiceLinks() {
      calls.storeInvoiceLinks += 1;
      return 2;
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return tokens.map((token, index) =>
        buildStoredInvoiceToken({
          token,
          sku:
            index === 0 ? "payment_action_2" : index === 1 ? "payment_plan_2" : "payment_plan_3",
          amount_xtr: index === 0 ? 80 : index === 1 ? 200 : 300,
          invoice_title:
            "text",
          invoice_description: "text",
          invoice_label:
            "text",
          invoice_button_text:
            "text",
          payload_json: {
            action_kind: index === 0 ? "feature_payment" : "subscription_payment",
            feature_key: index === 0 ? "scene_unlock" : null,
            sort_order: index,
            subscription_days: index === 0 ? null : index === 1 ? 14 : 30,
            subscription_offer_reason: "subscription_command",
            turn_limit: 20,
            turns_today: 0,
            turn_limit_reset_text: "00:00 МСК",
          },
          invoice_link: null,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        }),
      );
    },
    async storeSubscriptionOfferMessageId() {
      return 2;
    },
    ...overrides,
  };

  return {
    service: new MediaCommerceDecisionService(repository),
    calls,
  };
}

async function withPromotions<T>(
  promotions: typeof config.MEDIA_PROMOTIONS_JSON,
  run: () => Promise<T>,
): Promise<T> {
  const previous = config.MEDIA_PROMOTIONS_JSON;
  config.MEDIA_PROMOTIONS_JSON = promotions;
  try {
    return await run();
  } finally {
    config.MEDIA_PROMOTIONS_JSON = previous;
  }
}

test("prepare_offer preserves zero turn counters", async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const { service } = createRepository({
    async loadOfferStats(input) {
      capturedInput = input as Record<string, unknown>;
      return buildOfferStats({
        turn_no: 0,
        scene_turn_no: 0,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      turn_no: 0,
      scene_turn_no: 0,
    }),
  );

  const preparedInput = capturedInput as {
    turn_no?: number | null;
    scene_turn_no?: number | null;
  } | null;
  assert.equal(preparedInput?.turn_no, 0);
  assert.equal(preparedInput?.scene_turn_no, 0);
  assert.equal(result.turn_no, 0);
  assert.equal(result.scene_turn_no, 0);
});

test("prepare_offer returns callback offer for free media", async () => {
  const { service } = createRepository();

  const first = await service.evaluate(buildRequest());
  const second = await service.evaluate(buildRequest());

  assert.equal(first.operation, "prepare_offer_callback");
  assert.equal(first.has_media_offer, true);
  assert.equal(first.token_rows_prepared, 1);
  assert.equal(first.token_rows_inserted, 1);
  assert.equal(first.reply_markup?.inline_keyboard[0]?.[0]?.text, "text");
  assert.notEqual(first.token_rows?.[0]?.token, second.token_rows?.[0]?.token);
});

test("prepare_offer reuses stored invoice link for paid media", async () => {
  const { service } = createRepository({
    async loadOfferStats() {
      return buildOfferStats({
        delivered_in_scene: 3,
        unseen_available: 2,
      });
    },
    async upsertInvoiceToken() {
      return buildStoredInvoiceToken({
        invoice_link: "https://t.me/invoice-link",
      });
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_invoice_link");
  assert.equal(result.needs_invoice_link, false);
  assert.equal(result.invoice_link, "https://t.me/invoice-link");
  assert.equal(result.reply_markup?.inline_keyboard.at(-1)?.[0]?.url, "https://t.me/invoice-link");
});

test("prepare_offer adds scene unlock invoice under paid photo offers", async () => {
  const { service } = createRepository({
    async loadOfferStats() {
      return buildOfferStats({
        delivered_in_scene: 3,
        unseen_available: 2,
      });
    },
    async upsertInvoiceToken(input) {
      const row = input as {
        token: string;
        payload_json: Record<string, unknown>;
        sku: string;
        amount_xtr: number;
        invoice_button_text: string;
      };
      return buildStoredInvoiceToken({
        token: row.token,
        telegram_invoice_payload: row.token,
        payload_json: row.payload_json,
        sku: row.sku,
        amount_xtr: row.amount_xtr,
        invoice_button_text: row.invoice_button_text,
        invoice_link:
          row.sku === "payment_action_2"
            ? "https://t.me/scene-pass"
            : "https://t.me/photo",
        scene_session_id:
          row.sku === "payment_action_2" ? "scene-1" : "scene-1",
      });
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_invoice_link");
  assert.deepEqual(
    result.reply_markup?.inline_keyboard.map((row) => row[0]?.url),
    ["https://t.me/photo", "https://t.me/scene-pass"],
  );
});

test("prepare_offer makes paid photos free after scene pass", async () => {
  const { service } = createRepository({
    async loadOfferStats() {
      return buildOfferStats({
        delivered_in_scene: 3,
        unseen_available: 2,
        scene_access_active: true,
      });
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_callback");
  assert.equal(result.price_required, 0);
  assert.equal(result.invoice_kind, undefined);
});

test("prepare_offer applies active sku promotion to photo invoice pricing", async () => {
  await withPromotions([
    {
      promo_key: "media_sale",
      items: [{ sku: "payment_media_1", promo_amount_xtr: 7 }],
      starts_at: "2026-09-01T00:00:00+03:00",
      ends_at: "2026-09-30T23:59:59+03:00",
    },
  ], async () => {
    const { service } = createRepository({
      async loadOfferStats() {
        return buildOfferStats({
          delivered_in_scene: 3,
          unseen_available: 2,
        });
      },
      async upsertInvoiceToken(input) {
        const row = input as {
          token: string;
          kind: string;
          chat_id: number;
          scene_session_id: string | null;
          turn_no: number | null;
          scene_turn_no: number | null;
          payload_json: Record<string, unknown>;
          sku: string;
          amount_xtr: number;
          telegram_invoice_payload: string;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        };

        return buildStoredInvoiceToken({
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: row.scene_session_id,
          turn_no: row.turn_no,
          scene_turn_no: row.scene_turn_no,
          payload_json: row.payload_json,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          telegram_invoice_payload: row.telegram_invoice_payload,
          expires_at: row.expires_at,
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
          invoice_link: null,
        });
      },
    });

    const result = await service.evaluate(buildRequest());

    assert.equal(result.operation, "prepare_offer_invoice_link");
    assert.equal(result.invoice_sku, "payment_media_1");
    assert.equal(result.invoice_amount, 7);
    assert.equal(result.original_invoice_amount, 10);
    assert.equal(result.promo_key, "media_sale");
    assert.equal(result.invoice_payload_json?.original_amount_xtr, 10);
    assert.equal(result.invoice_payload_json?.promo_key, "media_sale");
  });
});

test("feature_offer is routed in TS and keeps feature execution context", async () => {
  const { service } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "feature_offer",
      character_i: 2,
      scene_mode: "fast",
      target_message_id: 777,
    }),
  );

  assert.equal(result.route, "feature_offer");
  assert.equal(result.operation, "feature_offer_required");
  assert.equal(result.chat_id, 101);
  assert.equal(result.invoice_sku, "payment_action_1");
  assert.equal(result.invoice_amount, 50);
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, 777);
});

test("feature_offer applies active sku promotion to action pricing", async () => {
  await withPromotions([
    {
      promo_key: "action_sale",
      items: [{ sku: "payment_action_1", promo_amount_xtr: 35 }],
      starts_at: "2026-09-01T00:00:00+03:00",
      ends_at: "2026-09-30T23:59:59+03:00",
    },
  ], async () => {
    const { service } = createRepository();

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "feature_offer",
        chat_id: 101,
        feature_key: "fast_scene_skip",
      }),
    );

    assert.equal(result.operation, "feature_offer_required");
    assert.equal(result.invoice_sku, "payment_action_1");
    assert.equal(result.invoice_amount, 35);
    assert.equal(result.original_invoice_amount, 50);
    assert.equal(result.promo_key, "action_sale");
  });
});

test("invalid callback returns noop without media context query", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        found: false,
        token: null,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_missing",
      callback_query_id: "cbq-1",
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.callback_valid, false);
  assert.equal(result.callback_answer_text, "text");
  assert.equal(calls.loadMediaContext, 0);
});

test("callback photo request can require invoice link for next media step", async () => {
  const { service } = createRepository({
    async loadMediaContext() {
      return buildMediaContext({
        delivered_in_scene: 3,
        unlocked_items_json: [
          {
            uuid: "u1",
            photo_url: "https://cdn.test/u1.jpg",
            sort_order: 1,
          },
        ],
        next_unseen_json: {
          uuid: "u2",
          photo_url: "https://cdn.test/u2.jpg",
          sort_order: 2,
        },
      });
    },
    async upsertInvoiceToken() {
      return buildStoredInvoiceToken({
        invoice_link: null,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_token",
      callback_query_id: "cbq-2",
    }),
  );

  assert.equal(result.operation, "edit_photo_with_invoice_link");
  assert.equal(result.needs_invoice_link, true);
  assert.equal(result.invoice_token, "inv_token");
  assert.equal(result.photo_url, "https://cdn.test/u1.jpg");
});

test("callback photo request unlocks through scene pass with zero price", async () => {
  const { service } = createRepository({
    async loadMediaContext() {
      return buildMediaContext({
        delivered_in_scene: 3,
        scene_access_active: true,
        next_unseen_json: {
          uuid: "u2",
          photo_url: "https://cdn.test/u2.jpg",
          sort_order: 2,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_token",
      callback_query_id: "cbq-pass",
    }),
  );

  assert.equal(result.operation, "edit_photo");
  assert.equal(result.access_mode, "scene_pass");
  assert.equal(result.log_price_xtr, 0);
  assert.equal(result.price_required, 0);
  assert.equal(result.log_event_type, "media.photo.unlocked.scene_pass");
});

test("pre_checkout validates token and stores decision", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        payload_json: {
          action_kind: "photo_payment",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          media_signature: "hotel_corridor_close",
          target_message_id: 555,
          current_uuid: "u1",
          base_price_xtr: 10,
          requested_action: "photo_request",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-1",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, true);
  assert.equal(calls.storePrecheckoutResult, 1);
  assert.deepEqual(calls.loadInvoiceTokenArgs[0], {
    token: "inv_payload",
    chatId: 101,
  });
});

test("pre_checkout rejects missing row action_kind even if payload action_kind is present", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: null,
        payload_json: {
          action_kind: "photo_payment",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-action-null",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "invoice_action_kind_invalid");
});

test("pre_checkout rejects mismatched row and payload action_kind", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "photo_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-action-mismatch",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "invoice_action_kind_mismatch");
});

test("pre_checkout rejects invoice ownership mismatch", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        found: false,
        token: null,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 999,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-2",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "invoice_not_found");
  assert.equal(calls.markInvoicePaid, 0);
});

test("pre_checkout rejects mismatched payment details", async () => {
  const { service, calls } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-3",
      payment_currency: "USD",
      payment_total_amount: 999,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.precheckout_error, "text");
  assert.equal(calls.storePrecheckoutResult, 1);
});

test("pre_checkout rejects non-invoice payload kind", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        kind: "button_callback",
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-kind",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "invoice_kind_invalid");
});

test("pre_checkout rejects scene unlock invoice after scene reset", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
        },
      });
    },
    async loadSceneAccessStatus() {
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-2",
        subscription_active: false,
        scene_access_active: false,
        scene_is_active: false,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-reset",
      payment_currency: "XTR",
      payment_total_amount: 80,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "scene_invoice_not_active");
});

test("pre_checkout rejects photo invoice after scene pass purchase", async () => {
  const { service } = createRepository({
    async loadSceneAccessStatus() {
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-1",
        subscription_active: false,
        scene_access_active: true,
        scene_is_active: true,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-pass-active",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "scene_access_already_active");
});

test("payment_success activates subscription for subscription invoices", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        amount_xtr: 200,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
    async markInvoicePaid() {
      return buildPaidInvoiceToken({
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        amount_xtr: 200,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
        telegram_invoice_message_id: 777,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-1",
      provider_payment_charge_id: "provider-1",
      payment_currency: "XTR",
      payment_total_amount: 200,
    }),
  );

  assert.equal(result.operation, "subscription_activated");
  assert.equal(result.payment_kind, "subscription");
  assert.equal(result.subscription_sku, "payment_plan_2");
  assert.equal(result.offer_message_id, 777);
  assert.equal(calls.activateSubscription, 1);
});

test("payment_success rejects ownership mismatch", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        found: false,
        token: null,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 999,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-2",
      provider_payment_charge_id: "provider-2",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_not_found");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success resumes fulfillment for a paid photo invoice", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        status: "paid",
        payload_json: {
          action_kind: "photo_payment",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          media_signature: "hotel_corridor_close",
          target_message_id: 555,
          current_uuid: "u1",
          base_price_xtr: 10,
          requested_action: "photo_request",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-3",
      provider_payment_charge_id: "provider-3",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "edit_photo");
  assert.equal(result.payment_kind, "photo");
  assert.equal(result.fulfillment_invoice_token, "inv_payload");
  assert.equal(result.reason, "media_ready");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects missing row action_kind even if payload action_kind is present", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: null,
        payload_json: {
          action_kind: "photo_payment",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-null-row-action",
      provider_payment_charge_id: "provider-null-row-action",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_action_kind_invalid");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects mismatched row and payload action_kind", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "photo_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-action-mismatch",
      provider_payment_charge_id: "provider-action-mismatch",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_action_kind_mismatch");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success resumes after a concurrent payment claim promoted token to paid", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      if (calls.loadInvoiceTokenArgs.length === 1) {
        return buildLoadedInvoiceToken({
          status: "invoice_sent",
        });
      }
      return buildLoadedInvoiceToken({
        status: "paid",
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return null;
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-race",
      provider_payment_charge_id: "provider-race",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "edit_photo");
  assert.equal(result.payment_kind, "photo");
  assert.equal(result.fulfillment_invoice_token, "inv_payload");
  assert.equal(calls.markInvoicePaid, 1);
  assert.equal(calls.loadInvoiceTokenArgs.length, 2);
});

test("payment_success returns idempotent noop for fulfilled token", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        status: "fulfilled",
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-fulfilled",
      provider_payment_charge_id: "provider-fulfilled",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_already_fulfilled");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects invalid active status", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        status: "active",
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-active",
      provider_payment_charge_id: "provider-active",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_status_invalid");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects mismatched payment details", async () => {
  const { service, calls } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-4",
      provider_payment_charge_id: "provider-4",
      payment_currency: "USD",
      payment_total_amount: 999,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_details_mismatch");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects non-invoice payload kind", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        kind: "button_callback",
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-kind",
      provider_payment_charge_id: "provider-kind",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_kind_invalid");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success does not re-activate an already processed subscription", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        amount_xtr: 200,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        amount_xtr: 200,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
    async activateSubscription() {
      calls.activateSubscription += 1;
      return 0;
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-5",
      provider_payment_charge_id: "provider-5",
      payment_currency: "XTR",
      payment_total_amount: 200,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "subscription_already_activated");
  assert.equal(calls.markInvoicePaid, 1);
  assert.equal(calls.activateSubscription, 1);
});

test("payment_success returns deferred feature fulfillment for supported feature keys", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_1",
        amount_xtr: 50,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          media_signature: "hotel_corridor_close",
          target_message_id: 777,
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_1",
        amount_xtr: 50,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          media_signature: "hotel_corridor_close",
          target_message_id: 777,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-feature",
      provider_payment_charge_id: "provider-feature",
      payment_currency: "XTR",
      payment_total_amount: 50,
    }),
  );

  assert.equal(result.operation, "feature_fulfillment_required");
  assert.equal(result.payment_kind, "feature");
  assert.equal(result.feature_key, "fast_scene_skip");
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.reason, "feature_fast_scene_skip_fulfillment_required");
});

test("payment_success activates scene access for scene unlock invoices", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-scene-pass",
      provider_payment_charge_id: "provider-scene-pass",
      payment_currency: "XTR",
      payment_total_amount: 80,
    }),
  );

  assert.equal(result.operation, "scene_access_activated");
  assert.equal(result.payment_kind, "feature");
  assert.equal(result.feature_key, "scene_unlock");
  assert.equal(result.scene_session_id, "scene-1");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.payment_token, "inv_payload");
  assert.equal(calls.activateSceneAccess, 1);
});

test("payment_success returns idempotent scene access result for fulfilled pass token", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        status: "fulfilled",
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-scene-pass-repeat",
      provider_payment_charge_id: "provider-scene-pass-repeat",
      payment_currency: "XTR",
      payment_total_amount: 80,
    }),
  );

  assert.equal(result.operation, "scene_access_activated");
  assert.equal(result.reason, "already_active");
  assert.equal(result.payment_token, "inv_payload");
  assert.equal(calls.activateSceneAccess, 0);
});

test("payment_success rejects stale scene-unlock invoice after user switches scene", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_2",
        amount_xtr: 80,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
        },
      });
    },
    async activateSceneAccess() {
      calls.activateSceneAccess += 1;
      return 0;
    },
    async loadSceneAccessStatus() {
      calls.loadSceneAccessStatus += 1;
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-2",
        subscription_active: false,
        scene_access_active: false,
        scene_is_active: false,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-stale-scene",
      provider_payment_charge_id: "provider-stale-scene",
      payment_currency: "XTR",
      payment_total_amount: 80,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "scene_not_active");
  assert.equal(result.payment_kind, "feature");
  assert.equal(result.feature_key, "scene_unlock");
  assert.equal(calls.markInvoicePaid, 1);
  assert.equal(calls.activateSceneAccess, 1);
});

test("payment_success rejects unknown feature keys", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "feature_unknown_50_xtr",
        amount_xtr: 50,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "unknown_feature",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-bad-feature",
      provider_payment_charge_id: "provider-bad-feature",
      payment_currency: "XTR",
      payment_total_amount: 50,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "feature_key_invalid");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success rejects unknown action kinds", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "mystery_payment",
        payload_json: {
          action_kind: "mystery_payment",
          chat_id: 101,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-unknown-action",
      provider_payment_charge_id: "provider-unknown-action",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "invoice_action_kind_invalid");
  assert.equal(calls.markInvoicePaid, 0);
});

test("subscription_offer returns missing invoice links when links are not stored yet", async () => {
  const { service, calls } = createRepository({
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => {
        const row = input as {
          token: string;
          sku: string;
          amount_xtr: number;
          payload_json: Record<string, unknown>;
        };
        return buildStoredInvoiceToken({
          token: row.token,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          payload_json: row.payload_json,
          invoice_link: null,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:1",
      subscription_offer_reason: "subscription_command",
      turns_today: 0,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_links_needed");
  assert.equal(result.missing_invoice_link_count, 3);
  assert.equal(result.subscription_invoice_tokens?.length, 3);
  assert.deepEqual(result.subscription_invoice_tokens, [
    "telegram:1:scene-1:payment_action_2",
    "telegram:1:payment_plan_2",
    "telegram:1:payment_plan_3",
  ]);
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_action_2", "payment_plan_2", "payment_plan_3"],
  );
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sort_order),
    [0, 1, 2],
  );
  assert.equal(calls.loadStoredInvoiceTokens, 0);
});

test("subscription_offer does not include scene pass without active scene", async () => {
  const { service } = createRepository({
    async loadSceneAccessStatus() {
      return {
        chat_id: 101,
        scene_session_id: null,
        active_scene_session_id: null,
        subscription_active: false,
        scene_access_active: false,
        scene_is_active: false,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      scene_session_id: null,
      active_scene_session_id: null,
      idempotency_key: "telegram:no-scene",
      subscription_offer_reason: "subscription_command",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_links_needed");
  assert.deepEqual(result.subscription_invoice_tokens, [
    "telegram:no-scene:payment_plan_2",
    "telegram:no-scene:payment_plan_3",
  ]);
});

test("subscription_offer does not include scene pass after purchase", async () => {
  const { service } = createRepository({
    async loadSceneAccessStatus() {
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-1",
        subscription_active: false,
        scene_access_active: true,
        scene_is_active: true,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:pass-active",
      subscription_offer_reason: "daily_turn_limit",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_links_needed");
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
});

test("subscription_offer keeps subscription priority over scene pass", async () => {
  const { service } = createRepository({
    async loadSceneAccessStatus() {
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-1",
        subscription_active: true,
        scene_access_active: false,
        scene_is_active: true,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:sub-active",
      subscription_offer_reason: "subscription_command",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_links_needed");
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
});

test("subscription_offer applies promotions by sku and last active match wins", async () => {
  await withPromotions([
    {
      promo_key: "all_sale",
      items: [
        { sku: "payment_action_2", promo_amount_xtr: 70 },
        { sku: "payment_plan_2", promo_amount_xtr: 150 },
        { sku: "payment_plan_3", promo_amount_xtr: 180 },
      ],
      starts_at: "2026-09-01T00:00:00+03:00",
      ends_at: "2026-09-30T23:59:59+03:00",
    },
    {
      promo_key: "plan_2_override",
      items: [{ sku: "payment_plan_2", promo_amount_xtr: 140 }],
      starts_at: "2026-09-01T00:00:00+03:00",
      ends_at: "2026-09-30T23:59:59+03:00",
    },
  ], async () => {
    const capturedRows: StoredInvoiceToken[] = [];
    const { service } = createRepository({
      async upsertInvoiceTokens(inputs) {
        const rows = (Array.isArray(inputs) ? inputs : []).map((input) => {
          const row = input as {
            token: string;
            kind: string;
            chat_id: number;
            payload_json: Record<string, unknown>;
            sku: string;
            amount_xtr: number;
            telegram_invoice_payload: string;
            expires_at: string | null;
            invoice_title: string;
            invoice_description: string;
            invoice_label: string;
            invoice_button_text: string;
          };

          return buildStoredInvoiceToken({
            token: row.token,
            kind: row.kind,
            chat_id: row.chat_id,
            scene_session_id: null,
            turn_no: null,
            scene_turn_no: null,
            payload_json: row.payload_json,
            sku: row.sku,
            amount_xtr: row.amount_xtr,
            telegram_invoice_payload: row.telegram_invoice_payload,
            expires_at: row.expires_at,
            invoice_title: row.invoice_title,
            invoice_description: row.invoice_description,
            invoice_label: row.invoice_label,
            invoice_button_text: row.invoice_button_text,
            invoice_link: null,
          });
        });
        capturedRows.push(...rows);
        return rows;
      },
      async loadStoredInvoiceTokens() {
        return capturedRows;
      },
    });

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:1",
        subscription_offer_reason: "subscription_command",
        turns_today: 0,
        turn_limit: 20,
        turn_limit_reset_text: "00:00 МСК",
      }),
    );

    assert.equal(result.operation, "subscription_offer_links_needed");
    assert.deepEqual(
      result.missing_invoice_items?.map((item) => item.amount_xtr),
      [70, 140, 180],
    );
    assert.deepEqual(
      result.missing_invoice_items?.map((item) => item.original_amount_xtr),
      [80, 200, 300],
    );
    assert.deepEqual(
      result.missing_invoice_items?.map((item) => item.promo_key),
      ["all_sale", "plan_2_override", "all_sale"],
    );
    assert.deepEqual(
      result.subscription_offer_items?.map((item) => item.amount_xtr),
      [70, 140, 180],
    );
  });
});

test("subscription_offer becomes ready after created links are persisted", async () => {
  const { service, calls } = createRepository({
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => {
        const row = input as { token: string; sku: string; amount_xtr: number };
        return buildStoredInvoiceToken({
          token: row.token,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          invoice_link: null,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return tokens.map((token, index) =>
        buildStoredInvoiceToken({
          token,
          sku:
            index === 0 ? "payment_action_2" : index === 1 ? "payment_plan_2" : "payment_plan_3",
          amount_xtr: index === 0 ? 80 : index === 1 ? 200 : 300,
          invoice_title:
            "text",
          invoice_description: "text",
          invoice_label:
            "text",
          invoice_button_text:
            "text",
          payload_json: {
            action_kind: index === 0 ? "feature_payment" : "subscription_payment",
            feature_key: index === 0 ? "scene_unlock" : null,
            sort_order: index,
            subscription_days: index === 0 ? null : index === 1 ? 14 : 30,
            subscription_offer_reason: "daily_turn_limit",
            turn_limit: 20,
            turns_today: 20,
            turn_limit_reset_text: "00:00 МСК",
          },
          invoice_link: `https://t.me/invoice-${index + 1}`,
          telegram_invoice_message_id: 900,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        }),
      );
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:1",
      subscription_offer_reason: "daily_turn_limit",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
      created_invoice_links: [
        {
          token: "telegram:1:scene-1:payment_action_2",
          invoice_link: "https://t.me/invoice-1",
        },
        {
          token: "telegram:1:payment_plan_2",
          invoice_link: "https://t.me/invoice-2",
        },
        {
          token: "telegram:1:payment_plan_3",
          invoice_link: "https://t.me/invoice-3",
        },
      ],
    }),
  );

  assert.equal(calls.storeInvoiceLinks, 1);
  assert.equal(calls.loadStoredInvoiceTokens, 1);
  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.offer_reused, true);
  assert.equal(result.text, "text");
  assert.equal(result.reply_markup?.inline_keyboard.length, 3);
});

test("subscription_offer reuses stored invoice links from batch upsert without reload", async () => {
  const { service, calls } = createRepository({
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input, index) => {
        const row = input as {
          token: string;
          kind: string;
          chat_id: number;
          payload_json: Record<string, unknown>;
          sku: string;
          amount_xtr: number;
          telegram_invoice_payload: string;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        };
        return buildStoredInvoiceToken({
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
          payload_json: row.payload_json,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          telegram_invoice_payload: row.telegram_invoice_payload,
          expires_at: row.expires_at,
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
          invoice_link: `https://t.me/reused-${index + 1}`,
          telegram_invoice_message_id: 901,
          stored: false,
        });
      });
    },
    async loadStoredInvoiceTokens() {
      throw new Error("loadStoredInvoiceTokens should not run when batch upsert already has links");
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:reuse",
      subscription_offer_reason: "subscription_command",
      turns_today: 1,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(calls.storeInvoiceLinks, 0);
  assert.equal(calls.loadStoredInvoiceTokens, 0);
  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.reply_markup?.inline_keyboard.length, 3);
  assert.equal(result.offer_reused, true);
});

test("prepare_offer uses random unique invoice tokens for photo payments", async () => {
  const { service } = createRepository({
    async loadOfferStats() {
      return buildOfferStats({
        delivered_in_scene: 3,
        unseen_available: 2,
      });
    },
    async upsertInvoiceToken(input) {
      const row = input as {
        token: string;
        telegram_invoice_payload: string;
        sku: string;
        amount_xtr: number;
      };
      return buildStoredInvoiceToken({
        token: row.token,
        telegram_invoice_payload: row.telegram_invoice_payload,
        sku: row.sku,
        amount_xtr: row.amount_xtr,
        invoice_link: null,
      });
    },
  });

  const first = await service.evaluate(buildRequest());
  const second = await service.evaluate(buildRequest());

  assert.equal(first.operation, "prepare_offer_invoice_link");
  assert.equal(second.operation, "prepare_offer_invoice_link");
  assert.notEqual(first.invoice_token, second.invoice_token);
});

test("finalize_photo_event is idempotent when the same photo event is retried", async () => {
  const { service } = createRepository({
    async storePhotoEvent() {
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 10,
        panel_message_id: 555,
        stored_count: 0,
        invoice_rows_updated: 0,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "finalize_photo_event",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      log_event_type: "media.photo.unlocked.paid",
      media_signature: "hotel_corridor_close",
      selected_uuid: "u2",
      panel_message_id: 555,
      log_price_xtr: 10,
      access_mode: "paid",
      action_kind: "photo_payment",
      fulfillment_invoice_token: "inv_payload",
      invoice_token: "inv_next",
      invoice_link: "https://t.me/invoice-next",
      price_required: 10,
    }),
  );

  assert.equal(result.operation, "photo_event_stored");
  assert.equal(result.stored_count, 0);
  assert.equal(result.reason, "photo_event_skipped");
});

test("finalize_offer stores panel_text for photo caption persistence", async () => {
  const capturedInput: { current: Record<string, unknown> | null } = {
    current: null,
  };
  const { service } = createRepository({
    async storePanel(input) {
      capturedInput.current = input as Record<string, unknown>;
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 10,
        panel_message_id: 700,
        stored_count: 1,
        invoice_rows_updated: 1,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "finalize_offer",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      media_signature: "hotel_corridor_close",
      panel_message_id: 700,
      price_required: 10,
      panel_text: "Original bot message for photo caption",
    }),
  );

  assert.equal(result.operation, "finalized_panel");
  assert.equal(result.stored_count, 1);
  assert.equal(
    capturedInput.current?.panel_text,
    "Original bot message for photo caption",
  );
});

test("callback photo request returns panel_text as caption_text", async () => {
  const { service } = createRepository({
    async loadMediaContext() {
      return buildMediaContext({
        panel_text: "Original bot message for photo caption",
        panel_entities_json: [],
        delivered_in_scene: 0,
        next_unseen_json: {
          uuid: "u2",
          photo_url: "https://cdn.test/u2.jpg",
          sort_order: 2,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_token",
      callback_query_id: "cbq-caption",
    }),
  );

  assert.equal(result.operation, "edit_photo");
  assert.equal(result.caption_text, "Original bot message for photo caption");
  assert.deepEqual(result.caption_entities_json, []);
});

test("callback photo request truncates caption_text over 1024 chars", async () => {
  const longText = "x".repeat(1100);
  const { service } = createRepository({
    async loadMediaContext() {
      return buildMediaContext({
        panel_text: longText,
        panel_entities_json: [{ type: "bold" }],
        delivered_in_scene: 0,
        next_unseen_json: {
          uuid: "u2",
          photo_url: "https://cdn.test/u2.jpg",
          sort_order: 2,
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_token",
      callback_query_id: "cbq-long-caption",
    }),
  );

  assert.equal(result.operation, "edit_photo");
  assert.ok(result.caption_text!.length <= 1024);
  assert.ok(result.caption_text!.endsWith("..."));
  assert.deepEqual(result.caption_entities_json, []);
});
