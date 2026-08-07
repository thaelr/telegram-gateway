import test from "node:test";
import assert from "node:assert/strict";
import type { AccessContext, AccessDecisionRequest } from "../src/types.js";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.TURN_LIMIT ??= "15";
process.env.BUSINESS_TIME_ZONE ??= "Europe/Moscow";
process.env.TURN_LIMIT_RESET_TEXT ??= "00:00 МСК";

const { AccessDecisionService } = await import("../src/accessDecisionService.js");

type RepositoryCall = {
  chatId: number;
  source: string | null;
  sourceUserId: number | null;
  timeZone: string;
};

type MockRepository = {
  calls: RepositoryCall[];
  ensureAndLoadAccessContext: (
    chatId: number,
    source: string | null,
    sourceUserId: number | null,
    timeZone: string,
  ) => Promise<AccessContext>;
};

function buildAccessContext(
  overrides: Partial<AccessContext> = {},
): AccessContext {
  return {
    chat_id: 101,
    source: "telegram",
    source_user_id: 202,
    terms_accepted_at: "2026-08-01T10:00:00.000Z",
    subscription_sku: null,
    subscription_until: null,
    subscription_active: false,
    turns_today: 0,
    selected_character_i: 1,
    active_menu_screen: null,
    active_menu_message_id: null,
    ...overrides,
  };
}

function buildRequest(
  overrides: Partial<AccessDecisionRequest> = {},
): AccessDecisionRequest {
  return {
    chat_id: 101,
    source: "telegram",
    update_id: 555,
    source_user_id: 202,
    route_target: null,
    event_type: "message.text.received",
    message_type: "text",
    user_message: "hello",
    command: null,
    inbound_message_id: 12,
    callback_data: null,
    callback_query_id: null,
    pre_checkout_query_id: null,
    invoice_payload: null,
    telegram_payment_charge_id: null,
    provider_payment_charge_id: null,
    payment_currency: null,
    payment_total_amount: null,
    reachability_status: null,
    telegram_chat_status: null,
    character_i: 1,
    scene_mode: "roleplay",
    ...overrides,
  };
}

function createService(
  context: AccessContext = buildAccessContext(),
  options: {
    throwOnCall?: boolean;
  } = {},
) {
  const calls: RepositoryCall[] = [];
  const repository: MockRepository = {
    calls,
    async ensureAndLoadAccessContext(chatId, source, sourceUserId, timeZone) {
      calls.push({ chatId, source, sourceUserId, timeZone });
      if (options.throwOnCall) {
        throw new Error("Repository should not be called");
      }
      return context;
    },
  };

  return {
    service: new AccessDecisionService(repository),
    calls,
  };
}

test("returns show_terms_gate when terms are not accepted", async () => {
  const { service, calls } = createService(
    buildAccessContext({ terms_accepted_at: null, turns_today: 3 }),
  );

  const result = await service.evaluate(buildRequest());

  assert.equal(result.action, "show_terms_gate");
  assert.equal(result.decision, "show_terms_gate");
  assert.equal(result.allowed, false);
  assert.equal(result.post_accept_intent, "start");
  assert.equal(result.reason, "terms_not_accepted");
  assert.equal(calls.length, 1);
});

test("returns show_character_gallery for /start after terms are accepted", async () => {
  const { service, calls } = createService(
    buildAccessContext({
      active_menu_screen: "character_gallery",
      active_menu_message_id: 88,
    }),
  );

  const result = await service.evaluate(
    buildRequest({
      command: "/start",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
  );

  assert.equal(result.intent, "scene_start");
  assert.equal(result.action, "show_character_gallery");
  assert.equal(result.allowed, true);
  assert.equal(result.active_menu_screen, "character_gallery");
  assert.equal(result.active_menu_message_id, 88);
  assert.equal(calls.length, 1);
});

test("returns show_character_gallery for /menu after terms are accepted", async () => {
  const { service, calls } = createService();

  const result = await service.evaluate(
    buildRequest({
      command: "/menu",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
  );

  assert.equal(result.intent, "menu");
  assert.equal(result.action, "show_character_gallery");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 1);
});

test("returns allow_scene for active subscription", async () => {
  const { service } = createService(
    buildAccessContext({
      subscription_active: true,
      subscription_sku: "media_sub_30d",
      subscription_until: "2026-08-20T10:00:00.000Z",
      turns_today: 99,
    }),
  );

  const result = await service.evaluate(buildRequest());

  assert.equal(result.action, "run_scene_core");
  assert.equal(result.decision, "allow_scene");
  assert.equal(result.allowed, true);
  assert.equal(result.subscription_active, true);
  assert.equal(result.reason, "subscription_active");
});

test("returns allow_scene within daily limit", async () => {
  const { service } = createService(buildAccessContext({ turns_today: 5 }));

  const result = await service.evaluate(buildRequest());

  assert.equal(result.action, "run_scene_core");
  assert.equal(result.decision, "allow_scene");
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "within_daily_limit");
});

test("returns subscription offer when daily limit is exhausted", async () => {
  const { service } = createService(buildAccessContext({ turns_today: 15 }));

  const result = await service.evaluate(buildRequest());

  assert.equal(result.action, "show_subscription_offer");
  assert.equal(result.decision, "show_subscription_offer");
  assert.equal(result.allowed, false);
  assert.equal(result.subscription_offer_reason, "daily_turn_limit");
  assert.equal(result.reason, "daily_turn_limit_reached");
});

test("returns subscription status for /subscription with active subscription", async () => {
  const { service } = createService(
    buildAccessContext({
      subscription_active: true,
      subscription_sku: "media_sub_14d",
      subscription_until: "2026-08-15T10:00:00.000Z",
    }),
  );

  const result = await service.evaluate(
    buildRequest({
      command: "/subscription",
      event_type: "command.received",
      message_type: "command",
    }),
  );

  assert.equal(result.action, "show_subscription_status");
  assert.equal(result.decision, "show_subscription_status");
  assert.equal(result.allowed, true);
  assert.match(result.text ?? "", /Подписка активна/u);
});

test("returns subscription offer for /subscription without active subscription", async () => {
  const { service } = createService(buildAccessContext());

  const result = await service.evaluate(
    buildRequest({
      command: "/subscription",
      event_type: "command.received",
      message_type: "command",
    }),
  );

  assert.equal(result.action, "show_subscription_offer");
  assert.equal(result.decision, "show_subscription_offer");
  assert.equal(result.allowed, true);
  assert.equal(result.subscription_offer_reason, "subscription_command");
});

test("returns character mode screen for character_select callback without repository call", async () => {
  const { service, calls } = createService(buildAccessContext(), {
    throwOnCall: true,
  });

  const result = await service.evaluate(
    buildRequest({
      event_type: "callback_query.received",
      callback_data: "character_select:2",
      user_message: null,
    }),
  );

  assert.equal(result.intent, "character_select");
  assert.equal(result.action, "show_character_mode_screen");
  assert.equal(result.character_i, 2);
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 0);
});

test("returns handle_character_back without repository call", async () => {
  const { service, calls } = createService(buildAccessContext(), {
    throwOnCall: true,
  });

  const result = await service.evaluate(
    buildRequest({
      event_type: "callback_query.received",
      callback_data: "character_menu:back",
      user_message: null,
    }),
  );

  assert.equal(result.intent, "character_back");
  assert.equal(result.action, "handle_character_back");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 0);
});

test("scene message is classified by event_type without route_target", async () => {
  const { service, calls } = createService(buildAccessContext({ turns_today: 2 }));

  const result = await service.evaluate(
    buildRequest({
      route_target: null,
      event_type: "message.caption.received",
    }),
  );

  assert.equal(result.action, "run_scene_core");
  assert.equal(result.decision, "allow_scene");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 1);
});

test("scene mode callback is access-controlled and allowed within daily limit", async () => {
  const { service, calls } = createService(buildAccessContext({ turns_today: 4 }));

  const result = await service.evaluate(
    buildRequest({
      event_type: "callback_query.received",
      callback_data: "scene_mode:fast",
      user_message: null,
    }),
  );

  assert.equal(result.intent, "scene_mode");
  assert.equal(result.action, "handle_scene_mode");
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.decision, "allow_scene");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 1);
});

test("payment is classified by event_type without route_target", async () => {
  const { service, calls } = createService(buildAccessContext(), {
    throwOnCall: true,
  });

  const result = await service.evaluate(
    buildRequest({
      route_target: null,
      event_type: "payment.success.received",
      user_message: null,
    }),
  );

  assert.equal(result.action, "handle_commerce_interaction");
  assert.equal(result.decision, "noop");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 0);
});

test("reachability is classified by event_type without route_target", async () => {
  const { service, calls } = createService(buildAccessContext(), {
    throwOnCall: true,
  });

  const result = await service.evaluate(
    buildRequest({
      route_target: null,
      event_type: "my_chat_member.updated",
      reachability_status: "blocked",
      telegram_chat_status: "kicked",
      user_message: null,
    }),
  );

  assert.equal(result.action, "update_reachability_state");
  assert.equal(result.decision, "noop");
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 0);
});

test("bypass events do not call repository", async () => {
  const cases: AccessDecisionRequest[] = [
    buildRequest({
      callback_data: "terms_accept:start",
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      callback_data: "newscene_confirm:yes",
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      callback_data: "character_select:3",
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      callback_data: "character_menu:back",
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      event_type: "payment.pre_checkout.received",
      user_message: null,
    }),
    buildRequest({
      command: "/unknown",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      event_type: null,
      user_message: null,
    }),
  ];

  for (const request of cases) {
    const { service, calls } = createService(buildAccessContext(), {
      throwOnCall: true,
    });
    const result = await service.evaluate(request);
    assert.equal(calls.length, 0);
    assert.equal(result.decision, "noop");
  }
});

test("access-controlled intents call repository exactly once", async () => {
  const requests: AccessDecisionRequest[] = [
    buildRequest({
      command: "/start",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      command: "/menu",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      command: "/newscene",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      command: "/subscription",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      command: "/paysupport",
      event_type: "command.received",
      message_type: "command",
      user_message: null,
    }),
    buildRequest({
      callback_data: "scene_mode:roleplay",
      event_type: "callback_query.received",
      user_message: null,
    }),
    buildRequest({
      event_type: "message.text.received",
      route_target: null,
    }),
  ];

  for (const request of requests) {
    const { service, calls } = createService(buildAccessContext({ turns_today: 1 }));
    await service.evaluate(request);
    assert.equal(calls.length, 1);
  }
});

test("preserves additional normalized fields in the response", async () => {
  const { service } = createService(
    buildAccessContext({
      turns_today: 2,
      active_menu_screen: "character_detail",
      active_menu_message_id: 451,
    }),
  );

  const result = await service.evaluate(
    buildRequest({
      callback_data: "scene_mode:fast",
      callback_query_id: "cbq_1",
      pre_checkout_query_id: "pcq_1",
      invoice_payload: "inv_555",
      telegram_payment_charge_id: "tg_charge_1",
      provider_payment_charge_id: "provider_charge_1",
      payment_currency: "XTR",
      payment_total_amount: 349,
      reachability_status: "reachable",
      telegram_chat_status: "member",
      user_message: null,
    }),
  );

  assert.equal(result.source, "telegram");
  assert.equal(result.callback_data, "scene_mode:fast");
  assert.equal(result.callback_query_id, "cbq_1");
  assert.equal(result.pre_checkout_query_id, "pcq_1");
  assert.equal(result.invoice_payload, "inv_555");
  assert.equal(result.telegram_payment_charge_id, "tg_charge_1");
  assert.equal(result.provider_payment_charge_id, "provider_charge_1");
  assert.equal(result.payment_currency, "XTR");
  assert.equal(result.payment_total_amount, 349);
  assert.equal(result.reachability_status, "reachable");
  assert.equal(result.telegram_chat_status, "member");
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.active_menu_screen, "character_detail");
  assert.equal(result.active_menu_message_id, 451);
});

test("returns stable idempotency_key for same update", async () => {
  const { service } = createService(buildAccessContext({ turns_today: 1 }));
  const request = buildRequest({ update_id: 777, source: "telegram" });

  const first = await service.evaluate(request);
  const second = await service.evaluate(request);

  assert.equal(first.idempotency_key, "telegram:777");
  assert.equal(second.idempotency_key, "telegram:777");
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test("uses special post_accept_intent for gated subscription, paysupport, and menu commands", async () => {
  const { service } = createService(
    buildAccessContext({ terms_accepted_at: null }),
  );

  const subscriptionResult = await service.evaluate(
    buildRequest({
      command: "/subscription",
      event_type: "command.received",
      message_type: "command",
    }),
  );
  assert.equal(subscriptionResult.post_accept_intent, "subscription");

  const paysupportResult = await service.evaluate(
    buildRequest({
      command: "/paysupport",
      event_type: "command.received",
      message_type: "command",
    }),
  );
  assert.equal(paysupportResult.post_accept_intent, "paysupport");

  const menuResult = await service.evaluate(
    buildRequest({
      command: "/menu",
      event_type: "command.received",
      message_type: "command",
    }),
  );
  assert.equal(menuResult.post_accept_intent, "menu");
});
