import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTelegramLanguage,
  normalizeTelegramLanguageCode,
} from "../src/telegramLanguage.js";

test("keeps supported Telegram languages", () => {
  assert.equal(normalizeTelegramLanguageCode("ru"), "ru");
  assert.equal(normalizeTelegramLanguageCode("en"), "en");
  assert.equal(normalizeTelegramLanguageCode("EN_us"), "en");
});

test("maps CIS language codes to Russian", () => {
  for (const languageCode of ["uk", "be", "kk", "ky", "uz", "tg", "tk", "hy", "az", "ka"]) {
    assert.equal(normalizeTelegramLanguageCode(languageCode), "ru");
  }
});

test("maps other unsupported languages to English", () => {
  assert.equal(normalizeTelegramLanguageCode("de"), "en");
  assert.equal(normalizeTelegramLanguageCode("fr-FR"), "en");
});

test("does not infer a language when Telegram omitted it", () => {
  assert.equal(normalizeTelegramLanguageCode(null), null);
  assert.equal(normalizeTelegramLanguageCode("  "), null);
  assert.equal(extractTelegramLanguage({ message: { from: { id: 202 } } }, 202), null);
});

test("extracts the language from supported Telegram update shapes", () => {
  const updates = [
    { message: { from: { id: 202, language_code: "ru" } } },
    { callback_query: { from: { id: 202, language_code: "en" } } },
    { pre_checkout_query: { from: { id: 202, language_code: "uk" } } },
    { my_chat_member: { from: { id: 202, language_code: "de" } } },
  ];

  assert.deepEqual(
    updates.map((update) => extractTelegramLanguage(update, 202)),
    ["ru", "en", "ru", "en"],
  );
});

test("ignores a language belonging to a different Telegram user", () => {
  assert.equal(
    extractTelegramLanguage(
      { message: { from: { id: 999, language_code: "ru" } } },
      202,
    ),
    null,
  );
});
