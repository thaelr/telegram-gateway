import test from "node:test";
import assert from "node:assert/strict";
import type { AccessContext } from "../src/types.js";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
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

const { ChatAccessRepository } = await import("../src/application/chatAccessRepository.js");

type QueryCall = {
  strings: string[];
  values: unknown[];
};

function withDailyUsage(query: ConstructorParameters<typeof ChatAccessRepository>[0]) {
  assert.ok(query);
  return Object.assign(query, {
    unsafe: async (statement: string, values: unknown[]) => {
      assert.match(statement, /app_private\.message_admissions/u);
      assert.match(statement, /WHERE user_id=\$1/u);
      assert.doesNotMatch(statement, /chat_turns/u);
      assert.equal(values[0], 'u00000ab');
      assert.equal(values[1], 'Europe/Moscow');
      return [{ used: 0 }];
    },
  }) as ConstructorParameters<typeof ChatAccessRepository>[0];
}

function buildAccessContext(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    chat_id: 999001,
    telegram_chat_id: 999001,
    user_id: "u00000ab",
    character_i: null,
    source: "telegram",
    source_user_id: 777001,
    language: null,
    language_confirmed_at: null,
    terms_accepted_at: null,
    subscription_sku: null,
    subscription_until: null,
    subscription_active: false,
    active_scene_session_id: null,
    active_scene_exists: false,
    scene_access_active: false,
    free_fast_scene_skips: 0,
    free_scene_unlocks: 0,
    free_photo_unlocks: 0,
    turns_today: 0,
    scene_turn_no: -1,
    selected_character_i: null,
    active_menu_screen: null,
    active_menu_message_id: null,
    ...overrides,
  };
}

test("creates the Telegram routing state and loads its access context", async () => {
  const calls: QueryCall[] = [];
  const expected = buildAccessContext();

  const query = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({
      strings: Array.from(strings),
      values,
    });
    return Promise.resolve([expected]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const repository = new ChatAccessRepository(withDailyUsage(query));
  const result = await repository.ensureAndLoadAccessContext(
    999001,
    "telegram",
    777001,
    "Europe/Moscow",
  );

  assert.deepEqual(result, expected);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.values.slice(0, 3), [999001, "telegram", 777001]);

  const routingSql = calls[0]?.strings.join(" ") ?? "";
  const contextSql = calls[1]?.strings.join(" ") ?? "";
  assert.match(routingSql, /INSERT INTO public\.chat_state/u);
  assert.match(routingSql, /ON CONFLICT \(chat_id\) DO UPDATE/u);
  assert.match(routingSql, /app_private\.ensure_telegram_chat_account/u);
  assert.match(contextSql, /LEFT JOIN public\.users account/u);
  assert.match(contextSql, /account\.entitlements_jsonb/u);
  assert.match(contextSql, /WHERE cs\.chat_id =/u);
});

test("resolves an existing active character dialogue and keeps Telegram delivery separate", async () => {
  const calls: QueryCall[] = [];
  const responses = [
    [{
      user_id: "u00000ab",
      selected_character_i: 2,
      active_menu_screen: "character_mode",
      active_menu_message_id: 81,
    }],
    [{ chat_id: 8000000000000042 }],
    [buildAccessContext({
      chat_id: 8000000000000042,
      telegram_chat_id: 999001,
      character_i: 2,
      selected_character_i: 2,
    })],
  ];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve(responses[calls.length - 1] ?? []);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const result = await new ChatAccessRepository(withDailyUsage(query)).ensureAndLoadAccessContext(
    999001,
    "telegram",
    777001,
    "Europe/Moscow",
    2,
  );

  assert.equal(result.chat_id, 8000000000000042);
  assert.equal(result.telegram_chat_id, 999001);
  assert.equal(result.character_i, 2);
  assert.equal(calls.length, 3);
  assert.match(calls[1]?.strings.join(" ") ?? "", /user_id =/u);
  assert.match(calls[1]?.strings.join(" ") ?? "", /character_i =/u);
  assert.match(calls[1]?.strings.join(" ") ?? "", /AND is_active/u);
  assert.doesNotMatch(calls[1]?.strings.join(" ") ?? "", /INSERT INTO/u);
});

test("creates a missing character dialogue through the active-chat unique index", async () => {
  const calls: QueryCall[] = [];
  const responses = [
    [{
      user_id: "u00000ab",
      selected_character_i: 3,
      active_menu_screen: null,
      active_menu_message_id: null,
    }],
    [],
    [{ chat_id: 8000000000000043 }],
    [buildAccessContext({
      chat_id: 8000000000000043,
      telegram_chat_id: 999001,
      character_i: 3,
      selected_character_i: 3,
    })],
  ];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve(responses[calls.length - 1] ?? []);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const result = await new ChatAccessRepository(withDailyUsage(query)).ensureAndLoadAccessContext(
    999001,
    "telegram",
    777001,
    "Europe/Moscow",
    3,
  );

  assert.equal(result.chat_id, 8000000000000043);
  assert.equal(calls.length, 4);
  const insertSql = calls[2]?.strings.join(" ") ?? "";
  assert.match(insertSql, /INSERT INTO public\.chat_state/u);
  assert.match(insertSql, /ON CONFLICT \(user_id, character_i\)/u);
  assert.match(insertSql, /AND is_active/u);
});

test("resolves a reset callback target without overwriting Telegram selection", async () => {
  const calls: QueryCall[] = [];
  const responses = [
    [{
      user_id: "u00000ab",
      selected_character_i: 3,
      requested_character_i: 2,
      active_menu_screen: null,
      active_menu_message_id: null,
    }],
    [{ chat_id: 8000000000000042 }],
    [buildAccessContext({
      chat_id: 8000000000000042,
      telegram_chat_id: 999001,
      character_i: 2,
      selected_character_i: 3,
      active_scene_session_id: "scene-character-2",
      scene_turn_no: 4,
    })],
  ];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve(responses[calls.length - 1] ?? []);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const result = await new ChatAccessRepository(withDailyUsage(query)).ensureAndLoadAccessContext(
    999001,
    "telegram",
    777001,
    "Europe/Moscow",
    2,
    false,
  );

  assert.equal(result.chat_id, 8000000000000042);
  assert.equal(result.character_i, 2);
  assert.equal(result.selected_character_i, 3);
  assert.equal(calls[0]?.values.includes(false), true);
  const routingSql = calls[0]?.strings.join(" ") ?? "";
  assert.match(routingSql, /WHEN .*::boolean THEN COALESCE/u);
  assert.match(routingSql, /ELSE cs\.selected_character_i/u);
});

test("ensureTelegramAccountLink delegates atomic identity resolution to the database", async () => {
  const calls: QueryCall[] = [];
  const query = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve([{ user_id: "u00000ab" }]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const repository = new ChatAccessRepository(query);
  const userId = await repository.ensureTelegramAccountLink(999001, 777001);

  assert.equal(userId, "u00000ab");
  assert.deepEqual(calls[0]?.values, [999001, 777001]);
  assert.match(
    calls[0]?.strings.join(" ") ?? "",
    /app_private\.ensure_telegram_chat_account/u,
  );
});

test("stores only an explicit Telegram language selection", async () => {
  const calls: QueryCall[] = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve([{ language_confirmed_at: "2026-10-30T00:00:00.000Z" }]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const confirmedAt = await new ChatAccessRepository(query).setTelegramLanguage(
    777001,
    "ru",
  );

  assert.equal(confirmedAt, "2026-10-30T00:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values, ["ru", 777001, null, null, null]);
  const statement = calls[0]?.strings.join(" ") ?? "";
  assert.match(statement, /UPDATE public\.users AS account/u);
  assert.match(statement, /FROM public\.user_identities AS identity/u);
  assert.match(statement, /identity\.provider = 'telegram'/u);
  assert.match(statement, /identity\.external_id =/u);
  assert.match(statement, /language_confirmed_at = clock_timestamp\(\)/u);
  assert.match(statement, /navigation_state\.navigation_revision/u);
  assert.doesNotMatch(statement, /language_code/u);
  assert.doesNotMatch(statement, /INSERT INTO/u);
  assert.doesNotMatch(statement, /ensure_telegram_chat_account/u);
});

test("fails closed when an explicit Telegram language has no linked account", async () => {
  const calls: QueryCall[] = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve([]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  await assert.rejects(
    new ChatAccessRepository(query).setTelegramLanguage(777001, "en"),
    /Unable to save Telegram language/u,
  );

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]?.strings.join(" ") ?? "", /INSERT INTO/u);
});

test("resumes only the currently registered Telegram navigation update", async () => {
  const calls: QueryCall[] = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve([{
      navigation_revision: "41",
      active_menu_screen: "character_gallery",
      active_menu_message_id: "91",
      active_menu_media_message_ids_json: [88, "89", null],
    }]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const result = await new ChatAccessRepository(query).resumeTelegramNavigation({
    chatId: 777001,
    updateId: 555,
    navigationRevision: 41,
  });

  assert.deepEqual(calls[0]?.values, [777001, 41, 555]);
  assert.match(calls[0]?.strings.join(" ") ?? "", /navigation_update_id/u);
  assert.deepEqual(result, {
    accepted: true,
    reason: "accepted",
    navigation_revision: 41,
    active_menu_screen: "character_gallery",
    active_menu_message_id: 91,
    active_menu_media_message_ids: [88, 89],
  });
});

test("rejects a stale internal continuation", async () => {
  const query = (() => Promise.resolve([])) as unknown as ConstructorParameters<
    typeof ChatAccessRepository
  >[0];

  const result = await new ChatAccessRepository(query).resumeTelegramNavigation({
    chatId: 777001,
    updateId: 555,
    navigationRevision: 40,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "stale_update");
  assert.equal(result.navigation_revision, 40);
});

test("resolveTelegramChatId follows account identity from an internal dialogue", async () => {
  const calls: QueryCall[] = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    return Promise.resolve([{ telegram_chat_id: "777001" }]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const telegramChatId = await new ChatAccessRepository(query)
    .resolveTelegramChatId(8000000000000042);

  assert.equal(telegramChatId, 777001);
  assert.deepEqual(calls[0]?.values, [8000000000000042]);
  const querySql = calls[0]?.strings.join(" ") ?? "";
  assert.match(querySql, /public\.user_identities/u);
  assert.match(querySql, /identity\.provider = 'telegram'/u);
  assert.match(querySql, /state\.user_id/u);
});
