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

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.TURN_LIMIT ??= "15";
process.env.BUSINESS_TIME_ZONE ??= "Europe/Moscow";
process.env.TURN_LIMIT_RESET_TEXT ??= "00:00 МСК";
process.env.MEDIA_STORAGE_BASE_URL ??= "https://media.example.com";

const { MediaCommerceDecisionService } = await import(
  "../src/mediaCommerceDecisionService.js"
);

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
    sku: "media_photo_10_xtr",
    amount_xtr: 10,
    telegram_invoice_payload: "inv_token",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    telegram_invoice_message_id: null,
    invoice_link: null,
    stored: true,
    invoice_title: "Фото",
    invoice_description: "Открыть фото",
    invoice_label: "Фото",
    invoice_button_text: "Получить фото • 10 Stars",
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
    sku: "media_photo_10_xtr",
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
    sku: "media_photo_10_xtr",
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
    loadCallbackTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    loadInvoiceTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    markInvoicePaid: 0,
    activateSubscription: 0,
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
      return tokens.map((token, index) =>
        buildStoredInvoiceToken({
          token,
          sku: index === 0 ? "media_sub_14d" : "media_sub_30d",
          amount_xtr: index === 0 ? 100 : 200,
          invoice_title: index === 0 ? "Subscription plan A" : "Subscription plan B",
          invoice_description: "Subscription access",
          invoice_label: index === 0 ? "Plan A" : "Plan B",
          invoice_button_text: index === 0 ? "Plan A" : "Plan B",
          payload_json: {
            subscription_days: index === 0 ? 14 : 30,
            subscription_offer_reason: "subscription_command",
            turn_limit: 15,
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
  assert.equal(first.reply_markup?.inline_keyboard[0]?.[0]?.text, "Получить фото");
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
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, 777);
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
  assert.equal(result.callback_answer_text, "Кнопка устарела.");
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
          subscription_sku: "media_sub_14d",
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
  assert.equal(result.precheckout_error, "Сумма счёта больше не совпадает.");
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

test("payment_success activates subscription for subscription invoices", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "subscription_payment",
        sku: "media_sub_14d",
        amount_xtr: 100,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "media_sub_14d",
        },
      });
    },
    async markInvoicePaid() {
      return buildPaidInvoiceToken({
        action_kind: "subscription_payment",
        sku: "media_sub_14d",
        amount_xtr: 100,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "media_sub_14d",
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
      payment_total_amount: 100,
    }),
  );

  assert.equal(result.operation, "subscription_activated");
  assert.equal(result.payment_kind, "subscription");
  assert.equal(result.subscription_sku, "media_sub_14d");
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
          subscription_sku: "media_sub_14d",
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
        sku: "media_sub_14d",
        amount_xtr: 100,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "media_sub_14d",
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        action_kind: "subscription_payment",
        sku: "media_sub_14d",
        amount_xtr: 100,
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "media_sub_14d",
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
      payment_total_amount: 100,
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
        sku: "feature_fast_scene_skip_50_xtr",
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
        sku: "feature_fast_scene_skip_50_xtr",
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
  const { service } = createRepository({
    async upsertInvoiceToken(input) {
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
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:1",
      subscription_offer_reason: "subscription_command",
      turns_today: 0,
      turn_limit: 15,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_links_needed");
  assert.equal(result.missing_invoice_link_count, 2);
  assert.equal(result.subscription_invoice_tokens?.length, 2);
  assert.deepEqual(result.subscription_invoice_tokens, [
    "telegram:1:media_sub_14d",
    "telegram:1:media_sub_30d",
  ]);
});

test("subscription_offer becomes ready after created links are persisted", async () => {
  const { service, calls } = createRepository({
    async upsertInvoiceToken(input) {
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
    },
    async loadStoredInvoiceTokens(tokens) {
      return tokens.map((token, index) =>
        buildStoredInvoiceToken({
          token,
          sku: index === 0 ? "media_sub_14d" : "media_sub_30d",
          amount_xtr: index === 0 ? 100 : 200,
          invoice_title: index === 0 ? "Subscription plan A" : "Subscription plan B",
          invoice_description: "Subscription access",
          invoice_label: index === 0 ? "Plan A" : "Plan B",
          invoice_button_text: index === 0 ? "Plan A" : "Plan B",
          payload_json: {
            subscription_days: index === 0 ? 14 : 30,
            subscription_offer_reason: "daily_turn_limit",
            turn_limit: 15,
            turns_today: 15,
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
      turns_today: 15,
      turn_limit: 15,
      turn_limit_reset_text: "00:00 МСК",
      created_invoice_links: [
        {
          token: "telegram:1:media_sub_14d",
          invoice_link: "https://t.me/invoice-1",
        },
        {
          token: "telegram:1:media_sub_30d",
          invoice_link: "https://t.me/invoice-2",
        },
      ],
    }),
  );

  assert.equal(calls.storeInvoiceLinks, 1);
  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.offer_reused, true);
  assert.match(result.text ?? "", /лимит исчерпан/u);
  assert.equal(result.reply_markup?.inline_keyboard.length, 2);
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
