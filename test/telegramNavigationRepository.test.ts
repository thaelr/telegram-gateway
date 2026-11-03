import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([{
  sku: "test_subscription", days: 30, amount_xtr: 100,
  title: "Test", description: "Test", label: "Test", button_text: "Test",
}]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([{
  sku: "test_photo", amount_xtr: 10,
  title: "Test", description: "Test", label: "Test", button_text: "Test",
}]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([{
  sku: "test_action", feature_key: "scene_unlock", amount_xtr: 10,
  title: "Test", description: "Test", label: "Test", button_text: "Test",
}]);

const { TelegramNavigationRepository } = await import(
  "../src/telegramNavigationRepository.js"
);

test("register delegates ordering and old-menu validation to one database function", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join(" "), values });
    return Promise.resolve([{
      accepted: true,
      reason: "accepted",
      navigation_revision: "9",
      active_menu_screen: "character_gallery",
      active_menu_message_id: "7001",
      active_menu_media_message_ids_json: [7000],
    }]);
  }) as never;

  const result = await new TelegramNavigationRepository(query).register({
    chatId: 101,
    updateId: 900,
    source: "telegram",
    sourceUserId: 202,
    expectedMenuScreen: "character_gallery",
    inboundMessageId: 7001,
  });

  assert.equal(result.navigation_revision, 9);
  assert.deepEqual(result.active_menu_media_message_ids, [7000]);
  assert.match(calls[0]!.sql, /app_private\.register_telegram_navigation/u);
  assert.deepEqual(calls[0]!.values, [
    101, 900, "telegram", 202, "character_gallery", 7001,
  ]);
});

test("renderer claim and commit use conditional database functions", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const responses = [
    [{
      active_menu_screen: "character_mode",
      active_menu_message_id: 7101,
      active_menu_media_message_ids_json: "[]",
    }],
    [{ committed: true }],
  ];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join(" "), values });
    return Promise.resolve(responses[calls.length - 1]);
  }) as never;
  const repository = new TelegramNavigationRepository(query);

  const claim = await repository.beginRender(101, 10);
  const committed = await repository.commitRender({
    chatId: 101,
    navigationRevision: 10,
    screen: "character_mode",
    menuMessageId: 7201,
    mediaMessageIds: [],
    selectedCharacterId: 2,
  });

  assert.equal(claim?.active_menu_message_id, 7101);
  assert.equal(committed, true);
  assert.match(calls[0]!.sql, /begin_telegram_navigation_render/u);
  assert.match(calls[1]!.sql, /commit_telegram_navigation_render/u);
  assert.match(calls[1]!.sql, /::text::jsonb/u);
  assert.deepEqual(calls[1]!.values, [101, 10, "character_mode", 7201, "[]", 2]);
});

test("non-navigation Telegram updates advance only the shared observation clock", async () => {
  const calls: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    calls.push(strings.join(" "));
    return Promise.resolve([{ update_epoch: "4" }]);
  }) as never;

  const epoch = await new TelegramNavigationRepository(query)
    .observeTelegramUpdate();

  assert.equal(epoch, 4);
  assert.match(calls[0]!, /app_private\.observe_telegram_update/u);
  assert.doesNotMatch(calls[0]!, /public\.chat_state/u);
});
