import test from "node:test";
import assert from "node:assert/strict";
import type {
  AbTestAssignment,
  InteractionTokenRow,
  LoadedCallbackToken,
  FreeActionRedeemResult,
  FreeCredits,
  LoadedInvoiceToken,
  MediaContext,
  MediaOfferItem,
  MediaOfferStats,
  MediaPaymentOption,
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

const {
  MediaCommerceDecisionService,
  MediaCommerceOperationError,
  buildPaymentOption,
} = await import("../src/mediaCommerceDecisionService.js");
const { buildMediaAction } = await import("../src/mediaCommerce/mediaAction.js");
const { toPaidInvoiceToken } = await import("../src/mediaCommerce/paymentFlow.js");
const { buildSubscriptionPaymentInputs } = await import(
  "../src/mediaCommerce/subscriptionFlow.js"
);
const { MediaRepositoryContractError } = await import(
  "../src/mediaCommerceRepository/errors.js"
);
const { config } = await import("../src/config.js");
const { SbpPaymentError } = await import("../src/payments/sbp.js");
const { TelegramStarsInvoiceError } = await import("../src/payments/stars.js");
const {
  buildAssignment,
  loadExperimentConfigsFromEnv,
} = await import("../src/abTesting.js");

type MockRepository = {
  loadOfferStats: (
    input: unknown,
  ) => Promise<MediaOfferStats>;
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
  ) => Promise<MediaContext>;
  loadPhotoByUuid: (uuid: string) => Promise<{
    uuid: string;
    bucket_name: string | null;
    storage_path: string | null;
    sort_order: number | null;
    photo_url: string | null;
  } | null>;
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
  loadInvoiceTokenByExternalPaymentId: (
    externalPaymentId: string | null,
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
  loadFreeCredits: (
    chatId: number,
  ) => Promise<FreeCredits | null>;
  redeemFreeFastSceneSkip: (
    token: string | null,
    chatId: number | null,
  ) => Promise<FreeActionRedeemResult | null>;
  redeemFreeSceneUnlock: (
    token: string | null,
    chatId: number | null,
  ) => Promise<FreeActionRedeemResult | null>;
  redeemFreePhotoUnlock: (
    token: string | null,
    chatId: number | null,
  ) => Promise<FreeActionRedeemResult | null>;
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
  finalizeFreePhotoUnlock: MockRepository["storePhotoEvent"];
  storeInvoiceLinks: (items: unknown) => Promise<number>;
  claimSbpCheckoutCreation: (
    token: string | null,
    chatId: number | null,
  ) => Promise<{
    token: string | null;
    chat_id: number | null;
    checkout_url: string | null;
    external_payment_id: string | null;
    claim_acquired: boolean;
  } | null>;
  releaseSbpCheckoutCreation: (
    token: string | null,
    chatId: number | null,
  ) => Promise<number>;
  markSbpCheckoutCreationUncertain: (
    token: string,
    chatId: number,
  ) => Promise<number>;
  markSbpInvoiceCanceled: (externalPaymentId: string) => Promise<number>;
  markSbpInvoiceExpired: (token: string, chatId: number) => Promise<number>;
  recordSbpStatusConflict: (
    externalPaymentId: string,
    providerStatus: string,
  ) => Promise<number>;
  recordSbpProviderEvent: (
    input: unknown,
  ) => Promise<number>;
  loadStoredInvoiceTokens: (
    tokens: string[],
  ) => Promise<StoredInvoiceToken[]>;
  loadActiveSubscriptionOfferId: (chatId: number) => Promise<string | null>;
  loadAbTestAssignment: (
    chatId: number,
    assignmentKey: string,
  ) => Promise<AbTestAssignment | null>;
  storeAbTestAssignment: (
    chatId: number,
    assignmentKey: string,
    assignment: AbTestAssignment,
  ) => Promise<AbTestAssignment | null>;
  storeSubscriptionOfferMessageId: (
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ) => Promise<number>;
  clearActiveSubscriptionOffer: (
    chatId: number,
    offerId: string | null,
  ) => Promise<number>;
  recordAbTestDelivered: (
    input: unknown,
  ) => Promise<number>;
};

type MockStarsClient = {
  createStarsInvoice: (input: unknown) => Promise<{ invoice_link: string }>;
};

type MockSbpClient = {
  createPayment: (
    input: unknown,
  ) => Promise<{
    external_payment_id: string;
    checkout_url: string;
    provider_expires_at: string | null;
  }>;
  getTransactionStatus?: (externalPaymentId: string) => Promise<"CANCELED" | "PENDING" | "CONFIRMED" | "CHARGEBACKED" | null>;
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
      photo_sku: "payment_media_1",
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
    photo_sku: "payment_media_1",
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

test("media action caps each panel at five new photos while keeping navigation", () => {
  const unlockedItems = [1, 2, 3, 4, 5].map((index) => ({
    uuid: `u${index}`,
    photo_url: `https://cdn.test/u${index}.jpg`,
    sort_order: index,
  }));
  const fifthPhotoPayment = buildMediaAction(buildMediaContext({
    delivered_in_scene: 3,
    panel_unlocked_count: 4,
    unlocked_items_json: unlockedItems.slice(0, 4),
    current_uuid: "u4",
    next_unseen_json: {
      uuid: "u5",
      photo_url: "https://cdn.test/u5.jpg",
      sort_order: 5,
    },
  }));
  const cappedRequest = buildMediaAction(buildMediaContext({
    delivered_in_scene: 3,
    panel_unlocked_count: 5,
    unlocked_items_json: unlockedItems,
    current_uuid: "u5",
    next_unseen_json: {
      uuid: "u6",
      photo_url: "https://cdn.test/u6.jpg",
      sort_order: 6,
    },
  }));
  const cappedNavigation = buildMediaAction(buildMediaContext({
    action_kind: "photo_next",
    delivered_in_scene: 3,
    panel_unlocked_count: 5,
    unlocked_items_json: unlockedItems,
    current_uuid: "u5",
    next_unseen_json: {
      uuid: "u6",
      photo_url: "https://cdn.test/u6.jpg",
      sort_order: 6,
    },
  }));

  assert.equal(fifthPhotoPayment.operation, "edit_photo");
  assert.equal(fifthPhotoPayment.invoice_sku, "payment_media_1");
  assert.equal(cappedRequest.operation, "noop");
  assert.equal(cappedRequest.invoice_sku, null);
  assert.equal(cappedRequest.token_rows.length, 0);
  assert.equal(cappedNavigation.operation, "edit_photo");
  assert.equal(cappedNavigation.selected_uuid, "u1");
  assert.equal(cappedNavigation.invoice_sku, null);
});

function buildStoredInvoiceToken(
  overrides: Partial<StoredInvoiceToken> = {},
): StoredInvoiceToken {
  const base: StoredInvoiceToken = {
    token: "inv_token",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    payload_json: {},
    sku: "payment_media_1",
    payment_source: "stars",
    amount: 10,
    currency: "XTR",
    checkout_url: null,
    external_payment_id: null,
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
  };

  const merged = { ...base, ...overrides };
  const paymentSource = merged.payment_source ?? "stars";
  const checkoutUrl =
    overrides.checkout_url
    ?? overrides.invoice_link
    ?? merged.checkout_url
    ?? merged.invoice_link
    ?? null;
  const amount =
    overrides.amount
    ?? (paymentSource === "sbp"
      ? merged.amount ?? null
      : overrides.amount_xtr ?? merged.amount_xtr ?? merged.amount ?? null);
  const currency =
    overrides.currency
    ?? (paymentSource === "sbp" ? "RUB" : "XTR");

  return {
    ...merged,
    payment_source: paymentSource,
    amount,
    currency,
    checkout_url: checkoutUrl,
    invoice_link: paymentSource === "stars" ? checkoutUrl : merged.invoice_link ?? null,
  };
}

function buildLoadedInvoiceToken(
  overrides: Partial<LoadedInvoiceToken> = {},
): LoadedInvoiceToken {
  const base: LoadedInvoiceToken = {
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
      photo_sku: "payment_media_1",
      requested_action: "photo_request",
    },
    status: "invoice_sent",
    action_kind: "photo_payment",
    sku: "payment_media_1",
    payment_source: "stars",
    amount: 10,
    currency: "XTR",
    checkout_url: null,
    external_payment_id: null,
    amount_xtr: 10,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    telegram_invoice_message_id: null,
    found: true,
  };

  const merged = { ...base, ...overrides };
  const paymentSource = merged.payment_source ?? "stars";

  return {
    ...merged,
    payment_source: paymentSource,
    amount:
      overrides.amount
      ?? (paymentSource === "sbp"
        ? merged.amount ?? null
        : overrides.amount_xtr ?? merged.amount_xtr ?? merged.amount ?? null),
    currency:
      overrides.currency
      ?? (paymentSource === "sbp" ? "RUB" : "XTR"),
    checkout_url:
      overrides.checkout_url
      ?? merged.checkout_url
      ?? null,
  };
}

function buildPaidInvoiceToken(
  overrides: Partial<PaidInvoiceToken> = {},
): PaidInvoiceToken {
  const base: PaidInvoiceToken = {
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
      photo_sku: "payment_media_1",
      requested_action: "photo_request",
    },
    status: "paid",
    action_kind: "photo_payment",
    sku: "payment_media_1",
    payment_source: "stars",
    amount: 10,
    currency: "XTR",
    checkout_url: null,
    external_payment_id: null,
    amount_xtr: 10,
    telegram_invoice_message_id: null,
  };

  const merged = { ...base, ...overrides };
  const paymentSource = merged.payment_source ?? "stars";

  return {
    ...merged,
    payment_source: paymentSource,
    amount:
      overrides.amount
      ?? (paymentSource === "sbp"
        ? merged.amount ?? null
        : overrides.amount_xtr ?? merged.amount_xtr ?? merged.amount ?? null),
    currency:
      overrides.currency
      ?? (paymentSource === "sbp" ? "RUB" : "XTR"),
  };
}

function findPaymentOption(
  options: MediaPaymentOption[] | null | undefined,
  source: "stars" | "sbp",
): MediaPaymentOption | null {
  return (options ?? []).find((item) => item.source === source) ?? null;
}

function firstOfferPaymentOption(
  offerItem: MediaOfferItem | null | undefined,
  source: "stars" | "sbp" = "stars",
): MediaPaymentOption | null {
  return findPaymentOption(offerItem?.payment_options, source);
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
    photo_sku: "payment_media_1",
    should_offer: true,
    ...overrides,
  };
}

function buildSbpSubscriptionPayload(
  offerId = "telegram:offer-1",
  sku = "payment_plan_2",
  days = 7,
): Record<string, unknown> {
  return {
    action_kind: "subscription_payment",
    idempotency_key: offerId,
    subscription_days: days,
    subscription_sku: sku,
  };
}

test("toPaidInvoiceToken preserves valid paid persisted payload", () => {
  const paid = toPaidInvoiceToken(buildLoadedInvoiceToken({
    status: "paid",
    payload_json: { action_kind: "photo_payment", current_uuid: "u1" },
  }));

  assert.ok(paid);
  assert.equal(paid.token, "inv_payload");
  assert.equal(paid.status, "paid");
  assert.deepEqual(paid.payload_json, {
    action_kind: "photo_payment",
    current_uuid: "u1",
  });
});

test("toPaidInvoiceToken rejects fake paid defaults", () => {
  assert.throws(
    () => toPaidInvoiceToken(buildLoadedInvoiceToken({ status: null })),
    MediaRepositoryContractError,
  );
  assert.throws(
    () => toPaidInvoiceToken(buildLoadedInvoiceToken({ status: "invoice_sent" })),
    MediaRepositoryContractError,
  );
  assert.throws(
    () => toPaidInvoiceToken(buildLoadedInvoiceToken({
      status: "paid",
      payload_json: null,
    })),
    MediaRepositoryContractError,
  );
  assert.throws(
    () => toPaidInvoiceToken(buildLoadedInvoiceToken({
      status: "paid",
      payload_json: "not-json" as never,
    })),
    MediaRepositoryContractError,
  );
});

test("buildPaymentOption requires explicit persisted payment fields", () => {
  const valid = buildStoredInvoiceToken({
    payment_source: "stars",
    amount: 10,
    currency: "XTR",
    checkout_url: null,
    invoice_link: "https://t.me/invoice",
    payload_json: { action_kind: "photo_payment" },
  });

  assert.equal(buildPaymentOption(valid).checkout_url, "https://t.me/invoice");

  for (const row of [
    { ...valid, payment_source: null },
    { ...valid, currency: null },
    { ...valid, amount: null },
    { ...valid, checkout_url: null, invoice_link: null },
    { ...valid, payload_json: null as never },
  ] as StoredInvoiceToken[]) {
    assert.throws(() => buildPaymentOption(row), MediaRepositoryContractError);
  }
});

test("subscription payment inputs do not fabricate SBP amount", () => {
  const previousEnabled = config.SBP_ENABLED;
  config.SBP_ENABLED = true;
  try {
    const rows = buildSubscriptionPaymentInputs({
      chat_id: 101,
      idempotency_key: "idem-1",
      subscription_offer_reason: "subscription_command",
      turn_limit: 20,
      turns_today: 0,
      turn_limit_reset_text: "00:00 МСК",
      sort_order: 0,
      plan: {
        sku: "payment_plan_2",
        days: 14,
        amount_xtr: 200,
        amount_rub: null,
        title: "Plan",
        description: "Desc",
        label: "Label",
        button_text: "Button",
      },
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payment_source, "stars");
    assert.equal(rows[0]?.expires_at, null);
  } finally {
    config.SBP_ENABLED = previousEnabled;
  }
});

function createRepository(
  overrides: Partial<MockRepository> = {},
  starsOverrides: Partial<MockStarsClient> = {},
  sbpOverrides: Partial<MockSbpClient> = {},
) {
  const calls = {
    loadMediaContext: 0,
    loadPhotoByUuid: 0,
    storePrecheckoutResult: 0,
    storeInvoiceLinks: 0,
    loadStoredInvoiceTokens: 0,
    createStarsInvoice: 0,
    createStarsInvoiceInputs: [] as unknown[],
    createSbpPayment: 0,
    createSbpPaymentInputs: [] as unknown[],
    claimSbpCheckoutCreation: 0,
    releaseSbpCheckoutCreation: 0,
    markSbpCheckoutCreationUncertain: 0,
    markSbpInvoiceCanceled: 0,
    markSbpInvoiceExpired: 0,
    recordSbpStatusConflict: 0,
    recordSbpStatusConflictArgs: [] as Array<{
      externalPaymentId: string;
      providerStatus: string;
    }>,
    recordSbpProviderEvent: 0,
    recordSbpProviderEventArgs: [] as unknown[],
    loadCallbackTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    loadInvoiceTokenArgs: [] as Array<{ token: string | null; chatId: number | null }>,
    loadInvoiceTokenByExternalPaymentIdArgs: [] as Array<string | null>,
    markInvoicePaid: 0,
    activateSubscription: 0,
    activateSceneAccess: 0,
    loadSceneAccessStatus: 0,
    loadFreeCredits: 0,
    redeemFreeFastSceneSkip: 0,
    redeemFreeSceneUnlock: 0,
    redeemFreePhotoUnlock: 0,
    loadAbTestAssignment: 0,
    storeAbTestAssignment: 0,
    recordAbTestDelivered: 0,
    clearActiveSubscriptionOffer: 0,
    clearActiveSubscriptionOfferArgs: [] as Array<{
      chatId: number;
      offerId: string | null;
    }>,
  };
  const storedInvoiceRows = new Map<string, StoredInvoiceToken>();

  const repository: MockRepository = {
    async loadOfferStats() {
      return buildOfferStats();
    },
    async upsertCallbackTokens(tokenRows) {
      return tokenRows.length;
    },
    async upsertInvoiceToken(input) {
      const row = (input ?? {}) as {
        token?: string;
        kind?: string;
        chat_id?: number;
        scene_session_id?: string | null;
        turn_no?: number | null;
        scene_turn_no?: number | null;
        payload_json?: Record<string, unknown>;
        action_kind?: string;
        sku?: string;
        payment_source?: "stars" | "sbp";
        amount?: number | null;
        currency?: "XTR" | "RUB";
        amount_xtr?: number;
        telegram_invoice_payload?: string;
        checkout_url?: string | null;
        external_payment_id?: string | null;
        expires_at?: string | null;
        invoice_title?: string;
        invoice_description?: string;
        invoice_label?: string;
        invoice_button_text?: string;
        invoice_link?: string | null;
      };

      const stored = buildStoredInvoiceToken({
        token: row.token ?? "inv_token",
        kind: row.kind ?? "invoice_payload",
        chat_id: row.chat_id ?? 101,
        scene_session_id: row.scene_session_id ?? "scene-1",
        turn_no: row.turn_no ?? 5,
        scene_turn_no: row.scene_turn_no ?? 3,
        payload_json: row.payload_json ?? {},
        action_kind: row.action_kind ?? "photo_payment",
        sku: row.sku ?? "payment_media_1",
        payment_source: row.payment_source ?? "stars",
        amount: row.amount ?? row.amount_xtr ?? 10,
        currency: row.currency ?? (row.payment_source === "sbp" ? "RUB" : "XTR"),
        checkout_url: row.checkout_url ?? null,
        external_payment_id: row.external_payment_id ?? null,
        amount_xtr: row.amount_xtr ?? 10,
        telegram_invoice_payload: row.telegram_invoice_payload ?? row.token ?? "inv_token",
        expires_at: row.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
        invoice_title: row.invoice_title ?? "text",
        invoice_description: row.invoice_description ?? "text",
        invoice_label: row.invoice_label ?? "text",
        invoice_button_text: row.invoice_button_text ?? "text",
        invoice_link: row.invoice_link ?? null,
      });
      storedInvoiceRows.set(stored.token, stored);
      return stored;
    },
    async upsertInvoiceTokens(inputs) {
      const rows = Array.isArray(inputs) ? inputs : [];
      return rows.map((input, index) => {
        const row = input as {
          token?: string;
          kind?: string;
          chat_id?: number;
          payload_json?: Record<string, unknown>;
          action_kind?: string;
          sku?: string;
          payment_source?: "stars" | "sbp";
          amount?: number | null;
          currency?: "XTR" | "RUB";
          amount_xtr?: number;
          telegram_invoice_payload?: string;
          checkout_url?: string | null;
          external_payment_id?: string | null;
          expires_at?: string | null;
          invoice_title?: string;
          invoice_description?: string;
          invoice_label?: string;
          invoice_button_text?: string;
        };
        const stored = buildStoredInvoiceToken({
          token: row.token ?? `token-${index + 1}`,
          kind: row.kind ?? "invoice_payload",
          chat_id: row.chat_id ?? 101,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
          payload_json: row.payload_json ?? {},
          action_kind: row.action_kind ?? "photo_payment",
          sku: row.sku ?? `payment_plan_${index + 1}`,
          payment_source: row.payment_source ?? "stars",
          amount: row.amount ?? row.amount_xtr ?? (index + 1) * 100,
          currency: row.currency ?? (row.payment_source === "sbp" ? "RUB" : "XTR"),
          checkout_url: row.checkout_url ?? null,
          external_payment_id: row.external_payment_id ?? null,
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
        storedInvoiceRows.set(stored.token, stored);
        return stored;
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
    async loadPhotoByUuid(uuid) {
      calls.loadPhotoByUuid += 1;
      return {
        uuid,
        bucket_name: "media_bucket",
        storage_path: `${uuid}.jpg`,
        sort_order: 2,
        photo_url: `https://cdn.test/${uuid}.jpg`,
      };
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
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 80,
        currency: "RUB",
        checkout_url: "https://sbp.example/checkout/1",
        external_payment_id: "sbp-payment-1",
      });
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
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 0,
        free_scene_unlocks: 0,
      };
    },
    async redeemFreeFastSceneSkip(token, chatId) {
      calls.redeemFreeFastSceneSkip += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: chatId,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          media_signature: "hotel_corridor_close",
          target_message_id: 777,
          feature_key: "fast_scene_skip",
        },
        action_kind: "free_fast_scene_skip",
        status: "active",
        redeemed: true,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "redeemed",
      };
    },
    async redeemFreeSceneUnlock(token, chatId) {
      calls.redeemFreeSceneUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: chatId,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          target_message_id: 777,
          feature_key: "scene_unlock",
        },
        action_kind: "free_scene_unlock",
        status: "fulfilled",
        redeemed: true,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "redeemed",
      };
    },
    async redeemFreePhotoUnlock(token, chatId) {
      calls.redeemFreePhotoUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_photo_unlock",
          chat_id: chatId,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          media_signature: "hotel_corridor_close",
          target_message_id: 777,
          current_uuid: "u1",
          base_price_xtr: 10,
          requested_action: "photo_regen",
          free_photo_uuid: "u2",
        },
        action_kind: "free_photo_unlock",
        status: "active",
        redeemed: true,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "redeemed",
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
    async finalizeFreePhotoUnlock() {
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 0,
        panel_message_id: 555,
        stored_count: 1,
        invoice_rows_updated: 1,
      };
    },
    async storeInvoiceLinks(items) {
      calls.storeInvoiceLinks += 1;
      for (const item of Array.isArray(items) ? items : []) {
        const update = item as {
          token?: string | null;
          invoice_link?: string | null;
          checkout_url?: string | null;
          external_payment_id?: string | null;
        };
        if (!update.token) continue;
        const existing = storedInvoiceRows.get(update.token);
        if (!existing) continue;
        storedInvoiceRows.set(update.token, {
          ...existing,
          invoice_link: update.invoice_link ?? existing.invoice_link,
          checkout_url: update.checkout_url ?? existing.checkout_url,
          external_payment_id:
            update.external_payment_id ?? existing.external_payment_id,
        });
      }
      return 1;
    },
    async claimSbpCheckoutCreation(token, chatId) {
      calls.claimSbpCheckoutCreation += 1;
      return {
        token,
        chat_id: chatId,
        checkout_url: null,
        external_payment_id: null,
        claim_acquired: true,
      };
    },
    async releaseSbpCheckoutCreation() {
      calls.releaseSbpCheckoutCreation += 1;
      return 1;
    },
    async markSbpCheckoutCreationUncertain() {
      calls.markSbpCheckoutCreationUncertain += 1;
      return 1;
    },
    async markSbpInvoiceCanceled() {
      calls.markSbpInvoiceCanceled += 1;
      return 1;
    },
    async markSbpInvoiceExpired() {
      calls.markSbpInvoiceExpired += 1;
      return 1;
    },
    async recordSbpStatusConflict(externalPaymentId, providerStatus) {
      calls.recordSbpStatusConflict += 1;
      calls.recordSbpStatusConflictArgs.push({ externalPaymentId, providerStatus });
      return 1;
    },
    async recordSbpProviderEvent(input) {
      calls.recordSbpProviderEvent += 1;
      calls.recordSbpProviderEventArgs.push(input);
      return 1;
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      const storedRows = tokens.flatMap((token) => {
        const row = storedInvoiceRows.get(token);
        return row ? [row] : [];
      });
      if (storedRows.length > 0) {
        return storedRows;
      }
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
    async loadActiveSubscriptionOfferId() {
      return "telegram:offer-1";
    },
    async loadAbTestAssignment() {
      calls.loadAbTestAssignment += 1;
      return null;
    },
    async storeAbTestAssignment(_chatId, _assignmentKey, assignment) {
      calls.storeAbTestAssignment += 1;
      return assignment;
    },
    async storeSubscriptionOfferMessageId() {
      return 2;
    },
    async clearActiveSubscriptionOffer(chatId, offerId) {
      calls.clearActiveSubscriptionOffer += 1;
      calls.clearActiveSubscriptionOfferArgs.push({ chatId, offerId });
      return 1;
    },
    async recordAbTestDelivered() {
      calls.recordAbTestDelivered += 1;
      return 1;
    },
    ...overrides,
  };
  const starsClient: MockStarsClient = {
    async createStarsInvoice(input) {
      calls.createStarsInvoice += 1;
      calls.createStarsInvoiceInputs.push(input);
      return {
        invoice_link: `https://t.me/generated-invoice-${calls.createStarsInvoice}`,
      };
    },
    ...starsOverrides,
  };
  const sbpClient: MockSbpClient = {
    async createPayment(input) {
      calls.createSbpPayment += 1;
      calls.createSbpPaymentInputs.push(input);
      return {
        external_payment_id: `sbp-payment-${calls.createSbpPayment}`,
        checkout_url: `https://sbp.example/checkout/${calls.createSbpPayment}`,
        provider_expires_at: null,
      };
    },
    ...sbpOverrides,
  };

  return {
    service: new MediaCommerceDecisionService(repository, starsClient, sbpClient),
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

async function withPhotoPlans<T>(
  plans: typeof config.MEDIA_PHOTO_PLANS_JSON,
  run: () => Promise<T>,
): Promise<T> {
  const previous = config.MEDIA_PHOTO_PLANS_JSON;
  config.MEDIA_PHOTO_PLANS_JSON = plans;
  try {
    return await run();
  } finally {
    config.MEDIA_PHOTO_PLANS_JSON = previous;
  }
}

async function withExperiments<T>(
  experiments: typeof config.EXPERIMENTS,
  run: () => Promise<T>,
): Promise<T> {
  const previous = config.EXPERIMENTS;
  config.EXPERIMENTS = experiments;
  try {
    return await run();
  } finally {
    config.EXPERIMENTS = previous;
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
  assert.equal(first.token_rows_prepared, 2);
  assert.equal(first.token_rows_inserted, 2);
  assert.equal(first.token_rows?.[0]?.payload_json.action_button_text, "text");
  assert.notEqual(first.token_rows?.[0]?.token, second.token_rows?.[0]?.token);
  assert.equal(first.token_rows?.[1]?.action_kind, "free_scene_unlock");
  assert.equal(first.token_rows?.[1]?.payload_json.action_button_text, "text");
});

test("prepare_offer does not create or reuse a paid photo invoice before click", async () => {
  const { service, calls } = createRepository({
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
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => {
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
          invoice_link: "https://t.me/scene-pass",
          scene_session_id: "scene-1",
        });
      });
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_callback");
  assert.equal(result.invoice_link, null);
  assert.equal(result.payment_options, undefined);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_photo_unlock");
  assert.equal(calls.createStarsInvoice, 0);
});

test("prepare_offer adds neutral photo and scene unlock callbacks under paid photo offers", async () => {
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
        invoice_link: "https://t.me/photo",
        scene_session_id:
          "scene-1",
      });
    },
    async upsertInvoiceTokens() {
      assert.fail("scene unlock payment options must not be created during render");
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_callback");
  assert.equal(result.invoice_link, null);
  assert.equal(result.scene_unlock_offer_item, null);
  assert.equal(result.token_rows?.length, 2);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_photo_unlock");
  assert.equal(result.token_rows?.[1]?.action_kind, "free_scene_unlock");
  assert.equal(result.token_rows?.[1]?.payload_json.action_button_text, "text");
});

test("prepare_offer does not read free scene unlock balance while rendering", async () => {
  const { service, calls } = createRepository({
    async loadOfferStats() {
      return buildOfferStats({
        delivered_in_scene: 3,
        unseen_available: 2,
      });
    },
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 0,
        free_scene_unlocks: 1,
      };
    },
    async upsertInvoiceTokens() {
      assert.fail("free scene unlock must suppress paid scene unlock invoice rows");
    },
  });

  const result = await service.evaluate(buildRequest());

  assert.equal(result.operation, "prepare_offer_callback");
  assert.equal(result.invoice_link, null);
  assert.equal(result.scene_unlock_offer_item, null);
  assert.equal(result.token_rows?.length, 2);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_photo_unlock");
  assert.equal(result.token_rows?.[1]?.action_kind, "free_scene_unlock");
  assert.equal(result.token_rows?.[1]?.payload_json.action_button_text, "text");
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.loadFreeCredits, 0);
});

test("prepare_offer suppresses the neutral scene unlock button when A/B disables it", async () => {
  const [experiment] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SCENE_OFF_JSON: JSON.stringify({
      key: "subscription_offer",
      version: "scene-off-v1",
      starts_at: "2020-01-01T00:00:00+00:00",
      ends_at: "2100-01-01T00:00:00+00:00",
      distribution: { B: 100 },
      variants: { B: { scene_unlock: { enabled: false } } },
    }),
  });
  const assignment = buildAssignment({ variant: "B" });
  const { service } = createRepository({
    async loadAbTestAssignment() {
      return assignment;
    },
    async storeAbTestAssignment() {
      return assignment;
    },
  });

  await withExperiments([experiment!], async () => {
    const result = await service.evaluate(buildRequest());

    assert.equal(
      result.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
      false,
    );
  });
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
  assert.equal(
    result.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
    false,
  );
});

test("prepare_offer defers active photo promotion pricing until click", async () => {
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

    assert.equal(result.operation, "prepare_offer_callback");
    assert.equal(result.invoice_sku, undefined);
    assert.equal(result.token_rows?.[0]?.action_kind, "free_photo_unlock");
    assert.equal(result.token_rows?.[0]?.payload_json.base_price_xtr, 10);
  });
});

test("photo payment resolves by photo_sku when prices overlap and promo applies", async () => {
  const photoPlans = [
    {
      sku: "payment_media_1",
      amount_xtr: 10,
      title: "media one",
      description: "media one",
      label: "media one",
      button_text: "media one",
    },
    {
      sku: "payment_media_2",
      amount_xtr: 10,
      title: "media two",
      description: "media two",
      label: "media two",
      button_text: "media two",
    },
  ];
  await withPhotoPlans(photoPlans, async () => {
    await withPromotions([
      {
        promo_key: "media_two_sale",
        items: [{ sku: "payment_media_2", promo_amount_xtr: 7 }],
        starts_at: "2026-09-01T00:00:00+03:00",
        ends_at: "2026-09-30T23:59:59+03:00",
      },
    ], async () => {
      const payload = {
        action_kind: "free_photo_unlock",
        chat_id: 101,
        scene_session_id: "scene-1",
        turn_no: 5,
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        target_message_id: 777,
        current_uuid: "u1",
        base_price_xtr: 10,
        photo_sku: "payment_media_2",
        requested_action: "photo_regen",
      };
      const capturedInvoices: Array<{
        sku?: string;
        amount_xtr?: number;
        payload_json?: Record<string, unknown>;
      }> = [];
      const storedInvoices: StoredInvoiceToken[] = [];
      const { service } = createRepository({
        async loadCallbackToken() {
          return buildLoadedCallbackToken({
            token: "photo-sku-two-entry",
            action_kind: "free_photo_unlock",
            payload_json: payload,
          });
        },
        async redeemFreePhotoUnlock(token, chatId) {
          return {
            token,
            chat_id: chatId,
            scene_session_id: "scene-1",
            turn_no: 5,
            payload_json: payload,
            action_kind: "free_photo_unlock",
            status: "active",
            redeemed: false,
            already_consumed: false,
            already_fulfilled: false,
            remaining_credits: 0,
            reason: "free_credit_unavailable",
          };
        },
        async upsertInvoiceToken(input) {
          capturedInvoices.push(input as {
            sku?: string;
            amount_xtr?: number;
            payload_json?: Record<string, unknown>;
          });
          const row = input as {
            token: string;
            payload_json: Record<string, unknown>;
            sku: string;
            amount_xtr: number;
          };
          const stored = buildStoredInvoiceToken({
            token: row.token,
            telegram_invoice_payload: row.token,
            payload_json: row.payload_json,
            sku: row.sku,
            amount_xtr: row.amount_xtr,
            invoice_link: "https://t.me/photo-two",
          });
          storedInvoices.push(stored);
          return stored;
        },
        async loadStoredInvoiceTokens(tokens) {
          return storedInvoices.filter((row) => tokens.includes(row.token));
        },
      });

      const response = await service.evaluate(buildRequest({
        interaction_mode: null,
        event_type: "callback_query.received",
        callback_data: "photo-sku-two-entry",
        inbound_message_id: 777,
      }));

      assert.equal(response.operation, "feature_payment_options_revealed");
      assert.equal(response.payment_options?.[0]?.sku, "payment_media_2");
      assert.equal(response.payment_options?.[0]?.amount, 7);
      const [capturedInvoice] = capturedInvoices;
      assert.equal(capturedInvoice?.sku, "payment_media_2");
      assert.equal(capturedInvoice?.amount_xtr, 7);
      assert.equal(capturedInvoice?.payload_json?.photo_sku, "payment_media_2");
      assert.equal(capturedInvoice?.payload_json?.original_amount_xtr, 10);
      assert.equal(capturedInvoice?.payload_json?.promo_key, "media_two_sale");
    });
  });
});

test("feature_offer is routed in TS and returns a ready Stars invoice for configured custom feature", async () => {
  const { service, calls } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "feature_offer",
      feature_key: "future_action_3",
      character_i: 2,
      scene_mode: "fast",
      target_message_id: 777,
    }),
  );

  assert.equal(result.route, "feature_offer");
  assert.equal(result.operation, "feature_offer_required");
  assert.equal(result.chat_id, 101);
  assert.equal(result.feature_key, "future_action_3");
  assert.equal(result.invoice_sku, "payment_action_3");
  assert.equal(result.invoice_amount, 100);
  assert.equal(result.invoice_link, "https://t.me/generated-invoice-1");
  assert.equal(findPaymentOption(result.payment_options, "stars")?.checkout_url, "https://t.me/generated-invoice-1");
  assert.equal(result.token_rows?.length, 1);
  assert.equal(result.token_rows?.[0]?.action_kind, "reveal_feature_payment_options");
  assert.deepEqual(
    result.token_rows?.[0]?.payload_json.invoice_tokens,
    result.payment_options?.map((option) => option.token),
  );
  assert.equal(result.token_rows?.[0]?.payload_json.payment_options, undefined);
  assert.equal(result.token_rows?.[0]?.payload_json.action_button_text, undefined);
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, 777);
  assert.equal(calls.createStarsInvoice, 1);
});

test("feature_offer rejects missing or unconfigured feature_key without defaulting", async () => {
  for (const featureKey of [undefined, "unknown_feature"]) {
    const { service, calls } = createRepository();

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "feature_offer",
        feature_key: featureKey,
      }),
    );

    assert.equal(result.reason, "feature_key_invalid");
    assert.equal(calls.loadFreeCredits, 0);
    assert.equal(calls.createStarsInvoice, 0);
  }
});

test("feature_offer returns free fast scene skip callback when credit is available", async () => {
  const { service, calls } = createRepository({
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 2,
        free_scene_unlocks: 0,
      };
    },
    async upsertInvoiceTokens() {
      assert.fail("free fast scene skip offer must not create payment rows");
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "feature_offer",
      feature_key: "fast_scene_skip",
      character_i: 2,
      scene_mode: "fast",
      target_message_id: 777,
    }),
  );

  assert.equal(result.operation, "feature_offer_required");
  assert.equal(result.reason, "free_fast_scene_skip_available");
  assert.equal(result.payment_options?.length, 0);
  assert.equal(result.token_rows?.length, 1);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_fast_scene_skip");
  assert.equal(result.token_rows?.[0]?.payload_json.action_button_text, "free skip 2");
  assert.equal(result.token_rows_inserted, 1);
  assert.equal(calls.loadFreeCredits, 1);
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.createSbpPayment, 0);
});

test("feature_offer returns Stars and lazy SBP options without creating a transaction", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  try {
    const { service, calls } = createRepository();

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "feature_offer",
        feature_key: "fast_scene_skip",
        character_i: 2,
        scene_mode: "fast",
        target_message_id: 777,
      }),
    );

    assert.equal(result.operation, "feature_offer_required");
    assert.equal(result.payment_options?.length, 2);
    assert.equal(findPaymentOption(result.payment_options, "stars")?.checkout_url, "https://t.me/generated-invoice-1");
    assert.match(
      findPaymentOption(result.payment_options, "sbp")?.checkout_url ?? "",
      /^https:\/\/gateway\.example\/v1\/pay\/sbp\//u,
    );
    assert.equal(findPaymentOption(result.payment_options, "sbp")?.amount, 80);
    assert.equal(findPaymentOption(result.payment_options, "sbp")?.currency, "RUB");
    assert.equal(findPaymentOption(result.payment_options, "stars")?.button_text, "star 50");
    assert.equal(findPaymentOption(result.payment_options, "sbp")?.button_text, "sbp 80");
    assert.equal(result.token_rows?.[0]?.action_kind, "reveal_feature_payment_options");
    assert.equal(result.token_rows?.[0]?.expires_at, null);
    assert.deepEqual(
      new Set(result.token_rows?.[0]?.payload_json.invoice_tokens as string[]),
      new Set(result.payment_options?.map((option) => option.token)),
    );
    assert.equal(result.token_rows?.[0]?.payload_json.payment_options, undefined);
    assert.equal(calls.createStarsInvoice, 1);
    assert.equal(calls.createSbpPayment, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("transient Stars failure keeps usable SBP option and can recover on next render", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  let starsAttempts = 0;
  try {
    console.warn = (...args: unknown[]) => warnings.push(args);
    const { service } = createRepository({}, {
      async createStarsInvoice() {
        starsAttempts += 1;
        if (starsAttempts === 1) {
          throw new TelegramStarsInvoiceError(
            "temporary request failure",
            "request",
            null,
            null,
          );
        }
        return { invoice_link: "https://t.me/recovered-invoice" };
      },
    });

    const first = await service.evaluate(buildRequest({
      interaction_mode: "feature_offer",
      feature_key: "fast_scene_skip",
    }));

    assert.equal(first.operation, "feature_offer_required");
    assert.deepEqual(first.payment_options?.map((option) => option.source), ["sbp"]);
    assert.equal((first.token_rows?.[0]?.payload_json.invoice_tokens as string[])?.length, 2);
    assert.equal(warnings.length, 1);

    const second = await service.evaluate(buildRequest({
      interaction_mode: "feature_offer",
      feature_key: "fast_scene_skip",
    }));

    assert.equal(second.operation, "feature_offer_required");
    assert.ok(findPaymentOption(second.payment_options, "stars"));
    assert.ok(findPaymentOption(second.payment_options, "sbp"));
    assert.equal(findPaymentOption(second.payment_options, "stars")?.checkout_url, "https://t.me/recovered-invoice");
  } finally {
    console.warn = originalWarn;
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("Stars failures are not swallowed without a usable SBP sibling or for hard failures", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  const cases: Array<{
    name: string;
    sbpEnabled: boolean;
    starsOverrides?: Partial<MockStarsClient>;
    repositoryOverrides?: Partial<MockRepository>;
  }> = [
    {
      name: "transient_without_sbp",
      sbpEnabled: false,
      starsOverrides: {
        async createStarsInvoice() {
          throw new TelegramStarsInvoiceError(
            "temporary request failure",
            "request",
            null,
            null,
          );
        },
      },
    },
    {
      name: "telegram_400",
      sbpEnabled: true,
      starsOverrides: {
        async createStarsInvoice() {
          throw new TelegramStarsInvoiceError(
            "bad request",
            "response",
            400,
            "Bad Request",
          );
        },
      },
    },
    {
      name: "repository_error",
      sbpEnabled: true,
      starsOverrides: {
        async createStarsInvoice() {
          return { invoice_link: "https://t.me/invoice" };
        },
      },
      repositoryOverrides: {
        async storeInvoiceLinks() {
          throw new Error("repository unavailable");
        },
      },
    },
  ];

  try {
    config.MEDIA_ACTION_PLANS_JSON = [
      {
        sku: "payment_action_1",
        feature_key: "fast_scene_skip",
        amount_xtr: 50,
        amount_rub: 80,
        title: "text",
        description: "text",
        label: "text",
        button_text: "text",
      },
    ];

    for (const item of cases) {
      config.SBP_ENABLED = item.sbpEnabled;
      const { service } = createRepository(
        item.repositoryOverrides ?? {},
        item.starsOverrides ?? {},
      );
      await assert.rejects(
        () => service.evaluate(buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
        })),
        { name: "MediaCommerceOperationError" },
        item.name,
      );
    }
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("feature_offer does not inspect or reuse provider checkout while rendering", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  try {
    const { service, calls } = createRepository({
      async claimSbpCheckoutCreation(token, chatId) {
        calls.claimSbpCheckoutCreation += 1;
        const hasCheckout = calls.claimSbpCheckoutCreation > 1;
        return {
          token,
          chat_id: chatId,
          checkout_url: hasCheckout ? "https://sbp.example/checkout/reused" : null,
          external_payment_id: hasCheckout ? "sbp-payment-reused" : null,
          claim_acquired: false,
        };
      },
    });

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "feature_offer",
        feature_key: "fast_scene_skip",
        character_i: 2,
        scene_mode: "fast",
        target_message_id: 777,
      }),
    );

    assert.equal(result.operation, "feature_offer_required");
    assert.match(findPaymentOption(result.payment_options, "sbp")?.checkout_url ?? "", /\/v1\/pay\/sbp\//u);
    assert.equal(findPaymentOption(result.payment_options, "sbp")?.external_payment_id, null);
    assert.equal(calls.claimSbpCheckoutCreation, 0);
    assert.equal(calls.loadStoredInvoiceTokens, 0);
    assert.equal(calls.createSbpPayment, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("concurrent feature offer renders do not create SBP transactions", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  let checkout: { checkout_url: string; external_payment_id: string } | null = null;
  let claimHeld = false;

  try {
    const { service, calls } = createRepository(
      {
        async claimSbpCheckoutCreation(token, chatId) {
          calls.claimSbpCheckoutCreation += 1;
          return {
            token,
            chat_id: chatId,
            checkout_url: checkout?.checkout_url ?? null,
            external_payment_id: checkout?.external_payment_id ?? null,
            claim_acquired: !checkout && !claimHeld ? (claimHeld = true) : false,
          };
        },
        async storeInvoiceLinks(items) {
          calls.storeInvoiceLinks += 1;
          const rows = Array.isArray(items) ? items : [];
          for (const row of rows) {
            const source = row as {
              checkout_url?: string | null;
              external_payment_id?: string | null;
            };
            if (source.checkout_url && source.external_payment_id) {
              checkout = {
                checkout_url: source.checkout_url,
                external_payment_id: source.external_payment_id,
              };
            }
          }
          return rows.length;
        },
      },
      {},
      {
        async createPayment(input) {
          calls.createSbpPayment += 1;
          calls.createSbpPaymentInputs.push(input);
          await new Promise((resolve) => setTimeout(resolve, 3100));
          return {
            external_payment_id: "sbp-payment-slow-shared",
            checkout_url: "https://sbp.example/checkout/slow-shared",
            provider_expires_at: null,
          };
        },
      },
    );

    const [first, second] = await Promise.all([
      service.evaluate(
        buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
          character_i: 2,
          scene_mode: "fast",
          target_message_id: 777,
        }),
      ),
      service.evaluate(
        buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
          character_i: 2,
          scene_mode: "fast",
          target_message_id: 777,
        }),
      ),
    ]);

    assert.equal(first.operation, "feature_offer_required");
    assert.equal(second.operation, "feature_offer_required");
    assert.equal(calls.createSbpPayment, 0);
    assert.equal(findPaymentOption(first.payment_options, "sbp")?.external_payment_id, null);
    assert.equal(findPaymentOption(second.payment_options, "sbp")?.external_payment_id, null);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("feature_offer reveal preparation leaves SBP transaction creation to GET", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  let checkout: { checkout_url: string; external_payment_id: string } | null = null;
  let claimHeld = false;

  try {
    const { service, calls } = createRepository(
      {
        async claimSbpCheckoutCreation(token, chatId) {
          calls.claimSbpCheckoutCreation += 1;
          return {
            token,
            chat_id: chatId,
            checkout_url: checkout?.checkout_url ?? null,
            external_payment_id: checkout?.external_payment_id ?? null,
            claim_acquired: !checkout && !claimHeld ? (claimHeld = true) : false,
          };
        },
        async storeInvoiceLinks(items) {
          calls.storeInvoiceLinks += 1;
          const rows = Array.isArray(items) ? items : [];
          for (const row of rows) {
            const source = row as {
              checkout_url?: string | null;
              external_payment_id?: string | null;
            };
            if (source.checkout_url && source.external_payment_id) {
              checkout = {
                checkout_url: source.checkout_url,
                external_payment_id: source.external_payment_id,
              };
            }
          }
          return rows.length;
        },
        async loadStoredInvoiceTokens(tokens) {
          calls.loadStoredInvoiceTokens += 1;
          return tokens.map((token) =>
            buildStoredInvoiceToken({
              token,
              kind: "invoice_payload",
              chat_id: 101,
              scene_session_id: "scene-1",
              turn_no: 5,
              scene_turn_no: 3,
              payload_json: {
                action_kind: "feature_payment",
                feature_key: "fast_scene_skip",
              },
              action_kind: "feature_payment",
              sku: "payment_action_1",
              payment_source: "sbp",
              amount: 80,
              currency: "RUB",
              amount_xtr: null,
              telegram_invoice_payload: null,
              checkout_url: checkout?.checkout_url ?? null,
              external_payment_id: checkout?.external_payment_id ?? null,
              invoice_link: null,
            }),
          );
        },
      },
      {},
      {
        async createPayment(input) {
          calls.createSbpPayment += 1;
          calls.createSbpPaymentInputs.push(input);
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            external_payment_id: "sbp-payment-shared",
            checkout_url: "https://sbp.example/checkout/shared",
            provider_expires_at: null,
          };
        },
      },
    );

    const [first, second] = await Promise.all([
      service.evaluate(
        buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
          character_i: 2,
          scene_mode: "fast",
          target_message_id: 777,
        }),
      ),
      service.evaluate(
        buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
          character_i: 2,
          scene_mode: "fast",
          target_message_id: 777,
        }),
      ),
    ]);

    assert.equal(first.operation, "feature_offer_required");
    assert.equal(second.operation, "feature_offer_required");
    assert.equal(calls.createSbpPayment, 0);
    assert.equal(findPaymentOption(first.payment_options, "sbp")?.external_payment_id, null);
    assert.equal(findPaymentOption(second.payment_options, "sbp")?.external_payment_id, null);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("feature_offer render never reaches an ambiguous SBP provider failure", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  let checkout: { checkout_url: string; external_payment_id: string } | null = null;
  let claimHeld = false;
  let shouldFailFirstCreate = true;

  try {
    const originalConsoleError = console.error;
    const { service, calls } = createRepository(
      {
        async claimSbpCheckoutCreation(token, chatId) {
          calls.claimSbpCheckoutCreation += 1;
          return {
            token,
            chat_id: chatId,
            checkout_url: checkout?.checkout_url ?? null,
            external_payment_id: checkout?.external_payment_id ?? null,
            claim_acquired: !checkout && !claimHeld ? (claimHeld = true) : false,
          };
        },
        async releaseSbpCheckoutCreation() {
          calls.releaseSbpCheckoutCreation += 1;
          claimHeld = false;
          return 1;
        },
        async storeInvoiceLinks(items) {
          calls.storeInvoiceLinks += 1;
          const rows = Array.isArray(items) ? items : [];
          for (const row of rows) {
            const source = row as {
              checkout_url?: string | null;
              external_payment_id?: string | null;
            };
            if (source.checkout_url && source.external_payment_id) {
              checkout = {
                checkout_url: source.checkout_url,
                external_payment_id: source.external_payment_id,
              };
            }
          }
          return rows.length;
        },
      },
      {},
      {
        async createPayment(input) {
          calls.createSbpPayment += 1;
          calls.createSbpPaymentInputs.push(input);
          if (shouldFailFirstCreate) {
            shouldFailFirstCreate = false;
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new SbpPaymentError(
              "SBP payment request timed out",
              "request",
              null,
              "ambiguous",
              "TimeoutError",
            );
          }
          return {
            external_payment_id: "sbp-payment-recovered",
            checkout_url: "https://sbp.example/checkout/recovered",
            provider_expires_at: null,
          };
        },
      },
    );

    console.error = () => {};
    try {
      const [first, second] = await Promise.allSettled([
        service.evaluate(
          buildRequest({
            interaction_mode: "feature_offer",
            feature_key: "fast_scene_skip",
            character_i: 2,
            scene_mode: "fast",
            target_message_id: 777,
          }),
        ),
        service.evaluate(
          buildRequest({
            interaction_mode: "feature_offer",
            feature_key: "fast_scene_skip",
            character_i: 2,
            scene_mode: "fast",
            target_message_id: 777,
          }),
        ),
      ]);

      assert.equal(first.status, "fulfilled");
      assert.equal(second.status, "fulfilled");
      if (second.status === "fulfilled") {
        assert.equal(second.value.operation, "feature_offer_required");
        assert.equal(
          findPaymentOption(second.value.payment_options, "sbp")?.external_payment_id,
          null,
        );
      }
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(calls.createSbpPayment, 0);
    assert.equal(calls.releaseSbpCheckoutCreation, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
});

test("feature_offer render does not acquire a claim or call a timing-out provider", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousActionPlans = config.MEDIA_ACTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [
    {
      sku: "payment_action_1",
      feature_key: "fast_scene_skip",
      amount_xtr: 50,
      amount_rub: 80,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  try {
    const originalConsoleError = console.error;
    const { service, calls } = createRepository(
      {},
      {},
      {
        async createPayment(input) {
          calls.createSbpPayment += 1;
          calls.createSbpPaymentInputs.push(input);
          throw new SbpPaymentError(
            "SBP payment request timed out",
            "request",
            null,
            "ambiguous",
            "TimeoutError",
          );
        },
      },
    );

    console.error = () => {};
    try {
      await service.evaluate(
        buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
          character_i: 2,
          scene_mode: "fast",
          target_message_id: 777,
        }),
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(calls.claimSbpCheckoutCreation, 0);
    assert.equal(calls.createSbpPayment, 0);
    assert.equal(calls.releaseSbpCheckoutCreation, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousActionPlans;
  }
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
    const { service, calls } = createRepository();

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
    assert.equal(result.invoice_link, "https://t.me/generated-invoice-1");
    assert.equal(calls.createStarsInvoice, 1);
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

test("feature payment reveal callback returns payment options without creating checkout", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "feature_payment",
      sku: "payment_action_1",
      payment_source: "stars",
      amount: 50,
      currency: "XTR",
      amount_xtr: 50,
      invoice_link: "https://t.me/invoice",
      scene_session_id: "scene-1",
      payload_json: {
        action_kind: "feature_payment",
        feature_key: "fast_scene_skip",
        idempotency_key: "feature:101:scene-1:5:3:fast_scene_skip",
      },
      invoice_button_text: "star 50",
    }),
    buildStoredInvoiceToken({
      token: "sbp-token",
      action_kind: "feature_payment",
      sku: "payment_action_1",
      payment_source: "sbp",
      amount: 80,
      currency: "RUB",
      amount_xtr: 50,
      checkout_url: null,
      external_payment_id: null,
      scene_session_id: "scene-1",
      payload_json: {
        action_kind: "feature_payment",
        feature_key: "fast_scene_skip",
        idempotency_key: "feature:101:scene-1:5:3:fast_scene_skip",
      },
      invoice_button_text: "sbp 80",
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken(token, chatId) {
      calls.loadCallbackTokenArgs.push({ token, chatId });
      return buildLoadedCallbackToken({
        token: "btn_reveal",
        action_kind: "reveal_feature_payment_options",
        payload_json: {
          action_kind: "reveal_feature_payment_options",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: null,
          feature_key: "fast_scene_skip",
          payment_options: [
            {
              token: "stars-token",
              amount: 1,
              checkout_url: "https://legacy.example/stale-stars",
            },
            {
              token: "sbp-token",
              amount: 2,
              checkout_url: "https://legacy.example/stale-sbp",
            },
          ],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_reveal",
      callback_query_id: "cbq-1",
      inbound_message_id: 777,
      panel_text: "stale fallback text",
      panel_entities_json: [{ type: "code", offset: 0, length: 5 }],
      raw_update: {
        callback_query: {
          message: {
            message_id: 777,
            caption: "Offer caption",
            caption_entities: [{ type: "bold", offset: 0, length: 5 }],
            reply_markup: {
              inline_keyboard: [[{ text: "text", callback_data: "btn_reveal" }]],
            },
          },
        },
      },
    }),
  );

  assert.equal(result.operation, "feature_payment_options_revealed");
  assert.equal(result.callback_valid, true);
  assert.equal(result.message_kind, "caption");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.panel_text, "Offer caption");
  assert.deepEqual(result.panel_entities_json, [{ type: "bold", offset: 0, length: 5 }]);
  assert.deepEqual(result.current_reply_markup, {
    inline_keyboard: [[{ text: "text", callback_data: "btn_reveal" }]],
  });
  assert.equal(result.payment_options?.length, 2);
  assert.equal(findPaymentOption(result.payment_options, "stars")?.checkout_url, "https://t.me/invoice");
  assert.match(findPaymentOption(result.payment_options, "sbp")?.checkout_url ?? "", /\/v1\/pay\/sbp\/sbp-token$/u);
  assert.equal(calls.loadMediaContext, 0);
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.createSbpPayment, 0);
});

test("feature payment reveal callback rejects stale scene context", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "feature_payment",
      sku: "payment_action_1",
      payment_source: "stars",
      amount: 50,
      currency: "XTR",
      amount_xtr: 50,
      invoice_link: "https://t.me/invoice",
      scene_session_id: "scene-1",
      payload_json: {
        action_kind: "feature_payment",
        feature_key: "fast_scene_skip",
        idempotency_key: "feature:101:scene-1:5:3:fast_scene_skip",
      },
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_reveal",
        action_kind: "reveal_feature_payment_options",
        payload_json: {
          action_kind: "reveal_feature_payment_options",
          chat_id: 101,
          scene_session_id: "scene-1",
          feature_key: "fast_scene_skip",
          invoice_tokens: ["stars-token"],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
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

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_reveal",
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "callback_invalid");
  assert.equal(result.callback_valid, false);
  assert.equal(calls.loadSceneAccessStatus, 1);
  assert.equal(calls.createStarsInvoice, 0);
});

test("feature payment reveal callback rejects terminal non-renderable attempts", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "feature_payment",
      sku: "payment_action_1",
      payment_source: "stars",
      status: "fulfilled",
      amount: 50,
      currency: "XTR",
      amount_xtr: 50,
      scene_session_id: "scene-1",
      payload_json: {
        action_kind: "feature_payment",
        feature_key: "fast_scene_skip",
        idempotency_key: "feature:101:scene-1:5:3:fast_scene_skip",
      },
    }),
    buildStoredInvoiceToken({
      token: "sbp-token",
      action_kind: "feature_payment",
      sku: "payment_action_1",
      payment_source: "sbp",
      status: "canceled",
      failure_reason: "sibling_paid",
      amount: 80,
      currency: "RUB",
      amount_xtr: 50,
      scene_session_id: "scene-1",
      payload_json: {
        action_kind: "feature_payment",
        feature_key: "fast_scene_skip",
        idempotency_key: "feature:101:scene-1:5:3:fast_scene_skip",
      },
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_reveal",
        action_kind: "reveal_feature_payment_options",
        payload_json: {
          action_kind: "reveal_feature_payment_options",
          chat_id: 101,
          scene_session_id: "scene-1",
          feature_key: "fast_scene_skip",
          invoice_tokens: ["stars-token", "sbp-token"],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_reveal",
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "callback_invalid");
  assert.equal(result.callback_valid, false);
  assert.equal(result.payment_options, undefined);
  assert.equal(calls.createStarsInvoice, 0);
});

test("free fast scene skip callback redeems credit and returns existing fulfillment contract", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken(token, chatId) {
      calls.loadCallbackTokenArgs.push({ token, chatId });
      return buildLoadedCallbackToken({
        token: "free-skip-token",
        action_kind: "free_fast_scene_skip",
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          media_signature: "hotel_corridor_close",
          target_message_id: 777,
          feature_key: "fast_scene_skip",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-skip-token",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "feature_fulfillment_required");
  assert.equal(result.feature_key, "fast_scene_skip");
  assert.equal(result.payment_token, "free-skip-token");
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.reason, "free_fast_scene_skip_redeemed");
  assert.equal(calls.redeemFreeFastSceneSkip, 1);
  assert.equal(calls.loadMediaContext, 0);
});

test("free fast scene skip callback retry after consumed credit and scene switch returns fulfillment again", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-skip-token",
        action_kind: "free_fast_scene_skip",
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          skip_scene_session_id: "fast-scene-2",
          target_message_id: 777,
          feature_key: "fast_scene_skip",
        },
      });
    },
    async redeemFreeFastSceneSkip(token, chatId) {
      calls.redeemFreeFastSceneSkip += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          character_i: 2,
          scene_mode: "fast",
          skip_scene_session_id: "fast-scene-2",
          target_message_id: 777,
          feature_key: "fast_scene_skip",
        },
        action_kind: "free_fast_scene_skip",
        status: "active",
        redeemed: false,
        already_consumed: true,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "already_consumed",
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-skip-token",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "feature_fulfillment_required");
  assert.equal(result.reason, "free_fast_scene_skip_already_consumed");
  assert.equal(result.payment_token, "free-skip-token");
  assert.equal(calls.redeemFreeFastSceneSkip, 1);
  assert.equal(calls.loadMediaContext, 0);
});

test("fulfilled free fast scene skip callback does not trigger fulfillment again", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-skip-token",
        status: "fulfilled",
        action_kind: "free_fast_scene_skip",
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          feature_key: "fast_scene_skip",
        },
      });
    },
    async redeemFreeFastSceneSkip(token, chatId) {
      calls.redeemFreeFastSceneSkip += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "scene-1",
          feature_key: "fast_scene_skip",
        },
        action_kind: "free_fast_scene_skip",
        status: "fulfilled",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: true,
        remaining_credits: 0,
        reason: "already_fulfilled",
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-skip-token",
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "already_fulfilled");
  assert.equal(calls.redeemFreeFastSceneSkip, 1);
  assert.equal(calls.loadMediaContext, 0);
});

test("stale free fast scene skip callback does not trigger fulfillment", async () => {
  const { service } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-skip-token",
        action_kind: "free_fast_scene_skip",
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "old-scene",
          feature_key: "fast_scene_skip",
        },
      });
    },
    async redeemFreeFastSceneSkip(token, chatId) {
      return {
        token,
        chat_id: chatId,
        scene_session_id: "old-scene",
        turn_no: 5,
        payload_json: {
          action_kind: "free_fast_scene_skip",
          chat_id: 101,
          scene_session_id: "old-scene",
          feature_key: "fast_scene_skip",
        },
        action_kind: "free_fast_scene_skip",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 1,
        reason: "stale_scene",
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-skip-token",
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "stale_scene");
  assert.equal(result.feature_key, "fast_scene_skip");
});

test("free scene unlock callback activates scene access through existing contract", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-unlock-token",
        action_kind: "free_scene_unlock",
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          turn_no: 5,
          scene_turn_no: 3,
          target_message_id: 777,
          feature_key: "scene_unlock",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-unlock-token",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "scene_access_activated");
  assert.equal(result.feature_key, "scene_unlock");
  assert.equal(result.payment_token, "free-unlock-token");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.reason, "free_scene_unlock_redeemed");
  assert.equal(calls.redeemFreeSceneUnlock, 1);
  assert.equal(calls.loadMediaContext, 0);
});

test("free scene unlock callback creates current paid options when no free credit remains", async () => {
  const tokenPayload = {
    action_kind: "free_scene_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    target_message_id: 777,
    feature_key: "scene_unlock",
    feature_payment_hint_text: "unlock hint",
  };
  const storedRows = new Map<string, StoredInvoiceToken>();
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "scene-unlock-entry",
        action_kind: "free_scene_unlock",
        payload_json: tokenPayload,
      });
    },
    async redeemFreeSceneUnlock(token, chatId) {
      calls.redeemFreeSceneUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: tokenPayload,
        action_kind: "free_scene_unlock",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "free_credit_unavailable",
      };
    },
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => {
        const row = input as {
          token: string;
          kind: string;
          chat_id: number;
          scene_session_id: string | null;
          turn_no: number | null;
          scene_turn_no: number | null;
          payload_json: Record<string, unknown>;
          action_kind: string;
          sku: string;
          payment_source: "stars" | "sbp";
          amount: number;
          currency: "XTR" | "RUB";
          amount_xtr: number;
          telegram_invoice_payload: string;
          checkout_url: string | null;
          external_payment_id: string | null;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        };
        const stored = buildStoredInvoiceToken({
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: row.scene_session_id,
          turn_no: row.turn_no,
          scene_turn_no: row.scene_turn_no,
          payload_json: row.payload_json,
          action_kind: row.action_kind,
          sku: row.sku,
          payment_source: row.payment_source,
          amount: row.amount,
          currency: row.currency,
          amount_xtr: row.amount_xtr,
          telegram_invoice_payload: row.telegram_invoice_payload,
          checkout_url: row.checkout_url,
          external_payment_id: row.external_payment_id,
          expires_at: row.expires_at,
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
          invoice_link: null,
        });
        storedRows.set(stored.token, stored);
        return stored;
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      return tokens.flatMap((token) => {
        const row = storedRows.get(token);
        return row ? [row] : [];
      });
    },
    async storeInvoiceLinks(items) {
      calls.storeInvoiceLinks += 1;
      for (const item of Array.isArray(items) ? items : []) {
        const update = item as {
          token?: string | null;
          invoice_link?: string | null;
          checkout_url?: string | null;
          external_payment_id?: string | null;
        };
        if (!update.token) continue;
        const existing = storedRows.get(update.token);
        if (!existing) continue;
        storedRows.set(update.token, {
          ...existing,
          invoice_link: update.invoice_link ?? existing.invoice_link,
          checkout_url: update.checkout_url ?? existing.checkout_url,
          external_payment_id:
            update.external_payment_id ?? existing.external_payment_id,
        });
      }
      return 1;
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "scene-unlock-entry",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "feature_payment_options_revealed");
  assert.equal(result.callback_valid, true);
  assert.equal(result.feature_key, "scene_unlock");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.feature_payment_hint_text, "*unlock hint");
  assert.equal(result.payment_options?.length, 1);
  assert.equal(result.reason, "feature_payment_options_revealed");
  const [paymentOption] = result.payment_options ?? [];
  assert.ok(paymentOption);
  assert.equal(paymentOption?.payment_kind, "feature");
  assert.equal(paymentOption?.action_kind, "feature_payment");
  assert.equal(paymentOption?.feature_key, "scene_unlock");
  assert.equal(paymentOption?.scene_session_id, "scene-1");
  assert.equal(paymentOption?.amount, 80);
  assert.equal(paymentOption?.checkout_url, "https://t.me/generated-invoice-1");
  assert.notEqual(paymentOption?.token, "scene-unlock-entry");
  assert.notEqual(result.reason, "callback_invalid");
  assert.notEqual(result.reason, "scene_unlock_plan_missing");
  assert.equal(calls.createStarsInvoice, 1);
  const sceneInvoiceInput = calls.createStarsInvoiceInputs[0] as { payload: string };
  assert.match(sceneInvoiceInput.payload, /^stars_[0-9a-f]{64}$/u);
  assert.ok(Buffer.byteLength(sceneInvoiceInput.payload, "utf8") <= 128);
  assert.notEqual(sceneInvoiceInput.payload, "scene-unlock-entry");
  assert.equal(calls.redeemFreeSceneUnlock, 1);
  assert.equal(calls.loadMediaContext, 0);
});

test("expired free scene unlock entry callback is rejected before redeem or payment creation", async () => {
  const tokenPayload = {
    action_kind: "free_scene_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    target_message_id: 777,
    feature_key: "scene_unlock",
  };
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "expired-scene-unlock-entry",
        action_kind: "free_scene_unlock",
        status: "active",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        payload_json: tokenPayload,
      });
    },
    async redeemFreeSceneUnlock() {
      assert.fail("expired scene unlock callback must not redeem credits");
    },
  }, {
    async createStarsInvoice() {
      assert.fail("expired scene unlock callback must not create Stars invoices");
    },
  }, {
    async createPayment() {
      assert.fail("expired scene unlock callback must not create SBP payments");
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "expired-scene-unlock-entry",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.callback_valid, false);
  assert.equal(result.reason, "callback_invalid");
  assert.equal(calls.redeemFreeSceneUnlock, 0);
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.createSbpPayment, 0);
  assert.equal(calls.loadMediaContext, 0);
});

test("Stars invoice creation logs safe provider details and invoice context", async () => {
  const tokenPayload = {
    action_kind: "free_scene_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    target_message_id: 777,
    feature_key: "scene_unlock",
  };
  const capturedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  const { service } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "scene-unlock-entry",
        action_kind: "free_scene_unlock",
        payload_json: tokenPayload,
      });
    },
    async redeemFreeSceneUnlock(token, chatId) {
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: tokenPayload,
        action_kind: "free_scene_unlock",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "free_credit_unavailable",
      };
    },
  }, {
    async createStarsInvoice() {
      throw new TelegramStarsInvoiceError(
        "Telegram Stars API returned a non-success HTTP status",
        "response",
        400,
        "Bad Request: invoice title is invalid",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: invoice title is invalid",
          result: "sensitive-result",
          payload: "sensitive-payload",
          api_url: "https://api.telegram.org/botSECRET/createInvoiceLink",
        },
      );
    },
  });

  console.error = (...args: unknown[]) => capturedErrors.push(args);
  try {
    await assert.rejects(() => service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "scene-unlock-entry",
      inbound_message_id: 777,
    })));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(capturedErrors.length, 1);
  assert.equal(capturedErrors[0]?.[0], "[media_commerce] sceneUnlock.click.createInvoiceLink");
  assert.deepEqual(capturedErrors[0]?.[1], {
    request_id: null,
    operation: "sceneUnlock.click.createInvoiceLink",
    status: "error",
    duration_ms: (capturedErrors[0]?.[1] as { duration_ms: number }).duration_ms,
    chat_id: 101,
    payment_kind: "feature_payment",
    sku: "payment_action_2",
    amount_xtr: 80,
    title: "text",
    label: "text",
    invoice_status: "invoice_sent",
    code: "stars_invoice_creation_failed",
    message: "Telegram Stars API returned a non-success HTTP status",
    stage: "response",
    statusCode: 400,
    description: "Bad Request: invoice title is invalid",
    details: {
      ok: false,
      error_code: 400,
      description: "Bad Request: invoice title is invalid",
    },
  });
  const serializedLog = JSON.stringify(capturedErrors);
  assert.doesNotMatch(serializedLog, /sensitive-result|sensitive-payload|botSECRET|api\.telegram\.org/u);
});

test("free photo unlock callback redeems current credit and delivers the photo", async () => {
  const payload = {
    action_kind: "free_photo_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    target_message_id: 777,
    current_uuid: "u1",
    base_price_xtr: 10,
    photo_sku: "payment_media_1",
    requested_action: "photo_regen",
    free_photo_uuid: "u2",
  };
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "photo-unlock-entry",
        action_kind: "free_photo_unlock",
        payload_json: payload,
      });
    },
    async loadMediaContext(input) {
      calls.loadMediaContext += 1;
      const request = input as {
        force_deliver_after_payment?: boolean;
        paid_access_mode?: string | null;
      };
      return buildMediaContext({
        force_deliver_after_payment: request.force_deliver_after_payment === true,
        paid_access_mode: request.paid_access_mode ?? null,
      });
    },
  });

  const response = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "photo-unlock-entry",
    inbound_message_id: 777,
  }));

  assert.equal(response.operation, "edit_photo");
  assert.equal(response.log_event_type, "media.photo.unlocked.free");
  assert.equal(response.access_mode, "free_credit");
  assert.deepEqual(response.payment_options, []);
  assert.equal(calls.redeemFreePhotoUnlock, 1);
  assert.equal(calls.loadMediaContext, 1);
  assert.equal(calls.createStarsInvoice, 0);
});

test("free photo unlock callback reveals only Stars when no credit remains", async () => {
  const payload = {
    action_kind: "free_photo_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    target_message_id: 777,
    current_uuid: "u1",
    base_price_xtr: 10,
    photo_sku: "payment_media_1",
    requested_action: "photo_regen",
    free_photo_uuid: "u2",
  };
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "photo-unlock-entry",
        action_kind: "free_photo_unlock",
        payload_json: payload,
      });
    },
    async redeemFreePhotoUnlock(token, chatId) {
      calls.redeemFreePhotoUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: payload,
        action_kind: "free_photo_unlock",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "free_credit_unavailable",
      };
    },
  });

  const response = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "photo-unlock-entry",
    inbound_message_id: 777,
  }));

  assert.equal(response.operation, "feature_payment_options_revealed");
  assert.equal(response.callback_valid, true);
  assert.equal(response.feature_key, "photo_unlock");
  assert.equal(response.payment_options?.length, 1);
  assert.equal(response.payment_options?.[0]?.source, "stars");
  assert.equal(response.payment_options?.[0]?.sku, "payment_media_1");
  assert.equal(response.payment_options?.[0]?.amount, 10);
  assert.equal(calls.createStarsInvoice, 1);
  assert.equal(calls.createSbpPayment, 0);
  assert.equal(calls.loadMediaContext, 0);
});

test("consumed free photo callback retries delivery without another credit debit", async () => {
  const payload = {
    action_kind: "free_photo_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    current_uuid: "u1",
    base_price_xtr: 10,
    photo_sku: "payment_media_1",
    requested_action: "photo_regen",
    free_photo_uuid: "u2",
  };
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "consumed-photo-entry",
        action_kind: "free_photo_unlock",
        payload_json: payload,
      });
    },
    async redeemFreePhotoUnlock(token, chatId) {
      calls.redeemFreePhotoUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: payload,
        action_kind: "free_photo_unlock",
        status: "active",
        redeemed: false,
        already_consumed: true,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "already_consumed",
      };
    },
    async loadMediaContext(input) {
      calls.loadMediaContext += 1;
      const request = input as { paid_access_mode?: string | null };
      return buildMediaContext({
        force_deliver_after_payment: true,
        paid_access_mode: request.paid_access_mode ?? null,
        next_unseen_json: {
          uuid: "u3",
          photo_url: "https://cdn.test/u3.jpg",
          sort_order: 3,
        },
      });
    },
  });

  const response = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "consumed-photo-entry",
  }));

  assert.equal(response.operation, "edit_photo");
  assert.equal(response.access_mode, "free_credit");
  assert.equal(response.selected_uuid, "u2");
  assert.equal(calls.redeemFreePhotoUnlock, 1);
  assert.equal(calls.loadMediaContext, 1);
  assert.equal(calls.loadPhotoByUuid, 1);
});

test("fulfilled free photo callback is an idempotent no-op", async () => {
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "photo-unlock-entry",
        action_kind: "free_photo_unlock",
        payload_json: { free_photo_uuid: "u2" },
      });
    },
    async redeemFreePhotoUnlock(token, chatId) {
      calls.redeemFreePhotoUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: { free_photo_uuid: "u2" },
        action_kind: "free_photo_unlock",
        status: "fulfilled",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: true,
        remaining_credits: 0,
        reason: "already_fulfilled",
      };
    },
  });

  const response = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "photo-unlock-entry",
  }));

  assert.equal(response.operation, "noop");
  assert.equal(response.callback_valid, true);
  assert.equal(response.reason, "already_fulfilled");
  assert.equal(calls.redeemFreePhotoUnlock, 1);
  assert.equal(calls.loadMediaContext, 0);
  assert.equal(calls.createStarsInvoice, 0);
});

for (const scenario of [
  { name: "active subscription", context: { subscription_active: true }, accessMode: "subscription" },
  { name: "active scene access", context: { scene_access_active: true }, accessMode: "scene_pass" },
  { name: "remaining base allowance", context: { delivered_in_scene: 2 }, accessMode: "free" },
]) {
  test(`free photo callback does not consume credit with ${scenario.name}`, async () => {
    const payload = {
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 3,
      media_signature: "hotel_corridor_close",
      target_message_id: 777,
      current_uuid: "u1",
      base_price_xtr: 10,
      photo_sku: "payment_media_1",
      requested_action: "photo_regen",
    };
    const { service, calls } = createRepository({
      async loadCallbackToken() {
        return buildLoadedCallbackToken({
          token: "photo-unlock-entry",
          action_kind: "free_photo_unlock",
          payload_json: payload,
        });
      },
      async redeemFreePhotoUnlock(token, chatId) {
        calls.redeemFreePhotoUnlock += 1;
        return {
          token,
          chat_id: chatId,
          scene_session_id: "scene-1",
          turn_no: 5,
          payload_json: payload,
          action_kind: "free_photo_unlock",
          status: "active",
          redeemed: false,
          already_consumed: false,
          already_fulfilled: false,
          remaining_credits: 1,
          reason: "free_credit_not_required",
        };
      },
      async loadMediaContext() {
        calls.loadMediaContext += 1;
        return buildMediaContext(scenario.context);
      },
    });

    const response = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "photo-unlock-entry",
    }));

    assert.equal(response.operation, "edit_photo");
    assert.equal(response.access_mode, scenario.accessMode);
    assert.notEqual(response.action_kind, "free_photo_unlock");
    assert.equal(calls.redeemFreePhotoUnlock, 1);
    assert.equal(calls.createStarsInvoice, 0);
  });
}

test("free scene unlock duplicate fulfilled callback is idempotent", async () => {
  const { service } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-unlock-token",
        status: "fulfilled",
        action_kind: "free_scene_unlock",
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
          feature_key: "scene_unlock",
        },
      });
    },
    async redeemFreeSceneUnlock(token, chatId) {
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: 101,
          scene_session_id: "scene-1",
          target_message_id: 777,
          feature_key: "scene_unlock",
        },
        action_kind: "free_scene_unlock",
        status: "fulfilled",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: true,
        remaining_credits: 0,
        reason: "already_fulfilled",
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-unlock-token",
    }),
  );

  assert.equal(result.operation, "scene_access_activated");
  assert.equal(result.reason, "already_active");
  assert.equal(result.payment_token, "free-unlock-token");
});

test("stale free scene unlock callback does not activate access", async () => {
  const { service } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "free-unlock-token",
        action_kind: "free_scene_unlock",
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: 101,
          scene_session_id: "old-scene",
          feature_key: "scene_unlock",
        },
      });
    },
    async redeemFreeSceneUnlock(token, chatId) {
      return {
        token,
        chat_id: chatId,
        scene_session_id: "old-scene",
        turn_no: 5,
        payload_json: {
          action_kind: "free_scene_unlock",
          chat_id: 101,
          scene_session_id: "old-scene",
          feature_key: "scene_unlock",
        },
        action_kind: "free_scene_unlock",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 1,
        reason: "stale_scene",
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "free-unlock-token",
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "stale_scene");
  assert.equal(result.feature_key, "scene_unlock");
});

test("callback photo request returns next media step with neutral photo unlock", async () => {
  const { service, calls } = createRepository({
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
    async upsertInvoiceToken(input) {
      const row = input as {
        token: string;
        payload_json: Record<string, unknown>;
        sku: string;
        amount_xtr: number;
        action_kind: string;
      };
      return buildStoredInvoiceToken({
        token: row.token,
        payload_json: row.payload_json,
        sku: row.sku,
        amount_xtr: row.amount_xtr,
        action_kind: row.action_kind,
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

  assert.equal(result.operation, "edit_photo");
  assert.deepEqual(result.payment_options, []);
  assert.equal(result.invoice_token, null);
  assert.equal(result.invoice_link, null);
  assert.equal(result.photo_url, "https://cdn.test/u1.jpg");
  assert.equal(result.scene_unlock_offer_item, null);
  assert.equal(
    result.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
    true,
  );
  assert.equal(result.token_rows?.some((row) => row.action_kind === "free_photo_unlock"), true);
  assert.equal(
    result.token_rows?.find((row) => row.action_kind === "free_photo_unlock")
      ?.payload_json.photo_sku,
    "payment_media_1",
  );
  assert.equal(calls.createStarsInvoice, 0);
});

test("callback photo request unlocks through scene pass with zero price", async () => {
  const { service } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
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
      });
    },
    async loadMediaContext() {
      return buildMediaContext({
        photo_sku: null,
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
  assert.equal(
    result.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
    false,
  );
});

test("pre_checkout validates token and stores decision", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        expires_at: new Date(Date.now() + 60_000) as unknown as string,
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

test("pre_checkout allows missing expires_at as no expiry", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({ expires_at: null });
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "payment.pre_checkout.received",
    chat_id: 101,
    invoice_payload: "inv_payload",
    pre_checkout_query_id: "pcq-missing-expiry",
    payment_currency: "XTR",
    payment_total_amount: 10,
  }));

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, true);
});

for (const expiry of [
  { name: "malformed", value: "not-a-date" },
  { name: "expired", value: new Date(Date.now() - 60_000).toISOString() },
  {
    name: "expired database Date",
    value: new Date(Date.now() - 60_000) as unknown as string,
  },
] as const) {
  test(`pre_checkout rejects invoice_payload with ${expiry.name} expires_at`, async () => {
    const { service, calls } = createRepository({
      async loadInvoiceToken() {
        return buildLoadedInvoiceToken({ expires_at: expiry.value });
      },
    });

    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: `pcq-${expiry.name}-expiry`,
      payment_currency: "XTR",
      payment_total_amount: 10,
    }));

    assert.equal(result.operation, "answer_precheckout");
    assert.equal(result.precheckout_ok, false);
    assert.equal(result.reason, "invoice_expired");
    assert.equal(calls.storePrecheckoutResult, 1);
  });
}

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

test("pre_checkout rejects subscription invoice without valid subscription_days", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 0,
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
      pre_checkout_query_id: "pcq-subscription-days-invalid",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "invoice_action_kind_invalid");
});

test("pre_checkout rejects subscription invoice when offer is no longer active", async () => {
  const { service } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        amount_xtr: 200,
        scene_session_id: null,
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "old-offer",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
          chat_id: 101,
        },
      });
    },
    async loadActiveSubscriptionOfferId() {
      return "new-offer";
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: "pcq-subscription-stale-offer",
      payment_currency: "XTR",
      payment_total_amount: 200,
    }),
  );

  assert.equal(result.operation, "answer_precheckout");
  assert.equal(result.precheckout_ok, false);
  assert.equal(result.reason, "subscription_offer_not_active");
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

for (const persisted of [
  { name: "missing amount", field: "amount", incomingCurrency: "XTR" },
  { name: "missing currency", field: "currency", incomingCurrency: null },
] as const) {
  test(`pre_checkout rejects Stars invoice with ${persisted.name} despite legacy fallbacks`, async () => {
    const { service, calls } = createRepository({
      async loadInvoiceToken() {
        const row = buildLoadedInvoiceToken({
          amount: 10,
          amount_xtr: 10,
          currency: "XTR",
        });
        return persisted.field === "amount"
          ? { ...row, amount: null }
          : { ...row, currency: null };
      },
    });

    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.pre_checkout.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      pre_checkout_query_id: `pcq-${persisted.name}`,
      payment_currency: persisted.incomingCurrency,
      payment_total_amount: 10,
    }));

    assert.equal(result.operation, "answer_precheckout");
    assert.equal(result.precheckout_ok, false);
    assert.equal(result.reason, "payment_details_mismatch");
    assert.equal(calls.storePrecheckoutResult, 1);
  });
}

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
          idempotency_key: "telegram:offer-1",
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
          idempotency_key: "telegram:offer-1",
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
  assert.equal(calls.clearActiveSubscriptionOffer, 1);
  assert.deepEqual(calls.clearActiveSubscriptionOfferArgs, [
    { chatId: 101, offerId: "telegram:offer-1" },
  ]);
});

test("payment.confirmed.received resolves SBP payment by external id without internal token", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      assert.fail("SBP webhook must not load invoice by internal token");
    },
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        token: "telegram:1:payment_plan_2:sbp",
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        payment_source: "sbp",
        amount: 299,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "platega-transaction-1",
        checkout_url: "https://platega.example/checkout/1",
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "telegram:offer-1",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        token: "telegram:1:payment_plan_2:sbp",
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        payment_source: "sbp",
        amount: 299,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "platega-transaction-1",
        checkout_url: "https://platega.example/checkout/1",
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "telegram:offer-1",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: "platega-transaction-1",
      payment_currency: "RUB",
      provider_payment_amount: 299.75,
      payment_token: null,
      invoice_token: null,
      chat_id: null,
    }),
  );

  assert.equal(result.operation, "subscription_activated");
  assert.equal(result.payment_source, "sbp");
  assert.equal(result.payment_kind, "subscription");
  assert.equal(result.payment_token, "telegram:1:payment_plan_2:sbp");
  assert.deepEqual(calls.loadInvoiceTokenByExternalPaymentIdArgs, ["platega-transaction-1"]);
  assert.equal(calls.markInvoicePaid, 1);
  assert.equal(calls.activateSubscription, 1);
});

test("payment.confirmed.received rejects persisted SBP invoice without chat_id", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        chat_id: null,
        token: "telegram:1:payment_plan_2:sbp",
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        payment_source: "sbp",
        amount: 299,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "platega-transaction-missing-chat",
        checkout_url: "https://platega.example/checkout/missing-chat",
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "telegram:offer-1",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
  });

  await assert.rejects(() =>
    service.evaluate(
      buildRequest({
        interaction_mode: null,
        event_type: "payment.confirmed.received",
        payment_source: "sbp",
        external_payment_id: "platega-transaction-missing-chat",
        payment_currency: "RUB",
        provider_payment_amount: 299,
        chat_id: null,
      }),
    ), MediaRepositoryContractError);

  assert.equal(calls.markInvoicePaid, 0);
});

for (const [invoiceAmount, webhookAmount] of [[50, 52], [300, 312]] as const) {
  test(`payment.confirmed.received accepts SBP amount ${webhookAmount} for ${invoiceAmount} RUB invoice`, async () => {
    const externalPaymentId = `platega-${invoiceAmount}`;
    const capturedMarkInputs: Array<Record<string, unknown>> = [];
    const paymentRow = {
      token: `telegram:1:payment_plan_${invoiceAmount}:sbp`,
      action_kind: "subscription_payment",
      sku: `payment_plan_${invoiceAmount}`,
      payment_source: "sbp" as const,
      amount: invoiceAmount,
      amount_xtr: null,
      currency: "RUB" as const,
      external_payment_id: externalPaymentId,
      checkout_url: `https://platega.example/checkout/${invoiceAmount}`,
      payload_json: {
        action_kind: "subscription_payment",
        subscription_days: 14,
        subscription_sku: `payment_plan_${invoiceAmount}`,
      },
    };
    const { service, calls } = createRepository({
      async loadInvoiceTokenByExternalPaymentId(requestedId) {
        calls.loadInvoiceTokenByExternalPaymentIdArgs.push(requestedId);
        return buildLoadedInvoiceToken(paymentRow);
      },
      async markInvoicePaid(input) {
        calls.markInvoicePaid += 1;
        capturedMarkInputs.push(input as Record<string, unknown>);
        return buildPaidInvoiceToken(paymentRow);
      },
    });

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: null,
        event_type: "payment.confirmed.received",
        payment_source: "sbp",
        external_payment_id: externalPaymentId,
        payment_currency: "RUB",
        provider_payment_amount: webhookAmount,
        chat_id: null,
      }),
    );

    assert.equal(result.operation, "subscription_activated");
    assert.equal(result.payment_token, paymentRow.token);
    assert.equal(calls.markInvoicePaid, 1);
    assert.equal(calls.activateSubscription, 1);
    assert.equal(capturedMarkInputs[0]?.payment_total_amount, invoiceAmount);
    assert.equal(calls.recordSbpProviderEvent, 1);
    assert.deepEqual(calls.recordSbpProviderEventArgs[0], {
      external_payment_id: externalPaymentId,
      provider_status: "CONFIRMED",
      provider_amount: webhookAmount,
      provider_currency: "RUB",
      provider_payment_method: null,
    });
  });
}

test("payment.confirmed.received rejects a mismatched SBP external payment id", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 50,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "different-platega-id",
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: "requested-platega-id",
      payment_currency: "RUB",
      provider_payment_amount: 52,
      chat_id: null,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_not_found");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment.confirmed.received rejects a non-RUB SBP currency", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 50,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: externalPaymentId,
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: "platega-50",
      payment_currency: "USD",
      provider_payment_amount: 52,
      chat_id: null,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_details_mismatch");
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment.confirmed.received is idempotent for duplicate fulfilled SBP webhook", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        token: "telegram:1:payment_plan_2:sbp",
        status: "fulfilled",
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        payment_source: "sbp",
        amount: 299,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "platega-transaction-1",
        checkout_url: "https://platega.example/checkout/1",
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "telegram:offer-1",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: "platega-transaction-1",
      payment_currency: "RUB",
      provider_payment_amount: 299,
      payment_token: null,
      invoice_token: null,
      chat_id: null,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_already_fulfilled");
  assert.equal(calls.markInvoicePaid, 0);
  assert.equal(calls.activateSubscription, 0);
});

test("payment.confirmed.received retries fulfillment for already paid SBP webhook", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
      calls.loadInvoiceTokenByExternalPaymentIdArgs.push(externalPaymentId);
      return buildLoadedInvoiceToken({
        token: "telegram:1:payment_plan_2:sbp",
        status: "paid",
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        payment_source: "sbp",
        amount: 299,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: "platega-transaction-1",
        checkout_url: "https://platega.example/checkout/1",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 14,
          subscription_sku: "payment_plan_2",
        },
      });
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: "platega-transaction-1",
      payment_currency: "RUB",
      provider_payment_amount: 299,
      payment_token: null,
      invoice_token: null,
      chat_id: null,
    }),
  );

  assert.equal(result.operation, "subscription_activated");
  assert.equal(result.payment_source, "sbp");
  assert.equal(result.payment_kind, "subscription");
  assert.equal(result.payment_token, "telegram:1:payment_plan_2:sbp");
  assert.equal(calls.markInvoicePaid, 0);
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

test("payment_success treats sibling-paid Stars invoice as status conflict", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        status: "canceled",
        failure_reason: "sibling_paid",
        payment_source: "stars",
        action_kind: "photo_payment",
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
          photo_sku: "payment_media_1",
          requested_action: "photo_request",
        },
      });
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-sibling-paid",
      provider_payment_charge_id: "provider-sibling-paid",
      payment_currency: "XTR",
      payment_total_amount: 10,
    }));

    assert.equal(result.operation, "noop");
    assert.equal(result.reason, "payment_status_conflict");
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.markInvoicePaid, 0);
});

test("payment_success resumes fulfillment for a paid photo invoice", async () => {
  const loadMediaContextInputs: Array<Record<string, unknown>> = [];
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        status: "paid",
        telegram_invoice_message_id: 901,
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
    async loadMediaContext(input) {
      calls.loadMediaContext += 1;
      loadMediaContextInputs.push(input as Record<string, unknown>);
      return buildMediaContext({
        invoice_token:
          typeof (input as { invoice_token?: unknown })?.invoice_token === "string"
            ? (input as { invoice_token: string }).invoice_token
            : null,
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
  assert.equal(loadMediaContextInputs[0]?.target_message_id, 555);
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

test("Stars payment_success rejects a mismatched amount", async () => {
  const { service, calls } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: "charge-4",
      provider_payment_charge_id: "provider-4",
      payment_currency: "XTR",
      payment_total_amount: 999,
    }),
  );

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_details_mismatch");
  assert.equal(calls.markInvoicePaid, 0);
});

for (const persisted of [
  { name: "missing amount", field: "amount", incomingCurrency: "XTR" },
  { name: "missing currency", field: "currency", incomingCurrency: null },
] as const) {
  test(`Stars payment_success rejects invoice with ${persisted.name} despite legacy fallbacks`, async () => {
    const { service, calls } = createRepository({
      async loadInvoiceToken(token, chatId) {
        calls.loadInvoiceTokenArgs.push({ token, chatId });
        const row = buildLoadedInvoiceToken({
          amount: 10,
          amount_xtr: 10,
          currency: "XTR",
        });
        return persisted.field === "amount"
          ? { ...row, amount: null }
          : { ...row, currency: null };
      },
    });

    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.success.received",
      chat_id: 101,
      invoice_payload: "inv_payload",
      telegram_payment_charge_id: `charge-${persisted.name}`,
      provider_payment_charge_id: `provider-${persisted.name}`,
      payment_currency: persisted.incomingCurrency,
      payment_total_amount: 10,
    }));

    assert.equal(result.operation, "noop");
    assert.equal(result.reason, "payment_details_mismatch");
    assert.equal(calls.markInvoicePaid, 0);
  });
}

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
          idempotency_key: "telegram:offer-1",
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
          idempotency_key: "telegram:offer-1",
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
  assert.equal(calls.clearActiveSubscriptionOffer, 1);
  assert.deepEqual(calls.clearActiveSubscriptionOfferArgs, [
    { chatId: 101, offerId: "telegram:offer-1" },
  ]);
});

test("payment_success returns deferred feature fulfillment for configured custom feature keys", async () => {
  const { service, calls } = createRepository({
    async loadInvoiceToken(token, chatId) {
      calls.loadInvoiceTokenArgs.push({ token, chatId });
      return buildLoadedInvoiceToken({
        action_kind: "feature_payment",
        sku: "payment_action_3",
        amount_xtr: 100,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "future_action_3",
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
        sku: "payment_action_3",
        amount_xtr: 100,
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "future_action_3",
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
      payment_total_amount: 100,
    }),
  );

  assert.equal(result.operation, "feature_fulfillment_required");
  assert.equal(result.payment_kind, "feature");
  assert.equal(result.feature_key, "future_action_3");
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, 777);
  assert.equal(result.reason, "feature_future_action_3_fulfillment_required");
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

test("subscription_offer creates missing invoice links internally", async () => {
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

  const request = buildRequest({
    interaction_mode: "subscription_offer",
    idempotency_key: "telegram:1",
    subscription_offer_reason: "subscription_command",
    turns_today: 0,
    turn_limit: 20,
    turn_limit_reset_text: "00:00 МСК",
  });
  const result = await service.evaluate(request);
  const retry = await service.evaluate(request);
  const nextOffer = await service.evaluate({
    ...request,
    idempotency_key: "telegram:2",
  });
  const missingOfferId = await service.evaluate({
    ...request,
    idempotency_key: null,
  });

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(retry.operation, "subscription_offer_ready");
  assert.equal(nextOffer.operation, "subscription_offer_ready");
  assert.equal(missingOfferId.reason, "subscription_offer_id_required");
  assert.equal(result.subscription_invoice_tokens?.length, 2);
  assert.deepEqual(retry.subscription_invoice_tokens, result.subscription_invoice_tokens);
  assert.notDeepEqual(nextOffer.subscription_invoice_tokens, result.subscription_invoice_tokens);
  assert.equal(
    result.subscription_invoice_tokens?.some((token) => token.startsWith("telegram:chat:")),
    false,
  );
  for (const token of result.subscription_invoice_tokens ?? []) {
    assert.match(token, /^pay_[0-9a-f]{32}$/u);
    assert.ok(Buffer.byteLength(token, "utf8") < 64);
  }
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sort_order),
    [1, 2],
  );
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => firstOfferPaymentOption(item)?.checkout_url),
    [
      "https://t.me/generated-invoice-1",
      "https://t.me/generated-invoice-2",
    ],
  );
  assert.equal(calls.storeInvoiceLinks, 6);
  assert.equal(calls.loadStoredInvoiceTokens, 0);
  assert.equal(calls.createStarsInvoice, 6);
});

test("subscription_offer does not silently succeed when configured invoice attempts are missing", async () => {
  const { service, calls } = createRepository({
    async upsertInvoiceTokens() {
      return [];
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: "subscription_offer",
    idempotency_key: "telegram:missing-attempts",
    subscription_offer_reason: "subscription_command",
    turns_today: 0,
    turn_limit: 20,
    turn_limit_reset_text: "00:00 МСК",
  }));

  assert.notEqual(
    result.operation,
    "subscription_offer_ready",
    "missing invoice attempts must be surfaced instead of producing an empty successful offer",
  );
  assert.equal(calls.createStarsInvoice, 0);
});

test("subscription_offer does not silently succeed without usable payment options", async () => {
  const { service } = createRepository({
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
          status: "paid",
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: "subscription_offer",
    idempotency_key: "telegram:no-usable-options",
    subscription_offer_reason: "subscription_command",
    turns_today: 0,
    turn_limit: 20,
    turn_limit_reset_text: "00:00 МСК",
  }));

  assert.notEqual(
    result.operation,
    "subscription_offer_ready",
    "non-renderable payment rows must not produce an empty successful offer",
  );
  assert.equal(result.reason, "subscription_payment_options_missing");
});

test("subscription_offer assigns sticky ab group and stores compact context in payment tokens", async () => {
  const [experiment] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify({
      key: "subscription_offer",
      version: "v1",
      description: "Subscription offer B",
      starts_at: "2020-01-01T00:00:00+00:00",
      ends_at: "2100-01-01T00:00:00+00:00",
      distribution: { B: 100 },
      variants: {
        B: {
          command_offer_text: "B command offer",
          scene_unlock: { enabled: false },
          plans: [
            {
              sku: "payment_plan_2",
              amount_xtr: 111,
              title: "B title",
              description: "B description",
              label: "B label",
              button_text: "B button",
            },
            {
              sku: "payment_plan_3",
              enabled: false,
            },
          ],
        },
      },
    }),
  });
  const assignments = new Map<string, AbTestAssignment>();
  const capturedBatches: unknown[][] = [];
  let loadAssignments = 0;
  let storeAssignments = 0;
  const { service } = createRepository({
    async loadAbTestAssignment(_chatId, assignmentKey) {
      loadAssignments += 1;
      return assignments.get(assignmentKey) ?? null;
    },
    async storeAbTestAssignment(_chatId, assignmentKey, assignment) {
      storeAssignments += 1;
      const existing = assignments.get(assignmentKey) ?? null;
      if (existing) return existing;
      assignments.set(assignmentKey, assignment);
      return assignment;
    },
    async upsertInvoiceTokens(inputs) {
      const batch = Array.isArray(inputs) ? inputs : [];
      capturedBatches.push(batch);
      return batch.map((input) => {
        const row = input as {
          token: string;
          sku: string;
          amount_xtr: number;
          payload_json: Record<string, unknown>;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        };

        return buildStoredInvoiceToken({
          token: row.token,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          payload_json: row.payload_json,
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
          invoice_link: "https://t.me/ab-invoice",
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  await withExperiments([experiment!], async () => {
    const first = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:ab",
        subscription_offer_reason: "subscription_command",
      }),
    );
    const second = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:ab",
        subscription_offer_reason: "subscription_command",
      }),
    );

    assert.equal(first.operation, "subscription_offer_ready");
    assert.equal(first.text, "B command offer");
    assert.deepEqual(first.ab_test, {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v1",
      variant: "B",
    });
    assert.deepEqual(
      assignments.get("subscription_offer|2020-01-01T00:00:00+00:00"),
      {
        variant: "B",
        assigned_at: assignments
          .get("subscription_offer|2020-01-01T00:00:00+00:00")?.assigned_at,
      },
    );
    assert.deepEqual(
      first.subscription_offer_items?.map((item) => item.sku),
      ["payment_plan_2"],
    );
    assert.equal(
      first.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
      false,
    );
    assert.match(first.subscription_invoice_tokens?.[0] ?? "", /^pay_[0-9a-f]{32}$/u);
    assert.deepEqual(second.subscription_invoice_tokens, first.subscription_invoice_tokens);
    assert.equal(first.subscription_offer_items?.[0]?.title, "B title");
    assert.equal(first.subscription_offer_items?.[0]?.description, "B description");
    assert.equal(first.subscription_offer_items?.[0]?.label, "B label");
    assert.equal(firstOfferPaymentOption(first.subscription_offer_items?.[0])?.amount, 111);
    assert.equal(firstOfferPaymentOption(first.subscription_offer_items?.[0])?.button_text, "star 111");
    assert.deepEqual(
      (capturedBatches[0]?.[0] as { payload_json?: Record<string, unknown> })?.payload_json?.ab_test,
      first.ab_test,
    );
    assert.equal(loadAssignments, 2);
    assert.equal(storeAssignments, 1);
  });
});

test("subscription_offer keeps assigned group but uses current experiment version params", async () => {
  const [changedExperiment] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify({
      key: "subscription_offer",
      version: "v2",
      description: "Changed B",
      starts_at: "2020-01-01T00:00:00+00:00",
      ends_at: "2100-01-01T00:00:00+00:00",
      distribution: { B: 100 },
      variants: {
        B: {
          command_offer_text: "new B copy",
          scene_unlock: { enabled: false },
          plans: [
            {
              sku: "payment_plan_2",
              amount_xtr: 999,
              button_text: "new B button",
            },
          ],
        },
      },
    }),
  });
  const savedAssignment = buildAssignment({
    variant: "B",
    assigned_at: "2026-09-10T10:00:00.000Z",
  });
  const { service } = createRepository({
    async loadAbTestAssignment() {
      return savedAssignment;
    },
    async storeAbTestAssignment() {
      throw new Error("existing assignment must not be overwritten");
    },
    async upsertInvoiceTokens(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => {
        const row = input as {
          token: string;
          sku: string;
          amount_xtr: number;
          payload_json: Record<string, unknown>;
          invoice_button_text: string;
        };
        return buildStoredInvoiceToken({
          token: row.token,
          sku: row.sku,
          amount_xtr: row.amount_xtr,
          payload_json: row.payload_json,
          invoice_button_text: row.invoice_button_text,
          invoice_link: "https://t.me/new-ab-invoice",
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  await withExperiments([changedExperiment!], async () => {
    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:ab-changed",
        subscription_offer_reason: "subscription_command",
      }),
    );

    assert.deepEqual(result.ab_test, {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v2",
      variant: "B",
    });
    assert.equal(result.text, "new B copy");
    assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0])?.amount, 999);
  });
});

test("subscription_offer logs and skips ab when saved variant is missing from current config", async () => {
  const [experiment] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify({
      key: "subscription_offer",
      version: "v2",
      starts_at: "2020-01-01T00:00:00+00:00",
      ends_at: "2100-01-01T00:00:00+00:00",
      distribution: { A: 100 },
      variants: {
        A: {
          command_offer_text: "A command offer",
        },
      },
    }),
  });
  const savedAssignment = buildAssignment({
    variant: "B",
    assigned_at: "2026-09-10T10:00:00.000Z",
  });
  const capturedErrors: unknown[][] = [];
  const previousConsoleError = console.error;
  const { service } = createRepository({
    async loadAbTestAssignment() {
      return savedAssignment;
    },
    async storeAbTestAssignment() {
      throw new Error("missing variant must not reassign user");
    },
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
          invoice_link: "https://t.me/default-invoice",
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  console.error = (...args: unknown[]) => {
    capturedErrors.push(args);
  };
  try {
    await withExperiments([experiment!], async () => {
      const result = await service.evaluate(
        buildRequest({
          interaction_mode: "subscription_offer",
          idempotency_key: "telegram:ab-missing-variant",
          subscription_offer_reason: "subscription_command",
        }),
      );

      assert.equal(result.operation, "subscription_offer_ready");
      assert.equal(result.ab_test, null);
      assert.equal(result.text, null);
      assert.equal(
        result.subscription_invoice_tokens?.some((token) => token.includes(":ab_")),
        false,
      );
      assert.equal(capturedErrors.length, 1);
      assert.equal(capturedErrors[0]?.[0], "[media_commerce] ab_test_variant_missing");
      assert.deepEqual(capturedErrors[0]?.[1], {
        chat_id: 101,
        key: "subscription_offer",
        starts_at: "2020-01-01T00:00:00+00:00",
        version: "v2",
        variant: "B",
      });
    });
  } finally {
    console.error = previousConsoleError;
  }
});

test("subscription_offer version change creates a new payment token and keeps ab snapshot per token", async () => {
  const buildExperiment = (version: "v1" | "v2", amountXtr: number) =>
    loadExperimentConfigsFromEnv({
      EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify({
        key: "subscription_offer",
        version,
        starts_at: "2020-01-01T00:00:00+00:00",
        ends_at: "2100-01-01T00:00:00+00:00",
        distribution: { B: 100 },
        variants: {
          B: {
            scene_unlock: { enabled: false },
            plans: [
              {
                sku: "payment_plan_2",
                amount_xtr: amountXtr,
              },
              {
                sku: "payment_plan_3",
                enabled: false,
              },
            ],
          },
        },
      }),
    })[0]!;

  const savedAssignment = buildAssignment({
    variant: "B",
    assigned_at: "2026-09-10T10:00:00.000Z",
  });
  const capturedBatches: unknown[][] = [];
  const { service } = createRepository({
    async loadAbTestAssignment() {
      return savedAssignment;
    },
    async storeAbTestAssignment() {
      throw new Error("existing assignment must not be overwritten");
    },
    async upsertInvoiceTokens(inputs) {
      const batch = Array.isArray(inputs) ? inputs : [];
      capturedBatches.push(batch);
      return batch.map((input) => {
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
          invoice_link: `https://t.me/${row.token}`,
          scene_session_id: null,
          turn_no: null,
          scene_turn_no: null,
        });
      });
    },
  });

  const request = buildRequest({
    interaction_mode: "subscription_offer",
    idempotency_key: "telegram:same-idempotency",
    subscription_offer_reason: "subscription_command",
  });

  const first = await withExperiments([buildExperiment("v1", 111)], async () =>
    service.evaluate(request),
  );
  const second = await withExperiments([buildExperiment("v2", 222)], async () =>
    service.evaluate(request),
  );

  const firstToken = first.subscription_invoice_tokens?.[0];
  const secondToken = second.subscription_invoice_tokens?.[0];
  assert.ok(firstToken);
  assert.ok(secondToken);
  assert.notEqual(firstToken, secondToken);
  assert.equal(first.subscription_offer_items?.[0]?.sku, "payment_plan_2");
  assert.equal(second.subscription_offer_items?.[0]?.sku, "payment_plan_2");
  assert.deepEqual(
    (capturedBatches[0]?.[0] as { payload_json?: Record<string, unknown> })?.payload_json?.ab_test,
    {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v1",
      variant: "B",
    },
  );
  assert.deepEqual(
    (capturedBatches[1]?.[0] as { payload_json?: Record<string, unknown> })?.payload_json?.ab_test,
    {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v2",
      variant: "B",
    },
  );
});

test("subscription_offer ignores inactive ab experiment without loading assignments", async () => {
  const [experiment] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify({
      key: "subscription_offer",
      version: "v1",
      starts_at: "2020-01-01T00:00:00+00:00",
      ends_at: "2020-02-01T00:00:00+00:00",
      distribution: { B: 100 },
      variants: {
        B: {
          command_offer_text: "expired B",
        },
      },
    }),
  });
  const { service } = createRepository({
    async loadAbTestAssignment() {
      throw new Error("inactive experiment must not load assignments");
    },
    async storeAbTestAssignment() {
      throw new Error("inactive experiment must not store assignments");
    },
  });

  await withExperiments([experiment!], async () => {
    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:ab-expired",
        subscription_offer_reason: "subscription_command",
      }),
    );

    assert.equal(result.ab_test, null);
    assert.equal(result.text, null);
  });
});

test("finalize_subscription_offer records ab_delivered event after Telegram send", async () => {
  let capturedDelivery: unknown = null;
  const { service, calls } = createRepository({
    async recordAbTestDelivered(input) {
      calls.recordAbTestDelivered += 1;
      capturedDelivery = input;
      return 1;
    },
    async storeSubscriptionOfferMessageId() {
      return 1;
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "finalize_subscription_offer",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 9,
      scene_turn_no: 4,
      offer_message_id: 777,
      subscription_invoice_tokens: ["token-1", "token-2"],
      ab_test: {
        key: "subscription_offer",
        starts_at: "2020-01-01T00:00:00+00:00",
        version: "v2",
        variant: "B",
      },
    }),
  );

  assert.equal(result.operation, "subscription_offer_finalized");
  assert.equal(calls.recordAbTestDelivered, 1);
  assert.deepEqual(capturedDelivery, {
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 9,
    scene_turn_no: 4,
    ab_test: {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v2",
      variant: "B",
    },
  });
  assert.equal(result.inserted_count, 1);
  assert.deepEqual(result.ab_test, {
    key: "subscription_offer",
    starts_at: "2020-01-01T00:00:00+00:00",
    version: "v2",
    variant: "B",
  });
});

test("subscription_offer returns SBP default source and toggle callback tokens when SBP is available", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousSubscriptionPlans = config.MEDIA_SUBSCRIPTION_PLANS_JSON;

  config.SBP_ENABLED = true;
  config.MEDIA_SUBSCRIPTION_PLANS_JSON = [
    {
      sku: "payment_plan_7",
      days: 7,
      amount_xtr: 100,
      amount_rub: 199,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
    {
      sku: "payment_plan_30",
      days: 30,
      amount_xtr: 300,
      amount_rub: 499,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    },
  ];

  try {
    const { service, calls } = createRepository({
      async loadSceneAccessStatus(input) {
        calls.loadSceneAccessStatus += 1;
        const source = (input ?? {}) as { chat_id?: number | null };
        return {
          chat_id: source.chat_id ?? 101,
          scene_session_id: null,
          active_scene_session_id: null,
          subscription_active: false,
          scene_access_active: true,
          scene_is_active: false,
        };
      },
    });

    const result = await service.evaluate(
      buildRequest({
        interaction_mode: "subscription_offer",
        idempotency_key: "telegram:subscription-toggle",
        subscription_offer_reason: "subscription_command",
      }),
    );

    assert.equal(result.operation, "subscription_offer_ready");
    assert.equal(result.selected_payment_source, "sbp");
    assert.deepEqual(
      result.subscription_offer_items?.map((item) => item.sku),
      ["payment_plan_7", "payment_plan_30"],
    );
    assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0], "sbp")?.button_text, "sbp 199");
    assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0], "stars")?.button_text, "star 100");
    const toggleRows = result.token_rows?.filter((row) =>
      row.action_kind === "subscription_payment_source_toggle") ?? [];
    assert.equal(toggleRows.length, 2);
    assert.ok(result.payment_source_toggle_tokens?.stars);
    assert.ok(result.payment_source_toggle_tokens?.sbp);
    const sbpOption = firstOfferPaymentOption(result.subscription_offer_items?.[0], "sbp");
    assert.match(sbpOption?.token ?? "", /^pay_[0-9a-f]{32}:sbp$/u);
    assert.equal(
      sbpOption?.checkout_url,
      `https://gateway.example/v1/pay/sbp/${encodeURIComponent(String(sbpOption?.token))}`,
    );
    for (const row of toggleRows) {
      assert.equal(row.expires_at, null);
      assert.deepEqual(
        new Set(row.payload_json.invoice_tokens as string[]),
        new Set(result.subscription_invoice_tokens),
      );
      assert.equal(row.payload_json.payment_options, undefined);
      assert.equal(row.payload_json.subscription_offer_items, undefined);
      assert.equal(row.payload_json.token_rows, undefined);
      assert.equal(row.payload_json.text, undefined);
      assert.equal(row.payload_json.payment_ui, undefined);
      assert.equal(row.payload_json.ab_test, undefined);
    }
    assert.equal(calls.createStarsInvoice, 2);
    assert.equal(calls.createSbpPayment, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_SUBSCRIPTION_PLANS_JSON = previousSubscriptionPlans;
  }
});

test("SBP redirect creates one checkout and reuses it for the same subscription token", async () => {
  let storedCheckout: {
    checkout_url: string;
    external_payment_id: string;
    expires_at: string | null;
  } | null = null;
  const providerExpiresAt = "2030-01-01T00:00:00.000Z";
  let persistedExpiresAt: string | null | undefined;
  let claimHeld = false;
  const token = "telegram:subscription:payment_plan_7:sbp";
  const sbpRow = () => buildStoredInvoiceToken({
    token,
    action_kind: "subscription_payment",
    sku: "payment_plan_7",
    payment_source: "sbp",
    amount: 199,
    currency: "RUB",
    checkout_url: storedCheckout?.checkout_url ?? null,
    external_payment_id: storedCheckout?.external_payment_id ?? null,
    amount_xtr: null,
    telegram_invoice_payload: null,
    expires_at: storedCheckout?.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
    payload_json: buildSbpSubscriptionPayload("telegram:offer-1", "payment_plan_7"),
  });

  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens(tokens) {
      return tokens.includes(token) ? [sbpRow()] : [];
    },
    async claimSbpCheckoutCreation(requestedToken, chatId) {
      return {
        token: requestedToken,
        chat_id: chatId,
        checkout_url: storedCheckout?.checkout_url ?? null,
        external_payment_id: storedCheckout?.external_payment_id ?? null,
        claim_acquired: storedCheckout == null && !claimHeld
          ? (claimHeld = true)
          : false,
      };
    },
    async storeInvoiceLinks(items) {
      const [item] = Array.isArray(items) ? items as Array<{
        checkout_url?: string | null;
        external_payment_id?: string | null;
        expires_at?: string | null;
      }> : [];
      if (item?.checkout_url && item.external_payment_id) {
        storedCheckout = {
          checkout_url: item.checkout_url,
          external_payment_id: item.external_payment_id,
          expires_at: item.expires_at ?? null,
        };
        persistedExpiresAt = item.expires_at ?? null;
      }
      return item ? 1 : 0;
    },
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        token,
        requested_token: token,
        action_kind: "subscription_payment",
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        checkout_url: storedCheckout?.checkout_url ?? null,
        external_payment_id: storedCheckout?.external_payment_id ?? null,
        expires_at: storedCheckout?.expires_at ?? null,
      });
    },
  }, {}, {
    async createPayment(input) {
      calls.createSbpPayment += 1;
      calls.createSbpPaymentInputs.push(input);
      return {
        external_payment_id: `sbp-payment-${calls.createSbpPayment}`,
        checkout_url: `https://sbp.example/checkout/${calls.createSbpPayment}`,
        provider_expires_at: providerExpiresAt,
      };
    },
  });

  const [firstUrl, secondUrl] = await Promise.all([
    service.resolveSbpCheckout(token),
    service.resolveSbpCheckout(token),
  ]);
  const repeatedUrl = await service.resolveSbpCheckout(token);

  assert.equal(firstUrl, "https://sbp.example/checkout/1");
  assert.equal(secondUrl, firstUrl);
  assert.equal(repeatedUrl, firstUrl);
  assert.equal(calls.createSbpPayment, 1);
  assert.equal(persistedExpiresAt, providerExpiresAt);
});

test("subscription payment source toggle callback reuses stored offer data", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "stars",
      amount: 100,
      currency: "XTR",
      amount_xtr: 100,
      invoice_link: "https://t.me/invoice",
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
      invoice_button_text: "star 100",
    }),
    buildStoredInvoiceToken({
      token: "sbp-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "sbp",
      amount: 199,
      currency: "RUB",
      amount_xtr: 100,
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
      invoice_button_text: "sbp 199",
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken(token, chatId) {
      calls.loadCallbackTokenArgs.push({ token, chatId });
      return buildLoadedCallbackToken({
        token: "btn_toggle_stars",
        scene_session_id: null,
        turn_no: null,
        action_kind: "subscription_payment_source_toggle",
        payload_json: {
          action_kind: "subscription_payment_source_toggle",
          chat_id: 101,
          selected_payment_source: "stars",
          offer_id: "telegram:offer-7",
          invoice_tokens: ["stars-token", "sbp-token"],
          payment_source_toggle_tokens: {
            stars: "btn_toggle_stars",
            sbp: "btn_toggle_sbp",
          },
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
    async loadActiveSubscriptionOfferId() {
      return "telegram:offer-7";
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "btn_toggle_stars",
      callback_query_id: "cbq-1",
      inbound_message_id: 777,
    }),
  );

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.selected_payment_source, "stars");
  assert.equal(result.offer_message_id, 777);
  assert.equal(result.subscription_offer_items?.length, 1);
  assert.equal(result.subscription_offer_items?.[0]?.sku, "payment_plan_7");
  assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0], "stars")?.checkout_url, "https://t.me/invoice");
  assert.match(
    firstOfferPaymentOption(result.subscription_offer_items?.[0], "sbp")?.checkout_url ?? "",
    /\/v1\/pay\/sbp\/sbp-token$/u,
  );
  assert.deepEqual(result.payment_source_toggle_tokens, {
    stars: "btn_toggle_stars",
    sbp: "btn_toggle_sbp",
  });
  assert.equal(calls.loadMediaContext, 0);
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.createSbpPayment, 0);
});

test("subscription payment source toggle callback rejects stale active offer", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "stars",
      amount: 100,
      currency: "XTR",
      amount_xtr: 100,
      invoice_link: "https://t.me/invoice",
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:old-offer",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_toggle_stars",
        scene_session_id: null,
        turn_no: null,
        action_kind: "subscription_payment_source_toggle",
        payload_json: {
          action_kind: "subscription_payment_source_toggle",
          chat_id: 101,
          selected_payment_source: "stars",
          invoice_tokens: ["stars-token"],
          payment_source_toggle_tokens: {
            stars: "btn_toggle_stars",
          },
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
    async loadActiveSubscriptionOfferId() {
      return "telegram:new-offer";
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_toggle_stars",
    inbound_message_id: 777,
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "callback_invalid");
  assert.equal(result.callback_valid, false);
  assert.equal(calls.createStarsInvoice, 0);
});

test("subscription payment source toggle callback rejects terminal non-renderable attempts", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "stars",
      status: "fulfilled",
      amount: 100,
      currency: "XTR",
      amount_xtr: 100,
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
    }),
    buildStoredInvoiceToken({
      token: "sbp-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "sbp",
      status: "canceled",
      failure_reason: "sibling_paid",
      amount: 199,
      currency: "RUB",
      amount_xtr: 100,
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_toggle_stars",
        scene_session_id: null,
        turn_no: null,
        action_kind: "subscription_payment_source_toggle",
        payload_json: {
          action_kind: "subscription_payment_source_toggle",
          chat_id: 101,
          offer_id: "telegram:offer-7",
          selected_payment_source: "stars",
          invoice_tokens: ["stars-token", "sbp-token"],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
    async loadActiveSubscriptionOfferId() {
      return "telegram:offer-7";
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_toggle_stars",
    inbound_message_id: 777,
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "callback_invalid");
  assert.equal(result.callback_valid, false);
  assert.equal(result.subscription_offer_items, undefined);
  assert.equal(calls.createStarsInvoice, 0);
});

test("subscription payment source toggle callback rejects mismatched payload offer id", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "stars",
      amount: 100,
      currency: "XTR",
      amount_xtr: 100,
      invoice_link: "https://t.me/invoice",
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_toggle_stars",
        scene_session_id: null,
        turn_no: null,
        action_kind: "subscription_payment_source_toggle",
        payload_json: {
          action_kind: "subscription_payment_source_toggle",
          chat_id: 101,
          offer_id: "telegram:different-offer",
          selected_payment_source: "stars",
          invoice_tokens: ["stars-token"],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
    async loadActiveSubscriptionOfferId() {
      return "telegram:offer-7";
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_toggle_stars",
    inbound_message_id: 777,
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "callback_invalid");
  assert.equal(result.callback_valid, false);
  assert.equal(calls.createStarsInvoice, 0);
});

test("legacy subscription payment source toggle callback derives offer id from invoice rows", async () => {
  const invoiceRows = [
    buildStoredInvoiceToken({
      token: "stars-token",
      action_kind: "subscription_payment",
      sku: "payment_plan_7",
      payment_source: "stars",
      amount: 100,
      currency: "XTR",
      amount_xtr: 100,
      invoice_link: "https://t.me/invoice",
      scene_session_id: null,
      payload_json: {
        action_kind: "subscription_payment",
        idempotency_key: "telegram:offer-7",
        subscription_days: 7,
        subscription_sku: "payment_plan_7",
        sort_order: 1,
      },
      invoice_button_text: "star 100",
    }),
  ];
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "btn_toggle_stars",
        scene_session_id: null,
        turn_no: null,
        action_kind: "subscription_payment_source_toggle",
        payload_json: {
          action_kind: "subscription_payment_source_toggle",
          chat_id: 101,
          selected_payment_source: "stars",
          subscription_offer_items: [
            {
              sku: "stale-snapshot",
              payment_options: [
                {
                  token: "stars-token",
                  amount: 999,
                  checkout_url: "https://legacy.example/stale",
                },
              ],
            },
          ],
        },
      });
    },
    async loadStoredInvoiceTokens(tokens) {
      calls.loadStoredInvoiceTokens += 1;
      return invoiceRows.filter((row) => tokens.includes(row.token));
    },
    async loadActiveSubscriptionOfferId() {
      return "telegram:offer-7";
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "callback_query.received",
    callback_data: "btn_toggle_stars",
    inbound_message_id: 777,
  }));

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.selected_payment_source, "stars");
  assert.equal(result.subscription_offer_items?.[0]?.sku, "payment_plan_7");
  assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0])?.amount, 100);
  assert.equal(firstOfferPaymentOption(result.subscription_offer_items?.[0])?.checkout_url, "https://t.me/invoice");
  assert.equal(calls.createStarsInvoice, 0);
});

test("subscription_offer returns one scene unlock entry button regardless of free credit snapshot", async () => {
  const { service, calls } = createRepository({
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 0,
        free_scene_unlocks: 1,
      };
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

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.subscription_invoice_tokens?.length, 2);
  for (const token of result.subscription_invoice_tokens ?? []) {
    assert.match(token, /^pay_[0-9a-f]{32}$/u);
  }
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.equal(result.token_rows?.length, 1);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_scene_unlock");
  assert.equal(result.token_rows?.[0]?.payload_json.action_button_text, "text");
  assert.equal(
    result.token_rows?.[0]?.payload_json.payment_options,
    undefined,
  );
  assert.equal(result.token_rows_inserted, 1);
  assert.equal(calls.loadFreeCredits, 0);
  assert.equal(calls.createStarsInvoice, 2);
});

test("subscription_offer returns reusable free balance text for the inactive subscription UI", async () => {
  const { service } = createRepository();

  const result = await service.evaluate(buildRequest({
    interaction_mode: "subscription_offer",
    idempotency_key: "telegram:gift-balances",
    subscription_offer_reason: "subscription_command",
    free_scene_unlocks: 2,
    free_photo_unlocks: 0,
    free_fast_scene_skips: 1,
  }));

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.free_balance_text, [
    "🎁 У тебя есть:",
    "• 2 бесплатные разблокировки сцены",
    "• 1 бесплатный пропуск сцены",
  ].join("\n"));
});

test("daily limit subscription_offer returns the same single scene unlock entry button with no free credits", async () => {
  const { service, calls } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:daily-limit",
      subscription_offer_reason: "daily_turn_limit",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_ready");
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.equal(result.token_rows?.length, 1);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_scene_unlock");
  assert.equal(calls.loadFreeCredits, 0);
  assert.equal(calls.createStarsInvoice, 2);
});

test("subscription_offer uses the active scene id even when scene turn context is absent", async () => {
  const { service } = createRepository();

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      scene_turn_no: null,
      idempotency_key: "telegram:scene-id-only",
      subscription_offer_reason: "subscription_command",
    }),
  );

  assert.equal(result.token_rows?.length, 1);
  assert.equal(result.token_rows?.[0]?.action_kind, "free_scene_unlock");
  assert.equal(result.token_rows?.[0]?.scene_session_id, "scene-1");
});

test("subscription_offer does not return free scene unlock callback for active subscription", async () => {
  const { service, calls } = createRepository({
    async loadSceneAccessStatus() {
      calls.loadSceneAccessStatus += 1;
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-1",
        subscription_active: true,
        scene_access_active: false,
        scene_is_active: true,
      };
    },
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 0,
        free_scene_unlocks: 1,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:1",
      subscription_offer_reason: "subscription_command",
    }),
  );

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.token_rows?.length, 0);
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.equal(calls.loadFreeCredits, 0);
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
    async loadFreeCredits(chatId) {
      return {
        chat_id: chatId,
        active_scene_session_id: null,
        free_fast_scene_skips: 0,
        free_scene_unlocks: 0,
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

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.subscription_invoice_tokens?.length, 2);
  for (const token of result.subscription_invoice_tokens ?? []) {
    assert.match(token, /^pay_[0-9a-f]{32}$/u);
  }
});

test("subscription_offer does not include scene unlock when request is outside current scene", async () => {
  const { service, calls } = createRepository({
    async loadSceneAccessStatus() {
      calls.loadSceneAccessStatus += 1;
      return {
        chat_id: 101,
        scene_session_id: "scene-1",
        active_scene_session_id: "scene-1",
        subscription_active: false,
        scene_access_active: false,
        scene_is_active: true,
      };
    },
    async loadFreeCredits(chatId) {
      calls.loadFreeCredits += 1;
      return {
        chat_id: chatId,
        active_scene_session_id: "scene-1",
        free_fast_scene_skips: 0,
        free_scene_unlocks: 1,
      };
    },
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      scene_session_id: null,
      scene_turn_no: null,
      active_scene_session_id: "scene-1",
      idempotency_key: "telegram:outside-scene",
      subscription_offer_reason: "subscription_command",
      turns_today: 0,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.subscription_invoice_tokens?.length, 2);
  for (const token of result.subscription_invoice_tokens ?? []) {
    assert.match(token, /^pay_[0-9a-f]{32}$/u);
  }
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.equal(
    result.subscription_offer_items?.some((item) => item.feature_key === "scene_unlock"),
    false,
  );
  assert.equal(
    result.token_rows?.some((row) =>
      row.action_kind === "free_scene_unlock"
      || (
        row.action_kind === "reveal_feature_payment_options"
        && row.payload_json.feature_key === "scene_unlock"
      )),
    false,
  );
  assert.equal(calls.createStarsInvoice, 2);
});

test("subscription_offer hides scene unlock button when scene access is already active", async () => {
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

  assert.equal(result.operation, "subscription_offer_ready");
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => item.sku),
    ["payment_plan_2", "payment_plan_3"],
  );
  assert.equal(
    result.token_rows?.some((row) => row.action_kind === "free_scene_unlock"),
    false,
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

  assert.equal(result.operation, "subscription_offer_ready");
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

    assert.equal(result.operation, "subscription_offer_ready");
    assert.deepEqual(
      result.subscription_offer_items?.map((item) => firstOfferPaymentOption(item)?.amount),
      [140, 180],
    );
    assert.deepEqual(
      result.subscription_offer_items?.map((item) => firstOfferPaymentOption(item)?.original_amount),
      [200, 300],
    );
    assert.deepEqual(
      result.subscription_offer_items?.map((item) => item.promo_key),
      ["plan_2_override", "all_sale"],
    );
  });
});

test("subscription_offer persists freshly created links without reload loop", async () => {
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
  });

  const result = await service.evaluate(
    buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "telegram:1",
      subscription_offer_reason: "daily_turn_limit",
      turns_today: 20,
      turn_limit: 20,
      turn_limit_reset_text: "00:00 МСК",
    }),
  );

  assert.equal(calls.storeInvoiceLinks, 2);
  assert.equal(calls.loadStoredInvoiceTokens, 0);
  assert.equal(calls.createStarsInvoice, 2);
  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.offer_reused, false);
  assert.equal(result.text, null);
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => firstOfferPaymentOption(item)?.checkout_url),
    [
      "https://t.me/generated-invoice-1",
      "https://t.me/generated-invoice-2",
    ],
  );
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
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(result.operation, "subscription_offer_ready");
  assert.equal(result.text, null);
  assert.deepEqual(
    result.subscription_offer_items?.map((item) => firstOfferPaymentOption(item)?.checkout_url),
    [
      "https://t.me/reused-1",
      "https://t.me/reused-2",
    ],
  );
  assert.equal(result.offer_reused, true);
});

test("prepare_offer uses stable neutral callback tokens for the same paid photo context", async () => {
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
  const differentSku = await service.evaluate(buildRequest({
    photo_sku: "payment_media_2",
  }));
  const firstToken = first.token_rows?.[0]?.token;
  const secondToken = second.token_rows?.[0]?.token;
  const differentSkuToken = differentSku.token_rows?.[0]?.token;

  assert.equal(first.operation, "prepare_offer_callback");
  assert.equal(second.operation, "prepare_offer_callback");
  assert.equal(differentSku.operation, "prepare_offer_callback");
  assert.equal(firstToken, secondToken);
  assert.notEqual(firstToken, differentSkuToken);
  assert.match(firstToken ?? "", /^btn_[0-9a-f]{32}$/u);
  assert.ok(Buffer.byteLength(firstToken ?? "", "utf8") <= 64);
  assert.equal(first.token_rows?.[0]?.action_kind, "free_photo_unlock");
  assert.equal(differentSku.token_rows?.[0]?.action_kind, "free_photo_unlock");
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

test("free photo finalization uses the dedicated token-bound fulfillment path", async () => {
  let dedicatedInput: Record<string, unknown> | null = null;
  let paidPathCalled = false;
  const { service } = createRepository({
    async storePhotoEvent() {
      paidPathCalled = true;
      throw new Error("paid photo path must not be used");
    },
    async finalizeFreePhotoUnlock(input) {
      dedicatedInput = input as Record<string, unknown>;
      return {
        chat_id: 101,
        n: 5,
        scene_session_id: "scene-1",
        scene_turn_no: 3,
        media_signature: "hotel_corridor_close",
        price_required: 0,
        panel_message_id: 555,
        stored_count: 1,
        invoice_rows_updated: 1,
      };
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: "finalize_photo_event",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    log_event_type: "media.photo.unlocked.free",
    media_signature: "hotel_corridor_close",
    selected_uuid: "u2",
    panel_message_id: 555,
    log_price_xtr: 0,
    access_mode: "free_credit",
    action_kind: "free_photo_unlock",
    fulfillment_invoice_token: "photo-unlock-entry",
    price_required: 0,
  }));

  assert.equal(result.operation, "photo_event_stored");
  assert.equal(result.stored_count, 1);
  assert.equal(paidPathCalled, false);
  assert.deepEqual(dedicatedInput, {
    token: "photo-unlock-entry",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    uuid: "u2",
    panel_message_id: 555,
  });
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

test("SBP checkout rejects stale and malformed invoice lifecycle before provider call", async () => {
  const token = "lifecycle-sbp-token";
  const cases: Array<{ name: string; overrides: Partial<StoredInvoiceToken> }> = [
    { name: "expired", overrides: { expires_at: new Date(Date.now() - 1_000).toISOString() } },
    { name: "malformed expiry", overrides: { expires_at: "not-a-date" } },
    { name: "paid", overrides: { status: "paid" } },
    { name: "fulfilled", overrides: { status: "fulfilled" } },
    { name: "canceled", overrides: { status: "canceled" } },
    { name: "failed", overrides: { status: "failed" } },
    { name: "wrong kind", overrides: { kind: "button_callback" } },
    { name: "wrong payment source", overrides: { payment_source: "stars" } },
    { name: "wrong action", overrides: { action_kind: "free_scene_unlock" } },
  ];

  for (const entry of cases) {
    const { service, calls } = createRepository({
      async loadStoredInvoiceTokens() {
        return [buildStoredInvoiceToken({
          token,
          payment_source: "sbp",
          amount: 199,
          currency: "RUB",
          amount_xtr: null,
          telegram_invoice_payload: null,
          action_kind: "subscription_payment",
          payload_json: { action_kind: "subscription_payment" },
          ...entry.overrides,
        })];
      },
    });

    await assert.rejects(
      () => service.resolveSbpCheckout(token),
      (error: unknown) => error instanceof Error && "code" in error,
      entry.name,
    );
    assert.equal(calls.createSbpPayment, 0, entry.name);
  }
});

test("SBP checkout fails when invoice becomes ineligible during atomic claim", async () => {
  const token = "claim-race-sbp-token";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
    async claimSbpCheckoutCreation() {
      return {
        token,
        chat_id: 101,
        checkout_url: null,
        external_payment_id: null,
        claim_acquired: false,
        creation_state: "idle",
        eligible: false,
      };
    },
  });

  await assert.rejects(() => service.resolveSbpCheckout(token));
  assert.equal(calls.createSbpPayment, 0);
});

test("SBP checkout does not return a claimed checkout when claim reports ineligible", async () => {
  const token = "claim-ineligible-with-checkout";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
    async claimSbpCheckoutCreation() {
      return {
        token,
        chat_id: 101,
        checkout_url: "https://sbp.example/stale-checkout",
        external_payment_id: "stale-payment",
        claim_acquired: false,
        creation_state: "created",
        eligible: false,
      };
    },
  });

  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_invoice_status_invalid",
  );
  assert.equal(calls.createSbpPayment, 0);
});

test("ambiguous SBP provider outcome is durable and never retried automatically", async () => {
  const token = "ambiguous-provider-sbp-token";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
  }, {}, {
    async createPayment() {
      calls.createSbpPayment += 1;
      throw new SbpPaymentError(
        "provider timed out",
        "request",
        null,
        "ambiguous",
      );
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => service.resolveSbpCheckout(token));
    await assert.rejects(
      () => service.resolveSbpCheckout(token),
      (error: unknown) => error instanceof Error && "code" in error
        && error.code === "sbp_checkout_creation_uncertain",
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.createSbpPayment, 1);
  assert.equal(calls.markSbpCheckoutCreationUncertain, 1);
  assert.equal(calls.releaseSbpCheckoutCreation, 0);
});

test("ambiguous SBP outcome fails with a typed internal error when uncertain state is not persisted", async () => {
  const token = "ambiguous-state-write-missed";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
    async markSbpCheckoutCreationUncertain() {
      calls.markSbpCheckoutCreationUncertain += 1;
      return 0;
    },
  }, {}, {
    async createPayment() {
      calls.createSbpPayment += 1;
      throw new SbpPaymentError("provider timed out", "request", null, "ambiguous");
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () => service.resolveSbpCheckout(token),
      (error: unknown) => error instanceof Error && "code" in error
        && error.code === "sbp_checkout_uncertain_persistence_failed",
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.createSbpPayment, 1);
  assert.equal(calls.markSbpCheckoutCreationUncertain, 1);
  assert.equal(calls.releaseSbpCheckoutCreation, 0);
});

test("uncertain SBP recovery does not return a checkout from non-payable reloaded row", async () => {
  const token = "uncertain-recovery-canceled";
  let persistedAttempt = false;
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
    async storeInvoiceLinks() {
      calls.storeInvoiceLinks += 1;
      persistedAttempt = true;
      throw new Error("write outcome unknown");
    },
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        token,
        requested_token: token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        checkout_url: persistedAttempt ? "https://sbp.example/checkout/1" : null,
        external_payment_id: persistedAttempt ? "sbp-payment-1" : null,
        status: persistedAttempt ? "canceled" : "invoice_sent",
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      });
    },
  }, {}, {
    async createPayment() {
      calls.createSbpPayment += 1;
      return {
        external_payment_id: "sbp-payment-1",
        checkout_url: "https://sbp.example/checkout/1",
        provider_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  });

  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_checkout_creation_uncertain",
  );
  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_checkout_creation_uncertain",
  );
  assert.equal(calls.createSbpPayment, 1);
});

test("definite SBP failure releases the creation claim", async () => {
  const token = "definite-provider-failure";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        payload_json: buildSbpSubscriptionPayload(),
      })];
    },
  }, {}, {
    async createPayment() {
      calls.createSbpPayment += 1;
      throw new SbpPaymentError("locally rejected", "request", null, "definite_failure");
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => service.resolveSbpCheckout(token));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.releaseSbpCheckoutCreation, 1);
  assert.equal(calls.markSbpCheckoutCreationUncertain, 0);
});

for (const failure of ["zero rows", "db exception"] as const) {
  test(`provider success followed by ${failure} remains fail-closed across concurrent retries`, async () => {
    const token = `persistence-${failure.replace(" ", "-")}`;
    const { service, calls } = createRepository({
      async loadStoredInvoiceTokens() {
        return [buildStoredInvoiceToken({
          token,
          payment_source: "sbp",
          amount: 199,
          currency: "RUB",
          amount_xtr: null,
          telegram_invoice_payload: null,
          action_kind: "subscription_payment",
          payload_json: buildSbpSubscriptionPayload(),
        })];
      },
      async loadInvoiceToken() {
        return buildLoadedInvoiceToken({
          token,
          requested_token: token,
          payment_source: "sbp",
          amount: 199,
          currency: "RUB",
          checkout_url: null,
          external_payment_id: null,
          action_kind: "subscription_payment",
          payload_json: buildSbpSubscriptionPayload(),
        });
      },
      async storeInvoiceLinks() {
        calls.storeInvoiceLinks += 1;
        if (failure === "db exception") throw new Error("database unavailable");
        return 0;
      },
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => service.resolveSbpCheckout(token));
      const retries = await Promise.allSettled([
        service.resolveSbpCheckout(token),
        service.resolveSbpCheckout(token),
      ]);
      assert.deepEqual(retries.map((result) => result.status), ["rejected", "rejected"]);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(calls.createSbpPayment, 1);
    assert.equal(calls.releaseSbpCheckoutCreation, 0);
  });
}

test("CANCELED webhook stores terminal state and canceled checkout cannot be reopened", async () => {
  const externalPaymentId = "sbp-canceled-1";
  const token = "sbp-canceled-token";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        token,
        requested_token: externalPaymentId,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "invoice_sent",
        action_kind: "subscription_payment",
      });
    },
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        checkout_url: "https://sbp.example/canceled",
        status: "canceled",
        action_kind: "subscription_payment",
      })];
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "payment.canceled.received",
    payment_source: "sbp",
    external_payment_id: externalPaymentId,
    payment_currency: "RUB",
    provider_payment_amount: 199,
  }));
  assert.equal(result.reason, "payment_canceled");
  assert.equal(calls.markSbpInvoiceCanceled, 1);
  assert.equal(calls.recordSbpProviderEvent, 1);
  assert.deepEqual(calls.recordSbpProviderEventArgs[0], {
    external_payment_id: externalPaymentId,
    provider_status: "CANCELED",
    provider_amount: 199,
    provider_currency: "RUB",
    provider_payment_method: null,
  });
  await assert.rejects(() => service.resolveSbpCheckout(token));
  assert.equal(calls.createSbpPayment, 0);
});

test("duplicate CANCELED webhook records provider fact and stays already-canceled", async () => {
  const externalPaymentId = "sbp-canceled-duplicate";
  const token = "sbp-canceled-duplicate-token";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        token,
        requested_token: externalPaymentId,
        payment_source: "sbp",
        amount: 199,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "canceled",
        action_kind: "subscription_payment",
      });
    },
  });

  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "payment.canceled.received",
    payment_source: "sbp",
    external_payment_id: externalPaymentId,
    payment_currency: "RUB",
    provider_payment_amount: 199,
  }));

  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "payment_already_canceled");
  assert.equal(result.payment_token, token);
  assert.equal(calls.recordSbpProviderEvent, 1);
  assert.equal(calls.markSbpInvoiceCanceled, 0);
  assert.equal(calls.createSbpPayment, 0);
});

for (const status of ["paid", "fulfilled"] as const) {
  test(`CANCELED webhook after local ${status} records conflict without changing local payment state`, async () => {
    const externalPaymentId = `sbp-canceled-after-${status}`;
    const { service, calls } = createRepository({
      async loadInvoiceTokenByExternalPaymentId() {
        return buildLoadedInvoiceToken({
          token: `sbp-${status}-token`,
          requested_token: externalPaymentId,
          payment_source: "sbp",
          amount: 199,
          amount_xtr: null,
          currency: "RUB",
          external_payment_id: externalPaymentId,
          status,
          action_kind: "subscription_payment",
          payload_json: {
            action_kind: "subscription_payment",
            idempotency_key: `offer-${status}`,
            subscription_days: 7,
            subscription_sku: "payment_plan_7",
          },
        });
      },
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const result = await service.evaluate(buildRequest({
        interaction_mode: null,
        event_type: "payment.canceled.received",
        payment_source: "sbp",
        external_payment_id: externalPaymentId,
        payment_currency: "RUB",
        provider_payment_amount: 199,
      }));

      assert.equal(result.operation, "noop");
      assert.equal(result.reason, "payment_status_conflict");
      assert.equal(result.payment_token, `sbp-${status}-token`);
      assert.equal(result.payment_kind, "subscription");
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(calls.recordSbpProviderEvent, 1);
    assert.deepEqual(calls.recordSbpProviderEventArgs[0], {
      external_payment_id: externalPaymentId,
      provider_status: "CANCELED",
      provider_amount: 199,
      provider_currency: "RUB",
      provider_payment_method: null,
    });
    assert.equal(calls.markSbpInvoiceCanceled, 0);
    assert.equal(calls.recordSbpStatusConflict, 1);
    assert.deepEqual(calls.recordSbpStatusConflictArgs, [
      { externalPaymentId, providerStatus: "CANCELED" },
    ]);
    assert.equal(calls.markInvoicePaid, 0);
    assert.equal(calls.activateSubscription, 0);
    assert.equal(calls.createSbpPayment, 0);
  });
}

test("CANCELED webhook after paid fails closed when status conflict is not persisted", async () => {
  const externalPaymentId = "sbp-canceled-after-paid-conflict-zero";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        token: "sbp-paid-conflict-zero-token",
        requested_token: externalPaymentId,
        payment_source: "sbp",
        amount: 199,
        amount_xtr: null,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "paid",
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "offer-paid-conflict-zero",
          subscription_days: 7,
          subscription_sku: "payment_plan_7",
        },
      });
    },
    async recordSbpStatusConflict() {
      calls.recordSbpStatusConflict += 1;
      return 0;
    },
  });

  await assert.rejects(
    () => service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.canceled.received",
      payment_source: "sbp",
      external_payment_id: externalPaymentId,
      payment_currency: "RUB",
      provider_payment_amount: 199,
    })),
    (error: unknown) => error instanceof MediaCommerceOperationError
      && error.code === "sbp_status_conflict_persistence_failed",
  );

  assert.equal(calls.recordSbpProviderEvent, 1);
  assert.equal(calls.recordSbpStatusConflict, 1);
  assert.equal(calls.markSbpInvoiceCanceled, 0);
  assert.equal(calls.markInvoicePaid, 0);
  assert.equal(calls.activateSubscription, 0);
});

test("SBP successor is created only for provider retryable cancellations and local expiry", async () => {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const cases = [
    {
      name: "sbp_canceled",
      overrides: { status: "canceled", failure_reason: "sbp_canceled" },
      expectRetry: true,
      expectExpiredMark: false,
    },
    {
      name: "sbp_expired",
      overrides: {
        status: "invoice_sent",
        expires_at: expiredAt,
        external_payment_id: null,
        checkout_url: null,
      },
      expectRetry: true,
      expectExpiredMark: true,
    },
    {
      name: "sibling_paid",
      overrides: { status: "canceled", failure_reason: "sibling_paid" },
      expectRetry: false,
      expectExpiredMark: false,
    },
    {
      name: "business_cancel",
      overrides: { status: "canceled", failure_reason: "scene_access_activated" },
      expectRetry: false,
      expectExpiredMark: false,
    },
    {
      name: "paid",
      overrides: { status: "paid" },
      expectRetry: false,
      expectExpiredMark: false,
    },
    {
      name: "fulfilled",
      overrides: { status: "fulfilled" },
      expectRetry: false,
      expectExpiredMark: false,
    },
  ] as const;

  for (const entry of cases) {
    const originalToken = `sbp-${entry.name}`;
    const stored = new Map<string, StoredInvoiceToken>([[
      originalToken,
      buildStoredInvoiceToken({
        token: originalToken,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        scene_session_id: null,
        turn_no: null,
        scene_turn_no: null,
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "offer-retry",
          subscription_days: 7,
          subscription_sku: "payment_plan_2",
        },
        ...entry.overrides,
      }),
    ]]);
    let upsertCount = 0;
    const { service, calls } = createRepository({
      async loadStoredInvoiceTokens(tokens) {
        return tokens.flatMap((token) => {
          const row = stored.get(token);
          return row ? [row] : [];
        });
      },
      async markSbpInvoiceExpired(token) {
        calls.markSbpInvoiceExpired += 1;
        const row = stored.get(token);
        if (!row) return 0;
        stored.set(token, buildStoredInvoiceToken({
          ...row,
          status: "canceled",
          failure_reason: "sbp_expired",
        }));
        return 1;
      },
      async upsertInvoiceTokens(inputs) {
        upsertCount += 1;
        return (inputs as Array<{
          token: string;
          payload_json: Record<string, unknown>;
          action_kind: string;
          sku: string;
          payment_source: "stars" | "sbp";
          amount: number | null;
          currency: "XTR" | "RUB";
          amount_xtr: number | null;
          telegram_invoice_payload: string | null;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        }>).map((input) => {
          const row = buildStoredInvoiceToken({
            ...input,
            scene_session_id: null,
            turn_no: null,
            scene_turn_no: null,
            checkout_url: null,
            external_payment_id: null,
            invoice_link: null,
            status: "invoice_sent",
          });
          stored.set(row.token, row);
          return row;
        });
      },
      async claimSbpCheckoutCreation(token, chatId) {
        const row = token ? stored.get(token) : null;
        return {
          token,
          chat_id: chatId,
          checkout_url: row?.checkout_url ?? null,
          external_payment_id: row?.external_payment_id ?? null,
          claim_acquired: Boolean(row && !row.checkout_url),
        };
      },
      async storeInvoiceLinks(items) {
        for (const item of items as Array<{
          token: string;
          checkout_url?: string | null;
          external_payment_id?: string | null;
          expires_at?: string | null;
        }>) {
          const row = stored.get(item.token);
          if (!row) continue;
          stored.set(item.token, buildStoredInvoiceToken({
            ...row,
            checkout_url: item.checkout_url ?? row.checkout_url,
            external_payment_id: item.external_payment_id ?? row.external_payment_id,
            expires_at: item.expires_at ?? row.expires_at,
          }));
        }
        return 1;
      },
      async loadInvoiceToken(token) {
        const row = token ? stored.get(token) : null;
        return row ? buildLoadedInvoiceToken({ ...row, requested_token: token }) : null;
      },
      async loadActiveSubscriptionOfferId() {
        return "offer-retry";
      },
    });

    if (entry.expectRetry) {
      const checkout = await service.resolveSbpCheckout(originalToken);
      assert.match(checkout, /https:\/\/sbp\.example\/checkout\//u, entry.name);
      assert.equal(upsertCount, 1, entry.name);
      assert.equal(calls.createSbpPayment, 1, entry.name);
      assert.equal(calls.markSbpInvoiceExpired, entry.expectExpiredMark ? 1 : 0, entry.name);
    } else {
      await assert.rejects(() => service.resolveSbpCheckout(originalToken));
      assert.equal(upsertCount, 0, entry.name);
      assert.equal(calls.createSbpPayment, 0, entry.name);
      assert.equal(calls.markSbpInvoiceExpired, 0, entry.name);
    }
  }
});

test("expired SBP checkout with provider transaction reconciles status before successor", async () => {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const cases = [
    { name: "canceled", status: "CANCELED", expectRetry: true },
    { name: "pending", status: "PENDING", expectRetry: false },
    { name: "confirmed", status: "CONFIRMED", expectRetry: false },
    { name: "chargebacked", status: "CHARGEBACKED", expectRetry: false },
    { name: "unknown", status: null, expectRetry: false },
    { name: "ambiguous", status: "throw", expectRetry: false },
  ] as const;

  for (const entry of cases) {
    const originalToken = `sbp-expired-created-${entry.name}`;
    const externalPaymentId = `external-${entry.name}`;
    const stored = new Map<string, StoredInvoiceToken>([[
      originalToken,
      buildStoredInvoiceToken({
        token: originalToken,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        scene_session_id: null,
        turn_no: null,
        scene_turn_no: null,
        checkout_url: `https://sbp.example/old/${entry.name}`,
        external_payment_id: externalPaymentId,
        expires_at: expiredAt,
        payload_json: {
          action_kind: "subscription_payment",
          idempotency_key: "offer-expired-provider",
          subscription_days: 7,
          subscription_sku: "payment_plan_2",
        },
      }),
    ]]);
    const { service, calls } = createRepository({
      async loadStoredInvoiceTokens(tokens) {
        return tokens.flatMap((token) => {
          const row = stored.get(token);
          return row ? [row] : [];
        });
      },
      async markSbpInvoiceCanceled(requestedExternalPaymentId) {
        calls.markSbpInvoiceCanceled += 1;
        const row = [...stored.values()].find(
          (candidate) => candidate.external_payment_id === requestedExternalPaymentId,
        );
        if (!row) return 0;
        stored.set(row.token, buildStoredInvoiceToken({
          ...row,
          status: "canceled",
          failure_reason: "sbp_canceled",
        }));
        return 1;
      },
      async upsertInvoiceTokens(inputs) {
        return (inputs as Array<{
          token: string;
          payload_json: Record<string, unknown>;
          action_kind: string;
          sku: string;
          payment_source: "stars" | "sbp";
          amount: number | null;
          currency: "XTR" | "RUB";
          amount_xtr: number | null;
          telegram_invoice_payload: string | null;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        }>).map((input) => {
          const row = buildStoredInvoiceToken({
            ...input,
            scene_session_id: null,
            turn_no: null,
            scene_turn_no: null,
            checkout_url: null,
            external_payment_id: null,
            invoice_link: null,
            status: "invoice_sent",
          });
          stored.set(row.token, row);
          return row;
        });
      },
      async claimSbpCheckoutCreation(token, chatId) {
        const row = token ? stored.get(token) : null;
        return {
          token,
          chat_id: chatId,
          checkout_url: row?.checkout_url ?? null,
          external_payment_id: row?.external_payment_id ?? null,
          claim_acquired: Boolean(row && !row.checkout_url),
        };
      },
      async storeInvoiceLinks(items) {
        for (const item of items as Array<{
          token: string;
          checkout_url?: string | null;
          external_payment_id?: string | null;
          expires_at?: string | null;
        }>) {
          const row = stored.get(item.token);
          if (!row) continue;
          stored.set(item.token, buildStoredInvoiceToken({
            ...row,
            checkout_url: item.checkout_url ?? row.checkout_url,
            external_payment_id: item.external_payment_id ?? row.external_payment_id,
            expires_at: item.expires_at ?? row.expires_at,
          }));
        }
        return 1;
      },
      async loadInvoiceToken(token) {
        const row = token ? stored.get(token) : null;
        return row ? buildLoadedInvoiceToken({ ...row, requested_token: token }) : null;
      },
      async loadActiveSubscriptionOfferId() {
        return "offer-expired-provider";
      },
    }, {}, {
      async getTransactionStatus() {
        if (entry.status === "throw") {
          throw new SbpPaymentError("provider unavailable", "request", null, "ambiguous");
        }
        return entry.status;
      },
    });

    if (entry.expectRetry) {
      const checkout = await service.resolveSbpCheckout(originalToken);
      assert.match(checkout, /https:\/\/sbp\.example\/checkout\//u, entry.name);
      assert.equal(calls.markSbpInvoiceCanceled, 1, entry.name);
      assert.equal(calls.createSbpPayment, 1, entry.name);
    } else {
      await assert.rejects(() => service.resolveSbpCheckout(originalToken));
      assert.equal(calls.createSbpPayment, 0, entry.name);
    }
  }
});

test("corrupt SBP successor chain fails closed", async () => {
  const token = "sbp-corrupt-root";
  const root = buildStoredInvoiceToken({
    token,
    payment_source: "sbp",
    amount: 199,
    currency: "RUB",
    amount_xtr: null,
    telegram_invoice_payload: null,
    action_kind: "subscription_payment",
    sku: "payment_plan_2",
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    status: "canceled",
    failure_reason: "sbp_canceled",
    payload_json: {
      action_kind: "subscription_payment",
      idempotency_key: "offer-corrupt",
      subscription_days: 7,
      subscription_sku: "payment_plan_2",
    },
  });
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens(tokens) {
      return tokens.map(() => root);
    },
    async loadActiveSubscriptionOfferId() {
      return "offer-corrupt";
    },
  });

  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_retry_chain_corrupt",
  );
  assert.equal(calls.createSbpPayment, 0);
});

test("SBP state-change zero rows reload predecessor and follows persisted successor", async () => {
  const token = "sbp-expire-race-root";
  let predecessorReloaded = false;
  const successorRow = (requestedToken: string) => buildStoredInvoiceToken({
    token: requestedToken,
    payment_source: "sbp",
    amount: 199,
    currency: "RUB",
    amount_xtr: null,
    telegram_invoice_payload: null,
    action_kind: "subscription_payment",
    sku: "payment_plan_2",
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    checkout_url: "https://sbp.example/existing-successor",
    external_payment_id: "existing-successor-payment",
    payload_json: buildSbpSubscriptionPayload("offer-reload"),
  });
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens(tokens) {
      return tokens.flatMap((requestedToken) => {
        if (requestedToken === token) {
          return [buildStoredInvoiceToken({
            token,
            payment_source: "sbp",
            amount: 199,
            currency: "RUB",
            amount_xtr: null,
            telegram_invoice_payload: null,
            action_kind: "subscription_payment",
            sku: "payment_plan_2",
            scene_session_id: null,
            turn_no: null,
            scene_turn_no: null,
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            status: predecessorReloaded ? "canceled" : "invoice_sent",
            failure_reason: predecessorReloaded ? "sbp_expired" : null,
            payload_json: buildSbpSubscriptionPayload("offer-reload"),
          })];
        }
        return requestedToken.startsWith("pay_retry_")
          ? [successorRow(requestedToken)]
          : [];
      });
    },
    async markSbpInvoiceExpired() {
      calls.markSbpInvoiceExpired += 1;
      predecessorReloaded = true;
      return 0;
    },
    async loadActiveSubscriptionOfferId() {
      return "offer-reload";
    },
  });

  const checkoutUrl = await service.resolveSbpCheckout(token);

  assert.equal(checkoutUrl, "https://sbp.example/existing-successor");
  assert.equal(calls.markSbpInvoiceExpired, 1);
  assert.equal(calls.createSbpPayment, 0);
});

test("stale initial SBP context does not create a provider transaction", async () => {
  const token = "sbp-stale-context";
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [buildStoredInvoiceToken({
        token,
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        amount_xtr: null,
        telegram_invoice_payload: null,
        action_kind: "subscription_payment",
        sku: "payment_plan_2",
        scene_session_id: null,
        turn_no: null,
        scene_turn_no: null,
        payload_json: buildSbpSubscriptionPayload("old-offer"),
      })];
    },
    async claimSbpCheckoutCreation(requestedToken, chatId) {
      return {
        token: requestedToken,
        chat_id: chatId,
        checkout_url: null,
        external_payment_id: null,
        claim_acquired: true,
      };
    },
    async loadActiveSubscriptionOfferId() {
      return "new-offer";
    },
  });

  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_successor_context_stale",
  );
  assert.equal(calls.createSbpPayment, 0);
  assert.equal(calls.releaseSbpCheckoutCreation, 1);
});

test("SBP checkout is not returned when row becomes sibling-paid after provider create", async () => {
  const token = "sbp-post-create-sibling-paid";
  let stored = buildStoredInvoiceToken({
    token,
    payment_source: "sbp",
    amount: 199,
    currency: "RUB",
    amount_xtr: null,
    telegram_invoice_payload: null,
    action_kind: "subscription_payment",
    sku: "payment_plan_2",
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    payload_json: buildSbpSubscriptionPayload(),
  });
  const { service, calls } = createRepository({
    async loadStoredInvoiceTokens() {
      return [stored];
    },
    async claimSbpCheckoutCreation(requestedToken, chatId) {
      return {
        token: requestedToken,
        chat_id: chatId,
        checkout_url: stored.checkout_url ?? null,
        external_payment_id: stored.external_payment_id ?? null,
        claim_acquired: stored.checkout_url == null,
      };
    },
    async storeInvoiceLinks(items) {
      calls.storeInvoiceLinks += 1;
      const [item] = items as Array<{
        checkout_url?: string | null;
        external_payment_id?: string | null;
        expires_at?: string | null;
      }>;
      stored = buildStoredInvoiceToken({
        ...stored,
        checkout_url: item?.checkout_url ?? stored.checkout_url,
        external_payment_id: item?.external_payment_id ?? stored.external_payment_id,
        expires_at: item?.expires_at ?? stored.expires_at,
        status: "canceled",
        failure_reason: "sibling_paid",
      });
      return 1;
    },
    async loadInvoiceToken() {
      return buildLoadedInvoiceToken({
        ...stored,
        requested_token: token,
      });
    },
  });

  await assert.rejects(
    () => service.resolveSbpCheckout(token),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_invoice_status_invalid",
  );
  await assert.rejects(() => service.resolveSbpCheckout(token));
  assert.equal(calls.createSbpPayment, 1);
  assert.equal(calls.storeInvoiceLinks, 1);
});

test("canceled subscription attempt rolls over to a new SBP token and transaction", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousPlans = config.MEDIA_SUBSCRIPTION_PLANS_JSON;
  config.SBP_ENABLED = true;
  config.MEDIA_SUBSCRIPTION_PLANS_JSON = [{
    sku: "payment_plan_retry",
    days: 7,
    amount_xtr: 100,
    amount_rub: 199,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  }];

  const stored = new Map<string, StoredInvoiceToken>();
  const claims = new Set<string>();
  try {
    const { service, calls } = createRepository({
      async upsertInvoiceTokens(inputs) {
        const source = inputs as Array<{
          token: string;
          kind: string;
          chat_id: number;
          scene_session_id: string | null;
          turn_no: number | null;
          scene_turn_no: number | null;
          payload_json: Record<string, unknown>;
          action_kind: string;
          sku: string;
          payment_source: "stars" | "sbp";
          amount: number | null;
          currency: "XTR" | "RUB";
          amount_xtr: number | null;
          telegram_invoice_payload: string | null;
          expires_at: string | null;
          invoice_title: string;
          invoice_description: string;
          invoice_label: string;
          invoice_button_text: string;
        }>;
        return source.map((input) => {
          const existing = stored.get(input.token);
          if (existing) return existing;
          const row = buildStoredInvoiceToken({
            ...input,
            checkout_url: null,
            external_payment_id: null,
            invoice_link: null,
            status: "invoice_sent",
            stored: true,
          });
          stored.set(row.token, row);
          return row;
        });
      },
      async loadStoredInvoiceTokens(tokens) {
        return tokens.flatMap((token) => {
          const row = stored.get(token);
          return row ? [row] : [];
        });
      },
      async claimSbpCheckoutCreation(token, chatId) {
        const row = token ? stored.get(token) : null;
        const acquired = Boolean(row && !row.checkout_url && !claims.has(row.token));
        if (row && acquired) claims.add(row.token);
        return {
          token,
          chat_id: chatId,
          checkout_url: row?.checkout_url ?? null,
          external_payment_id: row?.external_payment_id ?? null,
          claim_acquired: acquired,
        };
      },
      async storeInvoiceLinks(items) {
        const source = items as Array<{
          token: string;
          checkout_url?: string | null;
          external_payment_id?: string | null;
          invoice_link?: string | null;
        }>;
        for (const item of source) {
          const row = stored.get(item.token);
          if (!row) continue;
          stored.set(item.token, buildStoredInvoiceToken({
            ...row,
            checkout_url: item.checkout_url ?? item.invoice_link ?? row.checkout_url,
            invoice_link: row.payment_source === "stars"
              ? item.invoice_link ?? item.checkout_url ?? row.invoice_link
              : row.invoice_link,
            external_payment_id: item.external_payment_id ?? row.external_payment_id,
          }));
        }
        return source.filter((item) => stored.has(item.token)).length;
      },
      async loadInvoiceToken(token) {
        const row = token ? stored.get(token) : null;
        return row ? buildLoadedInvoiceToken({ ...row, requested_token: token }) : null;
      },
      async loadInvoiceTokenByExternalPaymentId(externalPaymentId) {
        const row = [...stored.values()].find(
          (candidate) => candidate.external_payment_id === externalPaymentId,
        );
        return row
          ? buildLoadedInvoiceToken({ ...row, requested_token: externalPaymentId })
          : null;
      },
      async markSbpInvoiceCanceled(externalPaymentId) {
        const row = [...stored.values()].find(
          (candidate) => candidate.external_payment_id === externalPaymentId,
        );
        if (!row) return 0;
        stored.set(row.token, buildStoredInvoiceToken({
          ...row,
          status: "canceled",
          failure_reason: "sbp_canceled",
        }));
        return 1;
      },
      async loadActiveSubscriptionOfferId() {
        return "same-user-purchase";
      },
    });

    const request = buildRequest({
      interaction_mode: "subscription_offer",
      idempotency_key: "same-user-purchase",
      subscription_offer_reason: "subscription_command",
    });
    const offerA = await service.evaluate(request);
    const tokenA = firstOfferPaymentOption(offerA.subscription_offer_items?.[0], "sbp")?.token;
    assert.ok(tokenA);
    await service.resolveSbpCheckout(tokenA);
    const externalA = stored.get(tokenA)?.external_payment_id;
    assert.ok(externalA);

    const canceled = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.canceled.received",
      payment_source: "sbp",
      external_payment_id: externalA,
      payment_currency: "RUB",
      provider_payment_amount: 199,
    }));
    assert.equal(canceled.reason, "payment_canceled");

    const offerB = await service.evaluate(request);
    const tokenB = firstOfferPaymentOption(offerB.subscription_offer_items?.[0], "sbp")?.token;
    assert.ok(tokenB);
    assert.notEqual(tokenB, tokenA);
    assert.equal(stored.get(tokenA)?.status, "canceled");

    const checkoutB = await service.resolveSbpCheckout(tokenB);
    const repeatedCheckoutB = await service.resolveSbpCheckout(tokenB);
    const repeatedOldCheckout = await service.resolveSbpCheckout(tokenA);
    assert.equal(checkoutB, repeatedCheckoutB);
    assert.equal(checkoutB, repeatedOldCheckout);
    assert.notEqual(stored.get(tokenB)?.external_payment_id, externalA);
    assert.equal(calls.createSbpPayment, 2);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_SUBSCRIPTION_PLANS_JSON = previousPlans;
  }
});

test("CONFIRMED after local cancellation records an explicit status conflict", async () => {
  const externalPaymentId = "sbp-conflict-1";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "canceled",
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 7,
          subscription_sku: "payment_plan_7",
        },
      });
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: externalPaymentId,
      payment_currency: "RUB",
      provider_payment_amount: 199,
    }));
    assert.equal(result.reason, "payment_status_conflict");
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.recordSbpStatusConflict, 1);
  assert.equal(calls.markInvoicePaid, 0);
});

test("CONFIRMED after cancellation fails closed when status conflict is not persisted", async () => {
  const externalPaymentId = "sbp-conflict-not-persisted";
  const { service } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "canceled",
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 7,
          subscription_sku: "payment_plan_7",
        },
      });
    },
    async recordSbpStatusConflict() {
      return 0;
    },
  });

  await assert.rejects(
    () => service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: externalPaymentId,
      payment_currency: "RUB",
      provider_payment_amount: 199,
    })),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_status_conflict_persistence_failed",
  );
});

test("CHARGEBACKED webhook records provider fact without changing fulfilled invoice state", async () => {
  const externalPaymentId = "sbp-chargebacked-1";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "fulfilled",
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 7,
          subscription_sku: "payment_plan_7",
        },
      });
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.chargebacked.received",
      payment_source: "sbp",
      external_payment_id: externalPaymentId,
      payment_currency: "RUB",
      provider_payment_amount: 199.75,
      provider_payment_method: 7,
    }));

    assert.equal(result.operation, "noop");
    assert.equal(result.reason, "payment_chargeback_recorded");
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.recordSbpProviderEvent, 1);
  assert.deepEqual(calls.recordSbpProviderEventArgs[0], {
    external_payment_id: externalPaymentId,
    provider_status: "CHARGEBACKED",
    provider_amount: 199.75,
    provider_currency: "RUB",
    provider_payment_method: 7,
  });
  assert.equal(calls.markInvoicePaid, 0);
  assert.equal(calls.activateSubscription, 0);
  assert.equal(calls.markSbpInvoiceCanceled, 0);
});

test("duplicate CHARGEBACKED webhook is acknowledged idempotently after recording provider fact", async () => {
  const externalPaymentId = "sbp-chargebacked-duplicate";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 80,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "fulfilled",
        action_kind: "feature_payment",
        payload_json: {
          action_kind: "feature_payment",
          feature_key: "fast_scene_skip",
        },
      });
    },
  });
  const request = buildRequest({
    interaction_mode: null,
    event_type: "payment.chargebacked.received",
    payment_source: "sbp",
    external_payment_id: externalPaymentId,
    payment_currency: "RUB",
    provider_payment_amount: 80,
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const first = await service.evaluate(request);
    const second = await service.evaluate(request);
    assert.equal(first.reason, "payment_chargeback_recorded");
    assert.equal(second.reason, "payment_chargeback_recorded");
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.recordSbpProviderEvent, 2);
  assert.equal(calls.markInvoicePaid, 0);
  assert.equal(calls.activateSubscription, 0);
});

test("SBP webhook fails closed when provider fact is not persisted", async () => {
  const externalPaymentId = "sbp-provider-fact-not-persisted";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 199,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        status: "invoice_sent",
        action_kind: "subscription_payment",
        payload_json: {
          action_kind: "subscription_payment",
          subscription_days: 7,
          subscription_sku: "payment_plan_7",
        },
      });
    },
    async recordSbpProviderEvent(input) {
      calls.recordSbpProviderEvent += 1;
      calls.recordSbpProviderEventArgs.push(input);
      return 0;
    },
  });

  await assert.rejects(
    () => service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "payment.confirmed.received",
      payment_source: "sbp",
      external_payment_id: externalPaymentId,
      payment_currency: "RUB",
      provider_payment_amount: 199,
    })),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "sbp_provider_event_persistence_failed",
  );
  assert.equal(calls.markInvoicePaid, 0);
});

test("late CONFIRMED is not rejected solely because the offer expired", async () => {
  const externalPaymentId = "sbp-late-confirmed";
  const { service, calls } = createRepository({
    async loadInvoiceTokenByExternalPaymentId() {
      return buildLoadedInvoiceToken({
        payment_source: "sbp",
        amount: 80,
        currency: "RUB",
        external_payment_id: externalPaymentId,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        action_kind: "feature_payment",
        payload_json: { action_kind: "feature_payment", feature_key: "fast_scene_skip" },
      });
    },
    async markInvoicePaid() {
      calls.markInvoicePaid += 1;
      return buildPaidInvoiceToken({
        payment_source: "sbp",
        currency: "RUB",
        amount: 80,
        external_payment_id: externalPaymentId,
        action_kind: "feature_payment",
        payload_json: { action_kind: "feature_payment", feature_key: "fast_scene_skip" },
      });
    },
  });
  const result = await service.evaluate(buildRequest({
    interaction_mode: null,
    event_type: "payment.confirmed.received",
    payment_source: "sbp",
    external_payment_id: externalPaymentId,
    payment_currency: "RUB",
    provider_payment_amount: 82,
  }));
  assert.equal(result.operation, "feature_fulfillment_required");
  assert.equal(calls.markInvoicePaid, 1);
});

test("missing photo_sku fails closed before Telegram invoice creation", async () => {
  const payload = {
    action_kind: "free_photo_unlock",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 3,
    media_signature: "hotel_corridor_close",
    target_message_id: 777,
    current_uuid: "u1",
    base_price_xtr: 999,
    requested_action: "photo_regen",
    free_photo_uuid: "u2",
  };
  const { service, calls } = createRepository({
    async loadCallbackToken() {
      return buildLoadedCallbackToken({
        token: "missing-sku-photo-entry",
        action_kind: "free_photo_unlock",
        payload_json: payload,
      });
    },
    async redeemFreePhotoUnlock(token, chatId) {
      calls.redeemFreePhotoUnlock += 1;
      return {
        token,
        chat_id: chatId,
        scene_session_id: "scene-1",
        turn_no: 5,
        payload_json: payload,
        action_kind: "free_photo_unlock",
        status: "active",
        redeemed: false,
        already_consumed: false,
        already_fulfilled: false,
        remaining_credits: 0,
        reason: "free_credit_unavailable",
      };
    },
  });
  await assert.rejects(
    () => service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "missing-sku-photo-entry",
      inbound_message_id: 777,
    })),
    (error: unknown) => error instanceof Error && "code" in error
      && error.code === "unknown_photo_sku",
  );
  assert.equal(calls.createStarsInvoice, 0);
  assert.equal(calls.createSbpPayment, 0);
});

test("scene unlock reveal returns a lazy SBP URL without creating a provider transaction", async () => {
  const previousEnabled = config.SBP_ENABLED;
  const previousPlans = config.MEDIA_ACTION_PLANS_JSON;
  config.SBP_ENABLED = true;
  config.MEDIA_ACTION_PLANS_JSON = [{
    sku: "payment_action_2",
    feature_key: "scene_unlock",
    amount_xtr: 80,
    amount_rub: 120,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  }];
  try {
    const payload = {
      action_kind: "free_scene_unlock",
      chat_id: 101,
      scene_session_id: "scene-1",
      target_message_id: 777,
      feature_key: "scene_unlock",
    };
    const { service, calls } = createRepository({
      async loadCallbackToken() {
        return buildLoadedCallbackToken({
          token: "scene-lazy-token",
          action_kind: "free_scene_unlock",
          payload_json: payload,
        });
      },
      async redeemFreeSceneUnlock(token, chatId) {
        return {
          token,
          chat_id: chatId,
          scene_session_id: "scene-1",
          turn_no: 5,
          payload_json: payload,
          action_kind: "free_scene_unlock",
          status: "active",
          redeemed: false,
          already_consumed: false,
          already_fulfilled: false,
          remaining_credits: 0,
          reason: "free_credit_unavailable",
        };
      },
    });
    const result = await service.evaluate(buildRequest({
      interaction_mode: null,
      event_type: "callback_query.received",
      callback_data: "scene-lazy-token",
    }));
    assert.equal(result.payment_options?.length, 2);
    assert.match(findPaymentOption(result.payment_options, "sbp")?.checkout_url ?? "", /\/v1\/pay\/sbp\//u);
    assert.equal(calls.createSbpPayment, 0);
  } finally {
    config.SBP_ENABLED = previousEnabled;
    config.MEDIA_ACTION_PLANS_JSON = previousPlans;
  }
});

for (const flow of ["feature", "scene_unlock"] as const) {
  test(`${flow} payment rolls a canceled SBP attempt to fresh lazy payment tokens`, async () => {
    const previousEnabled = config.SBP_ENABLED;
    const previousPlans = config.MEDIA_ACTION_PLANS_JSON;
    config.SBP_ENABLED = true;
    config.MEDIA_ACTION_PLANS_JSON = [{
      sku: flow === "feature" ? "payment_action_retry_feature" : "payment_action_retry_scene",
      feature_key: flow === "feature" ? "fast_scene_skip" : "scene_unlock",
      amount_xtr: flow === "feature" ? 50 : 80,
      amount_rub: flow === "feature" ? 80 : 120,
      title: "text",
      description: "text",
      label: "text",
      button_text: "text",
    }];

    const payload = {
      action_kind: "free_scene_unlock",
      chat_id: 101,
      scene_session_id: "scene-1",
      target_message_id: 777,
      feature_key: "scene_unlock",
    };
    const canceledRollovers = 10;
    let upsertCount = 0;
    const storedRows = new Map<string, StoredInvoiceToken>();
    try {
      const { service, calls } = createRepository({
        async loadCallbackToken() {
          return buildLoadedCallbackToken({
            token: "scene-retry-entry",
            action_kind: "free_scene_unlock",
            payload_json: payload,
          });
        },
        async redeemFreeSceneUnlock(token, chatId) {
          return {
            token,
            chat_id: chatId,
            scene_session_id: "scene-1",
            turn_no: 5,
            payload_json: payload,
            action_kind: "free_scene_unlock",
            status: "active",
            redeemed: false,
            already_consumed: false,
            already_fulfilled: false,
            remaining_credits: 0,
            reason: "free_credit_unavailable",
          };
        },
        async upsertInvoiceTokens(inputs) {
          upsertCount += 1;
          return (inputs as Array<{
            token: string;
            payload_json: Record<string, unknown>;
            action_kind: string;
            sku: string;
            payment_source: "stars" | "sbp";
            amount: number | null;
            amount_xtr: number | null;
            currency: "XTR" | "RUB";
            telegram_invoice_payload: string | null;
            expires_at: string | null;
            invoice_title: string;
            invoice_description: string;
            invoice_label: string;
            invoice_button_text: string;
          }>).map((input) => {
            const stored = buildStoredInvoiceToken({
              ...input,
              scene_session_id: "scene-1",
              status: input.payment_source === "sbp" && upsertCount <= canceledRollovers
                ? "canceled"
                : "invoice_sent",
              failure_reason: input.payment_source === "sbp" && upsertCount <= canceledRollovers
                ? "sbp_canceled"
                : null,
              external_payment_id:
                input.payment_source === "sbp" && upsertCount <= canceledRollovers
                  ? `canceled-${flow}-${upsertCount}`
                  : null,
              checkout_url: null,
              invoice_link: null,
            });
            storedRows.set(stored.token, stored);
            return stored;
          });
        },
        async loadStoredInvoiceTokens(tokens) {
          return tokens.flatMap((token) => {
            const row = storedRows.get(token);
            return row ? [row] : [];
          });
        },
      });

      const result = flow === "feature"
        ? await service.evaluate(buildRequest({
          interaction_mode: "feature_offer",
          feature_key: "fast_scene_skip",
        }))
        : await service.evaluate(buildRequest({
          interaction_mode: null,
          event_type: "callback_query.received",
          callback_data: "scene-retry-entry",
        }));
      const options = result.payment_options ?? [];
      assert.equal(options.length, 2);
      const starsOption = findPaymentOption(options, "stars");
      const sbpOption = findPaymentOption(options, "sbp");
      assert.ok(starsOption);
      assert.ok(sbpOption?.token.startsWith("pay_retry_"));
      assert.match(sbpOption?.checkout_url ?? "", /\/v1\/pay\/sbp\//u);
      assert.equal(calls.createSbpPayment, 0);
      assert.equal(upsertCount, 2);
    } finally {
      config.SBP_ENABLED = previousEnabled;
      config.MEDIA_ACTION_PLANS_JSON = previousPlans;
    }
  });
}

test("missing mandatory free-action copy cannot downgrade a free entitlement to paid", async () => {
  const uxCopy = config.TELEGRAM_UX_COPY_JSON;
  const previous = uxCopy.free_actions;
  Reflect.set(uxCopy, "free_actions", undefined);
  try {
    const { service, calls } = createRepository({
      async loadFreeCredits(chatId) {
        calls.loadFreeCredits += 1;
        return {
          chat_id: chatId,
          active_scene_session_id: "scene-1",
          free_fast_scene_skips: 1,
          free_scene_unlocks: 0,
        };
      },
    });
    await assert.rejects(() => service.evaluate(buildRequest({
      interaction_mode: "feature_offer",
      feature_key: "fast_scene_skip",
    })));
    assert.equal(calls.createStarsInvoice, 0);
    assert.equal(calls.createSbpPayment, 0);
  } finally {
    Reflect.set(uxCopy, "free_actions", previous);
  }
});
