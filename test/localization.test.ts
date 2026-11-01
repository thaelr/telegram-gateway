import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LocalizationService,
  type LocalizationDictionary,
  type LocalizationStore,
} from "../src/localization.js";
import { testTelegramRuntimeSettings, testTelegramUxCopy } from "./testEnv.js";

const localizationRepositorySource = await readFile(
  path.resolve(import.meta.dirname, "../src/localizationRepository.ts"),
  "utf8",
);

class MemoryStore implements LocalizationStore {
  readonly calls: string[] = [];

  constructor(
    private readonly dictionaries: Record<string, LocalizationDictionary>,
    private readonly languages: Array<{ locale: string; metadata: unknown }> = [],
  ) {}

  async load(locale: string, namespace: string) {
    const key = `${locale}:${namespace}`;
    this.calls.push(key);
    return this.dictionaries[key] ?? null;
  }

  async listLanguages() {
    return this.languages;
  }
}

test("selected locale falls back per key to Russian and runtime values stay outside translations", async () => {
  const store = new MemoryStore({
    "ru:telegram": {
      ...structuredClone(testTelegramUxCopy),
      terms: { ...testTelegramUxCopy.terms, message: "Russian terms" },
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
  const service = new LocalizationService(store, testTelegramRuntimeSettings, 60_000);

  const copy = await service.getTelegramCopy("en");

  assert.equal(copy.terms.message, "Russian terms");
  assert.equal(copy.terms.accept_button, "Accept");
  assert.equal(copy.terms.open_button, testTelegramUxCopy.terms.open_button);
  assert.equal(copy.language?.message, "Choose language");
  assert.equal(copy.language?.updated, "Updated");
  assert.equal(copy.promo.effect_id, testTelegramRuntimeSettings.promoEffectId);
  assert.equal(
    copy.scene_mode.transition.fast.effect_id,
    testTelegramRuntimeSettings.fastSceneEffectId,
  );
  assert.equal(
    copy.scene_mode.transition.roleplay.effect_id,
    testTelegramRuntimeSettings.roleplaySceneEffectId,
  );
  assert.deepEqual(copy.character_gallery.order, testTelegramRuntimeSettings.characterGalleryOrder);
  assert.equal(copy.character_gallery.vote_url, testTelegramRuntimeSettings.characterVoteUrl);
});

test("localization cache refreshes after TTL without a process restart", async () => {
  let now = 1_000;
  const store = new MemoryStore({
    "ru:onboarding": { title: "RU" },
    "en:onboarding": { title: "EN" },
  });
  const service = new LocalizationService(
    store,
    testTelegramRuntimeSettings,
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
  const service = new LocalizationService(store, testTelegramRuntimeSettings);

  assert.equal(
    await service.translate("en", "commerce", "payment.completed", {
      amount: 10,
      currency: "XTR",
    }),
    "Paid 10 XTR",
  );
  assert.equal(await service.translate("en", "commerce", "missing"), null);
});

test("enabled languages validate raw metadata and sort valid rows in the application", async () => {
  const service = new LocalizationService(new MemoryStore({}, [
    { locale: "en", metadata: { display_name: "English", enabled: true, sort_order: 20 } },
    { locale: "ru", metadata: { display_name: "Русский", enabled: true, sort_order: 10 } },
    { locale: "de", metadata: { display_name: "Deutsch", enabled: false, sort_order: 5 } },
    { locale: "bad_locale", metadata: { display_name: "Bad", enabled: true, sort_order: 1 } },
    { locale: "fr", metadata: { display_name: "Français", enabled: "true", sort_order: "30" } },
    { locale: "it", metadata: { display_name: "Italiano", enabled: true, sort_order: "40" } },
  ]), testTelegramRuntimeSettings);

  assert.deepEqual(await service.getEnabledLanguages(), [
    { locale: "ru", display_name: "Русский", sort_order: 10 },
    { locale: "en", display_name: "English", sort_order: 20 },
  ]);
  assert.equal(await service.isEnabledLanguage("EN"), true);
  assert.equal(await service.isEnabledLanguage("de"), false);
  assert.equal(await service.isEnabledLanguage("not_a_locale"), false);
});

test("language repository reads raw metadata without risky SQL casts", async () => {
  assert.match(localizationRepositorySource, /copy_json -> '_language' AS metadata/u);
  assert.doesNotMatch(localizationRepositorySource, /'_language'[^\n]*::boolean/u);
  assert.doesNotMatch(localizationRepositorySource, /'_language'[^\n]*::integer/u);
});

test("payment methods use exact locale policy, ignore unknown providers and keep Telegram Stars", async () => {
  const service = new LocalizationService(new MemoryStore({
    "ru:payment_methods": { telegram: ["sbp", "unknown", "stars"], web: ["unknown", "sbp"] },
  }), testTelegramRuntimeSettings);

  assert.deepEqual(await service.getPaymentMethods("ru", "telegram"), ["sbp", "stars"]);
  assert.deepEqual(await service.getPaymentMethods("ru", "web"), ["sbp"]);
  assert.deepEqual(await service.getPaymentMethods("en", "telegram"), ["stars"]);
  assert.deepEqual(await service.getPaymentMethods("en", "web"), []);
  assert.deepEqual(await service.getPaymentMethods("not_a_locale", "telegram"), ["stars"]);
  assert.deepEqual(await service.getPaymentMethods("not_a_locale", "web"), []);
});

test("bounded localization cache evicts old arbitrary namespaces", async () => {
  const store = new MemoryStore({
    "ru:one": { value: 1 },
    "ru:two": { value: 2 },
  });
  const service = new LocalizationService(store, testTelegramRuntimeSettings, 60_000, Date.now, 1);
  await service.getExactNamespace("ru", "one");
  await service.getExactNamespace("ru", "two");
  await service.getExactNamespace("ru", "one");
  assert.deepEqual(store.calls, ["ru:one", "ru:two", "ru:one"]);
});

test("missing required Russian text is an explicit configuration error", async () => {
  const service = new LocalizationService(
    new MemoryStore({ "ru:telegram": {} }),
    testTelegramRuntimeSettings,
  );
  await assert.rejects(() => service.getTelegramCopy("en"), { name: "ZodError" });
});
