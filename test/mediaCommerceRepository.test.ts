import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.MEDIA_STORAGE_BASE_URL = "https://media.example.com";
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_1",
    days: 14,
    amount_xtr: 100,
    title: "Payment plan 1",
    description: "Access plan option 1 for chat and media actions.",
    label: "Payment plan 1",
    button_text: "Payment plan 1",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 10,
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
    amount_xtr: 50,
    title: "Payment action 1",
    description: "Feature payment option 1.",
    label: "Payment action 1",
    button_text: "Payment action 1",
  },
]);

const { MediaCommerceRepository } = await import(
  "../src/mediaCommerceRepository.js"
);

type TaggedCall = {
  sql: string;
  values: unknown[];
};

type JsonParameter = {
  value: unknown;
  type: number;
};

function createTaggedQueryStub(responses: unknown[][] = []) {
  const calls: TaggedCall[] = [];
  const query = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    calls.push({ sql, values });
    return Promise.resolve((responses.shift() ?? []) as []);
  };

  return {
    calls,
    query,
  };
}

function assertJsonbParameter(value: unknown, expectedValue: unknown) {
  assert.equal(typeof value, "object");
  assert.ok(value != null);
  assert.equal((value as JsonParameter).type, 3802);
  assert.notEqual(typeof (value as JsonParameter).value, "string");
  assert.deepEqual((value as JsonParameter).value, expectedValue);
}

test("loadOfferStats delegates to media_load_offer_stats and preserves empty-catalog result", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      scene_session_id: "scene-yufi",
      turn_no: 5,
      scene_turn_no: 2,
      media_signature: "villa_hall_close",
      base_price_xtr: 10,
      should_offer: true,
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 0,
      unseen_available: 0,
      existing_panel_message_id: null,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadOfferStats({
    chat_id: 101,
    scene_session_id: "scene-yufi",
    turn_no: 5,
    media_signature: "villa_hall_close",
    scene_turn_no: 2,
    base_price_xtr: 10,
    should_offer: true,
  });

  assert.ok(result);
  assert.equal(result.total_available, 0);
  assert.equal(result.unseen_available, 0);
  assert.equal(result.subscription_active, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_offer_stats\(/u);
});

test("loadMediaContext delegates to media_load_media_context and preserves empty-catalog result", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      scene_session_id: "scene-yufi",
      turn_no: 5,
      scene_turn_no: 2,
      media_signature: "villa_hall_close",
      current_uuid: null,
      target_message_id: 777,
      base_price_xtr: 10,
      action_kind: "photo_request",
      requested_action: "photo_request",
      invoice_token: null,
      force_deliver_after_payment: false,
      paid_access_mode: null,
      callback_valid: true,
      panel_text: "panel",
      panel_entities_json: [],
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 0,
      unseen_available: 0,
      unlocked_items_json: [],
      next_unseen_json: null,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadMediaContext({
    chat_id: 101,
    scene_session_id: "scene-yufi",
    turn_no: 5,
    scene_turn_no: 2,
    media_signature: "villa_hall_close",
    current_uuid: null,
    target_message_id: 777,
    base_price_xtr: 10,
    action_kind: "photo_request",
    requested_action: "photo_request",
    invoice_token: null,
    force_deliver_after_payment: false,
    paid_access_mode: null,
    callback_valid: true,
    panel_text: "panel",
    panel_entities_json: [],
  });

  assert.ok(result);
  assert.equal(result.total_available, 0);
  assert.equal(result.unseen_available, 0);
  assert.deepEqual(result.unlocked_items_json, []);
  assert.equal(result.next_unseen_json, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_media_context\(/u);
});

test("loadOfferStats delegates to media_load_offer_stats with populated catalog result", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      scene_session_id: "scene-vivian",
      turn_no: 5,
      scene_turn_no: 2,
      media_signature: "hotel_room_close",
      base_price_xtr: 10,
      should_offer: true,
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 3,
      unseen_available: 3,
      existing_panel_message_id: null,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadOfferStats({
    chat_id: 101,
    scene_session_id: "scene-vivian",
    turn_no: 5,
    media_signature: "hotel_room_close",
    scene_turn_no: 2,
    base_price_xtr: 10,
    should_offer: true,
  });

  assert.ok(result);
  assert.equal(result.total_available, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_offer_stats\(/u);
});

test("loadMediaContext delegates to media_load_media_context and hydrates media URLs", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      scene_session_id: "scene-vivian",
      turn_no: 5,
      scene_turn_no: 2,
      media_signature: "hotel_room_close",
      current_uuid: null,
      target_message_id: 777,
      base_price_xtr: 10,
      action_kind: "photo_request",
      requested_action: "photo_request",
      invoice_token: null,
      force_deliver_after_payment: false,
      paid_access_mode: null,
      callback_valid: true,
      panel_text: "panel",
      panel_entities_json: [],
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 3,
      unseen_available: 2,
      unlocked_items_json: [],
      next_unseen_json: {
        uuid: "u-2",
        bucket_name: "media_bucket",
        storage_path: "char-1/u-2.jpg",
        sort_order: 2,
      },
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadMediaContext({
    chat_id: 101,
    scene_session_id: "scene-vivian",
    turn_no: 5,
    scene_turn_no: 2,
    media_signature: "hotel_room_close",
    current_uuid: null,
    target_message_id: 777,
    base_price_xtr: 10,
    action_kind: "photo_request",
    requested_action: "photo_request",
    invoice_token: null,
    force_deliver_after_payment: false,
    paid_access_mode: null,
    callback_valid: true,
    panel_text: "panel",
    panel_entities_json: [],
  });

  assert.ok(result);
  assert.equal(result.total_available, 3);
  const nextUnseen = result.next_unseen_json as { photo_url?: string } | null;
  assert.equal(
    nextUnseen?.photo_url,
    "https://media.example.com/storage/v1/object/public/media_bucket/char-1/u-2.jpg",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_media_context\(/u);
});

test("loadCallbackToken delegates to media_load_interaction_token with fixed shape", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      requested_token: "cb-1",
      token: "cb-1",
      kind: "button_callback",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { current_uuid: "u-1" },
      status: "active",
      action_kind: "photo_request",
      expires_at: "2026-08-14T10:00:00.000Z",
      sku: null,
      amount_xtr: null,
      telegram_invoice_message_id: null,
      found: true,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadCallbackToken("cb-1", 101);

  assert.equal(result?.token, "cb-1");
  assert.equal(result?.expires_at, "2026-08-14T10:00:00.000Z");
  assert.equal(result?.found, true);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_interaction_token\(/u);
});

test("loadInvoiceToken delegates to media_load_interaction_token and preserves invoice fields", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      requested_token: "inv-1",
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { invoice_link: "https://example.com/invoice" },
      status: "invoice_sent",
      action_kind: "photo_payment",
      expires_at: "2026-08-14T10:00:00.000Z",
      sku: "payment_media_1",
      amount_xtr: 10,
      telegram_invoice_message_id: 777,
      found: true,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadInvoiceToken("inv-1", 101);

  assert.equal(result?.token, "inv-1");
  assert.equal(result?.sku, "payment_media_1");
  assert.equal(result?.amount_xtr, 10);
  assert.equal(result?.telegram_invoice_message_id, 777);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_interaction_token\(/u);
});

test("upsertCallbackTokens delegates to media_upsert_callback_tokens", async () => {
  const { query, calls } = createTaggedQueryStub([[{ inserted_count: 2 }]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.upsertCallbackTokens([
    {
      token: "cb-1",
      kind: "button_callback",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { current_uuid: "u-1" },
      status: "active",
      action_kind: "photo_request",
      expires_at: "2026-08-14T10:00:00.000Z",
    },
    {
      token: "cb-2",
      kind: "button_callback",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { current_uuid: "u-2" },
      status: "active",
      action_kind: "photo_request",
      expires_at: "2026-08-14T10:05:00.000Z",
    },
  ]);

  assert.equal(result, 2);
  assert.match(calls[0]?.sql ?? "", /public\.media_upsert_callback_tokens/u);
  assertJsonbParameter(calls[0]?.values[0], [
    {
      token: "cb-1",
      kind: "button_callback",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { current_uuid: "u-1" },
      status: "active",
      action_kind: "photo_request",
      expires_at: "2026-08-14T10:00:00.000Z",
    },
    {
      token: "cb-2",
      kind: "button_callback",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: { current_uuid: "u-2" },
      status: "active",
      action_kind: "photo_request",
      expires_at: "2026-08-14T10:05:00.000Z",
    },
  ]);
});

test("storeInvoiceLinks delegates to media_store_invoice_links", async () => {
  const { query, calls } = createTaggedQueryStub([[{ updated_count: 2 }]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.storeInvoiceLinks([
    { token: "inv-1", chat_id: 101, invoice_link: "https://example.com/1" },
    { token: "inv-2", chat_id: 101, invoice_link: "https://example.com/2" },
  ]);

  assert.equal(result, 2);
  assert.match(calls[0]?.sql ?? "", /public\.media_store_invoice_links/u);
  assertJsonbParameter(calls[0]?.values[0], [
    { token: "inv-1", chat_id: 101, invoice_link: "https://example.com/1" },
    { token: "inv-2", chat_id: 101, invoice_link: "https://example.com/2" },
  ]);
});

test("loadStoredInvoiceTokens delegates to media_load_stored_invoice_tokens", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: null,
      payload_json: { invoice_link: "https://example.com/invoice" },
      sku: "payment_media_1",
      amount_xtr: 10,
      telegram_invoice_payload: "inv-payload",
      expires_at: "2026-08-14T10:00:00.000Z",
      telegram_invoice_message_id: 777,
      invoice_link: "https://example.com/invoice",
      stored: false,
      invoice_title: "",
      invoice_description: "",
      invoice_label: "",
      invoice_button_text: "",
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.loadStoredInvoiceTokens(["inv-1"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.invoice_link, "https://example.com/invoice");
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_load_stored_invoice_tokens\(/u);
  assertJsonbParameter(calls[0]?.values[0], ["inv-1"]);
});

test("storeSubscriptionOfferMessageId delegates to media_store_subscription_offer_message_id", async () => {
  const { query, calls } = createTaggedQueryStub([[{ updated_count: 2 }]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.storeSubscriptionOfferMessageId(
    ["inv-1", "inv-2"],
    101,
    777,
  );

  assert.equal(result, 2);
  assert.match(calls[0]?.sql ?? "", /public\.media_store_subscription_offer_message_id/u);
  assertJsonbParameter(calls[0]?.values[0], ["inv-1", "inv-2"]);
});

test("storePrecheckoutResult marks rejected invoice_sent token as failed in atomic SQL", async () => {
  const { query, calls } = createTaggedQueryStub();
  const repository = new MediaCommerceRepository(query as never);

  await repository.storePrecheckoutResult({
    token: "inv_payload",
    pre_checkout_query_id: "pcq-1",
    ok: false,
    error_message: "invoice_status_invalid",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /SELECT public\.media_store_precheckout_result\(/u);
});

test("storePrecheckoutResult does not overwrite paid token status or failure_reason in late rejection SQL", async () => {
  const { query, calls } = createTaggedQueryStub();
  const repository = new MediaCommerceRepository(query as never);

  await repository.storePrecheckoutResult({
    token: "inv_payload",
    pre_checkout_query_id: "pcq-2",
    ok: false,
    error_message: "invoice_status_invalid",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /public\.media_store_precheckout_result/u);
});

test("storePrecheckoutResult does not overwrite fulfilled token status or failure_reason in late rejection SQL", async () => {
  const { query, calls } = createTaggedQueryStub();
  const repository = new MediaCommerceRepository(query as never);

  await repository.storePrecheckoutResult({
    token: "inv_payload",
    pre_checkout_query_id: "pcq-3",
    ok: false,
    error_message: "invoice_status_invalid",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /public\.media_store_precheckout_result/u);
});

test("upsertInvoiceToken delegates to media_upsert_invoice_token and preserves first-insert shape", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 2,
      payload_json: {},
      sku: "payment_media_1",
      amount_xtr: 10,
      telegram_invoice_payload: "inv-payload",
      expires_at: "2026-08-14T10:00:00.000Z",
      telegram_invoice_message_id: null,
      invoice_link: null,
      stored: true,
      invoice_title: "Photo",
      invoice_description: "Unlock photo",
      invoice_label: "Photo",
      invoice_button_text: "Get photo",
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.upsertInvoiceToken({
    token: "inv-1",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 2,
    payload_json: {},
    action_kind: "photo_payment",
    sku: "payment_media_1",
    amount_xtr: 10,
    telegram_invoice_payload: "inv-payload",
    expires_at: "2026-08-14T10:00:00.000Z",
    invoice_title: "Photo",
    invoice_description: "Unlock photo",
    invoice_label: "Photo",
    invoice_button_text: "Get photo",
  });

  assert.equal(result?.stored, true);
  assert.equal(result?.token, "inv-1");
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_upsert_invoice_token\(/u);
  assertJsonbParameter(calls[0]?.values[6], {});
});

test("upsertInvoiceToken preserves idempotent repeat shape through media_upsert_invoice_token", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      scene_turn_no: 2,
      payload_json: { invoice_link: "https://example.com/invoice" },
      sku: "payment_media_1",
      amount_xtr: 10,
      telegram_invoice_payload: "inv-payload",
      expires_at: "2026-08-14T10:00:00.000Z",
      telegram_invoice_message_id: 777,
      invoice_link: "https://example.com/invoice",
      stored: false,
      invoice_title: "Photo",
      invoice_description: "Unlock photo",
      invoice_label: "Photo",
      invoice_button_text: "Get photo",
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.upsertInvoiceToken({
    token: "inv-1",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 2,
    payload_json: {},
    action_kind: "photo_payment",
    sku: "payment_media_1",
    amount_xtr: 10,
    telegram_invoice_payload: "inv-payload",
    expires_at: "2026-08-14T10:00:00.000Z",
    invoice_title: "Photo",
    invoice_description: "Unlock photo",
    invoice_label: "Photo",
    invoice_button_text: "Get photo",
  });

  assert.equal(result?.stored, false);
  assert.equal(result?.invoice_link, "https://example.com/invoice");
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_upsert_invoice_token\(/u);
  assertJsonbParameter(calls[0]?.values[6], {});
});

test("upsertInvoiceToken normalizes string payload_json into an object before calling media_upsert_invoice_token", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: null,
      turn_no: null,
      scene_turn_no: null,
      payload_json: { subscription_days: 14 },
      sku: "payment_plan_1",
      amount_xtr: 100,
      telegram_invoice_payload: "inv-1",
      expires_at: "2026-08-14T10:00:00.000Z",
      telegram_invoice_message_id: null,
      invoice_link: null,
      stored: true,
      invoice_title: "Plan",
      invoice_description: "Desc",
      invoice_label: "Label",
      invoice_button_text: "Button",
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  await repository.upsertInvoiceToken({
    token: "inv-1",
    kind: "invoice_payload",
    chat_id: 101,
    scene_session_id: null,
    turn_no: null,
    scene_turn_no: null,
    payload_json: "{\"subscription_days\":14}" as never,
    action_kind: "subscription_payment",
    sku: "payment_plan_1",
    amount_xtr: 100,
    telegram_invoice_payload: "inv-1",
    expires_at: "2026-08-14T10:00:00.000Z",
    invoice_title: "Plan",
    invoice_description: "Desc",
    invoice_label: "Label",
    invoice_button_text: "Button",
  });

  assert.equal(calls.length, 1);
  assertJsonbParameter(calls[0]?.values[6], { subscription_days: 14 });
});

test("storePanel delegates to media_store_panel function and preserves result shape", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      n: 5,
      scene_session_id: "scene-1",
      scene_turn_no: 2,
      media_signature: "room_close",
      price_required: 10,
      panel_message_id: 777,
      stored_count: 1,
      invoice_rows_updated: 1,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.storePanel({
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 2,
    media_signature: "room_close",
    panel_message_id: 777,
    price_xtr: 10,
    invoice_token: "inv-1",
    invoice_link: "https://example.com/invoice",
    panel_text: "panel",
    panel_entities_json: [],
  });

  assert.equal(result.stored_count, 1);
  assert.equal(result.invoice_rows_updated, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_store_panel\(/u);
  assertJsonbParameter(calls[0]?.values[10], []);
});

test("loadMediaContext sends panel_entities_json as jsonb array parameter", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      chat_id: 101,
      scene_session_id: "scene-yufi",
      turn_no: 5,
      scene_turn_no: 2,
      media_signature: "villa_hall_close",
      current_uuid: null,
      target_message_id: 777,
      base_price_xtr: 10,
      action_kind: "photo_request",
      requested_action: "photo_request",
      invoice_token: null,
      force_deliver_after_payment: false,
      paid_access_mode: null,
      callback_valid: true,
      panel_text: "panel",
      panel_entities_json: [],
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 0,
      unseen_available: 0,
      unlocked_items_json: [],
      next_unseen_json: null,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  await repository.loadMediaContext({
    chat_id: 101,
    scene_session_id: "scene-yufi",
    turn_no: 5,
    scene_turn_no: 2,
    media_signature: "villa_hall_close",
    current_uuid: null,
    target_message_id: 777,
    base_price_xtr: 10,
    action_kind: "photo_request",
    requested_action: "photo_request",
    invoice_token: null,
    force_deliver_after_payment: false,
    paid_access_mode: null,
    callback_valid: true,
    panel_text: "panel",
    panel_entities_json: [{ type: "italic", offset: 0, length: 5 }],
  });

  assertJsonbParameter(calls[0]?.values[15], [
    { type: "italic", offset: 0, length: 5 },
  ]);
});

test("storePhotoEvent delegates to media_store_photo_event function", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      stored_count: 1,
      chat_id: 101,
      scene_session_id: "scene-1",
      n: 5,
      scene_turn_no: 2,
      media_signature: "room_close",
      panel_message_id: 777,
      price_required: 10,
      invoice_rows_updated: 1,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.storePhotoEvent({
    chat_id: 101,
    scene_session_id: "scene-1",
    turn_no: 5,
    scene_turn_no: 2,
    event_type: "media.photo.unlocked.paid",
    media_signature: "room_close",
    uuid: "u-1",
    panel_message_id: 777,
    price_xtr: 10,
    access_mode: "paid",
    action_kind: "photo_payment",
    fulfillment_invoice_token: "inv-1",
    next_invoice_token: "inv-2",
    next_invoice_link: "https://example.com/next",
    price_required: 10,
  });

  assert.equal(result.stored_count, 1);
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_store_photo_event\(/u);
});

test("markInvoicePaid delegates to media_mark_invoice_paid function", async () => {
  const { query, calls } = createTaggedQueryStub([[
    {
      token: "inv-1",
      kind: "invoice_payload",
      chat_id: 101,
      scene_session_id: "scene-1",
      turn_no: 5,
      payload_json: {},
      status: "paid",
      action_kind: "photo_payment",
      sku: "payment_media_1",
      amount_xtr: 10,
      telegram_invoice_message_id: 777,
    },
  ]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.markInvoicePaid({
    token: "inv-1",
    chat_id: 101,
    expected_kind: "invoice_payload",
    expected_action_kind: "photo_payment",
    telegram_payment_charge_id: "tg-charge",
    provider_payment_charge_id: "provider-charge",
    payment_currency: "XTR",
    payment_total_amount: 10,
  });

  assert.equal(result?.status, "paid");
  assert.match(calls[0]?.sql ?? "", /FROM public\.media_mark_invoice_paid\(/u);
});

test("activateSubscription delegates to media_activate_subscription function", async () => {
  const { query, calls } = createTaggedQueryStub([[{ activated_count: 1 }]]);
  const repository = new MediaCommerceRepository(query as never);

  const result = await repository.activateSubscription({
    payment_token: "inv-1",
    chat_id: 101,
    subscription_sku: "payment_plan_1",
    subscription_days: 14,
  });

  assert.equal(result, 1);
  assert.match(calls[0]?.sql ?? "", /SELECT public\.media_activate_subscription\(/u);
});
