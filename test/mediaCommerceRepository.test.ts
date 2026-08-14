import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.MEDIA_STORAGE_BASE_URL = "https://media.example.com";
process.env.MEDIA_CHARACTER_CATALOG_RELATIONS_JSON = JSON.stringify({
  1: "public.media_catalog",
});

const { MediaCommerceRepository } = await import(
  "../src/mediaCommerceRepository.js"
);

type UnsafeCall = {
  sql: string;
  params: unknown[];
};

type TaggedCall = {
  sql: string;
  values: unknown[];
};

function createQueryStub(responses: unknown[][]) {
  const calls: UnsafeCall[] = [];
  return {
    calls,
    unsafe<T>(sqlText: string, params: unknown[]) {
      calls.push({ sql: sqlText, params });
      return Promise.resolve((responses.shift() ?? []) as T);
    },
  };
}

function createTaggedQueryStub() {
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
    return Promise.resolve([]);
  };

  return {
    calls,
    query,
  };
}

test("loadOfferStats returns empty catalog for character without configured media source", async () => {
  const query = createQueryStub([[{ character_i: 2 }]]);
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
  assert.equal(query.calls.length, 1);
  assert.ok(query.calls[0]);
  assert.match(query.calls[0].sql, /FROM public\.chat_scene_sessions/u);
});

test("loadMediaContext returns empty catalog for character without configured media source", async () => {
  const query = createQueryStub([[{ character_i: 2 }]]);
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
  assert.equal(query.calls.length, 1);
  assert.ok(query.calls[0]);
  assert.match(query.calls[0].sql, /FROM public\.chat_scene_sessions/u);
});

test("loadOfferStats uses configured catalog for character with media source", async () => {
  const query = createQueryStub([
    [{ character_i: 1 }],
    [{
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
    }],
  ]);
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
  assert.equal(query.calls.length, 2);
  assert.ok(query.calls[1]);
  assert.match(query.calls[1].sql, /FROM public\.media_catalog mc/u);
});

test("loadMediaContext uses configured catalog for character with media source", async () => {
  const query = createQueryStub([
    [{ character_i: 1 }],
    [{
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
    }],
  ]);
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
  assert.equal(query.calls.length, 2);
  assert.ok(query.calls[1]);
  assert.match(query.calls[1].sql, /FROM public\.media_catalog mc/u);
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
  assert.match(calls[0]?.sql ?? "", /UPDATE public\.interaction_tokens AS t/u);
  assert.match(calls[0]?.sql ?? "", /WHEN t\.status = 'invoice_sent' THEN \$3::text/u);
  assert.match(calls[0]?.sql ?? "", /WHEN t\.status = 'invoice_sent' THEN 'failed'/u);
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
  assert.match(calls[0]?.sql ?? "", /ELSE t\.failure_reason/u);
  assert.match(calls[0]?.sql ?? "", /ELSE t\.status/u);
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
  assert.match(calls[0]?.sql ?? "", /ELSE t\.failure_reason/u);
  assert.match(calls[0]?.sql ?? "", /ELSE t\.status/u);
});
