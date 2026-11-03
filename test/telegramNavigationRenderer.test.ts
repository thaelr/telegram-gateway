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

const { TelegramNavigationRenderer } = await import(
  "../src/telegramNavigationRenderer.js"
);
const { TelegramUxRequestError } = await import("../src/telegramBotClient.js");

function createHarness(options: {
  begin?: boolean;
  commit?: boolean;
  commitError?: Error;
  failMethod?: "sendPhoto" | "sendMediaGroup" | "sendMessage";
  failureOutcome?: "definitive_failure" | "uncertain";
} = {}) {
  const calls: string[] = [];
  let nextMessageId = 8000;
  const repository = {
    async beginRender() {
      calls.push("begin");
      return options.begin === false
        ? null
        : {
          active_menu_screen: "character_gallery",
          active_menu_message_id: 7001,
          active_menu_media_message_ids: [7000],
        };
    },
    async commitRender(input: { selectedCharacterId: number | null }) {
      calls.push(`commit:${input.selectedCharacterId ?? "none"}`);
      if (options.commitError) throw options.commitError;
      return options.commit !== false;
    },
  };
  const maybeFail = (method: string) => {
    calls.push(method);
    if (options.failMethod === method) {
      throw new TelegramUxRequestError(
        `${method} failed`,
        options.failureOutcome ?? "definitive_failure",
        method,
        null,
        null,
      );
    }
  };
  const telegram = {
    async answerCallbackQuery() {},
    async sendMessage() {
      maybeFail("sendMessage");
      return nextMessageId++;
    },
    async sendPhoto() {
      maybeFail("sendPhoto");
      return nextMessageId++;
    },
    async sendMediaGroup() {
      maybeFail("sendMediaGroup");
      return [nextMessageId++, nextMessageId++];
    },
    async deleteMessage(_chatId: number, messageId: number) {
      calls.push(`delete:${messageId}`);
    },
  };
  return { renderer: new TelegramNavigationRenderer(repository, telegram), calls };
}

const galleryInput = {
  telegram_chat_id: 101,
  navigation_revision: 3,
  screen: "character_gallery" as const,
  text: "Choose",
  reply_markup: { inline_keyboard: [] },
  gallery_media: [
    { type: "photo" as const, media: "https://example.com/1.jpg" },
    { type: "photo" as const, media: "https://example.com/2.jpg" },
  ],
};

test("commits a complete gallery before deleting the previous menu", async () => {
  const { renderer, calls } = createHarness();
  const result = await renderer.render(galleryInput);

  assert.equal(result.status, "committed");
  assert.deepEqual(calls, [
    "begin",
    "sendMediaGroup",
    "sendMessage",
    "commit:none",
    "delete:7001",
    "delete:7000",
  ]);
  assert.deepEqual(result.media_message_ids, [8000, 8001]);
  assert.equal(result.menu_message_id, 8002);
});

test("does not send a revision that was already started or became stale", async () => {
  const { renderer, calls } = createHarness({ begin: false });
  const result = await renderer.render(galleryInput);

  assert.equal(result.status, "stale_or_duplicate");
  assert.deepEqual(calls, ["begin"]);
});

test("cleans confirmed gallery media when the mandatory text fails", async () => {
  const { renderer, calls } = createHarness({
    failMethod: "sendMessage",
    failureOutcome: "definitive_failure",
  });
  const result = await renderer.render(galleryInput);

  assert.equal(result.status, "failed");
  assert.deepEqual(calls, [
    "begin",
    "sendMediaGroup",
    "sendMessage",
    "delete:8000",
    "delete:8001",
  ]);
  assert.equal(calls.some((value) => value.startsWith("commit:")), false);
  assert.equal(calls.includes("delete:7001"), false);
});

test("does not retry or clean blindly when Telegram delivery times out", async () => {
  const { renderer, calls } = createHarness({
    failMethod: "sendMessage",
    failureOutcome: "uncertain",
  });
  const result = await renderer.render(galleryInput);

  assert.equal(result.status, "uncertain");
  assert.deepEqual(calls, ["begin", "sendMediaGroup", "sendMessage"]);
});

test("a renderer that loses the commit race deletes only its own messages", async () => {
  const { renderer, calls } = createHarness({ commit: false });
  const result = await renderer.render(galleryInput);

  assert.equal(result.status, "stale_or_duplicate");
  assert.deepEqual(calls, [
    "begin",
    "sendMediaGroup",
    "sendMessage",
    "commit:none",
    "delete:8000",
    "delete:8001",
    "delete:8002",
  ]);
  assert.equal(calls.includes("delete:7001"), false);
});

test("returns uncertain without cleanup or retry when commit outcome is unknown", async () => {
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const { renderer, calls } = createHarness({
      commitError: new Error("database connection lost after commit request"),
    });
    const result = await renderer.render(galleryInput);

    assert.equal(result.status, "uncertain");
    assert.equal(result.reason, "navigation_render_commit_outcome_uncertain");
    assert.equal(result.menu_message_id, 8002);
    assert.deepEqual(result.media_message_ids, [8000, 8001]);
    assert.deepEqual(calls, [
      "begin",
      "sendMediaGroup",
      "sendMessage",
      "commit:none",
    ]);
    assert.equal(calls.some((value) => value.startsWith("delete:")), false);
    assert.equal(calls.filter((value) => value === "sendMediaGroup").length, 1);
    assert.equal(calls.filter((value) => value === "sendMessage").length, 1);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.[0], "[telegram_navigation] commit_render_outcome_uncertain");
  } finally {
    console.error = originalConsoleError;
  }
});

test("character mode keeps the existing text fallback and commits selection last", async () => {
  const { renderer, calls } = createHarness({
    failMethod: "sendPhoto",
    failureOutcome: "definitive_failure",
  });
  const result = await renderer.render({
    telegram_chat_id: 101,
    navigation_revision: 4,
    screen: "character_mode",
    text: "Mode",
    menu_photo_url: "https://example.com/mode.jpg",
    selected_character_i: 2,
    reply_markup: { inline_keyboard: [] },
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(calls, [
    "begin",
    "sendPhoto",
    "sendMessage",
    "commit:2",
    "delete:7001",
    "delete:7000",
  ]);
});
