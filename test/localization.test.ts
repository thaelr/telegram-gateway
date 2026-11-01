import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalizationService,
  type LocalizationDictionary,
  type LocalizationStore,
} from "../src/localization.js";
import { testTelegramUxCopy } from "./testEnv.js";

class MemoryStore implements LocalizationStore {
  readonly calls: string[] = [];

  constructor(
    private readonly dictionaries: Record<string, LocalizationDictionary>,
  ) {}

  async load(locale: string, namespace: string) {
    const key = `${locale}:${namespace}`;
    this.calls.push(key);
    return this.dictionaries[key] ?? null;
  }
}

test("selected locale falls back per key to Russian and then compatibility copy", async () => {
  const store = new MemoryStore({
    "ru:telegram": {
      terms: { message: "Russian terms" },
      language: {
        message: "Choose",
        ru_button: "RU",
        en_button: "EN",
        updated: "Updated",
      },
    },
    "en:telegram": {
      terms: { accept_button: "Accept" },
      language: { message: "Choose language" },
      promo: { effect_id: "must-not-override-runtime-config" },
      scene_mode: {
        transition: {
          fast: { effect_id: "must-not-override-fast-effect" },
          roleplay: { effect_id: "must-not-override-roleplay-effect" },
        },
      },
      character_gallery: {
        order: [999],
        vote_url: "https://translations.example/incorrect",
      },
    },
  });
  const service = new LocalizationService(store, testTelegramUxCopy, 60_000);

  const copy = await service.getTelegramCopy("en");

  assert.equal(copy.terms.message, "Russian terms");
  assert.equal(copy.terms.accept_button, "Accept");
  assert.equal(copy.terms.open_button, testTelegramUxCopy.terms.open_button);
  assert.equal(copy.language?.message, "Choose language");
  assert.equal(copy.language?.updated, "Updated");
  assert.equal(copy.promo.effect_id, testTelegramUxCopy.promo.effect_id);
  assert.equal(
    copy.scene_mode.transition.fast.effect_id,
    testTelegramUxCopy.scene_mode.transition.fast.effect_id,
  );
  assert.equal(
    copy.scene_mode.transition.roleplay.effect_id,
    testTelegramUxCopy.scene_mode.transition.roleplay.effect_id,
  );
  assert.deepEqual(copy.character_gallery.order, testTelegramUxCopy.character_gallery.order);
  assert.equal(copy.character_gallery.vote_url, testTelegramUxCopy.character_gallery.vote_url);
});

test("localization cache refreshes after TTL without a process restart", async () => {
  let now = 1_000;
  const store = new MemoryStore({
    "ru:onboarding": { title: "RU" },
    "en:onboarding": { title: "EN" },
  });
  const service = new LocalizationService(
    store,
    testTelegramUxCopy,
    60_000,
    () => now,
  );

  assert.equal((await service.getNamespace("en", "onboarding")).title, "EN");
  assert.equal((await service.getNamespace("en", "onboarding")).title, "EN");
  assert.deepEqual(store.calls, ["ru:onboarding", "en:onboarding"]);

  now += 60_001;
  await service.getNamespace("en", "onboarding");
  assert.deepEqual(store.calls, [
    "ru:onboarding",
    "en:onboarding",
    "ru:onboarding",
    "en:onboarding",
  ]);
});

test("translation parameters are substituted after locale fallback", async () => {
  const store = new MemoryStore({
    "ru:commerce": { payment: { completed: "Paid {amount} {currency}" } },
  });
  const service = new LocalizationService(store, testTelegramUxCopy);

  assert.equal(
    await service.translate("en", "commerce", "payment.completed", {
      amount: 10,
      currency: "XTR",
    }),
    "Paid 10 XTR",
  );
  assert.equal(await service.translate("en", "commerce", "missing"), null);
});
