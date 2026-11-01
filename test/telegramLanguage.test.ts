import test from "node:test";
import assert from "node:assert/strict";
import { parseTelegramLanguage } from "../src/telegramLanguage.js";

test("normalizes syntactically valid selector languages before DB policy validation", () => {
  assert.equal(parseTelegramLanguage("ru"), "ru");
  assert.equal(parseTelegramLanguage("en"), "en");
  assert.equal(parseTelegramLanguage("EN"), "en");
  assert.equal(parseTelegramLanguage("en-US"), "en-us");
  assert.equal(parseTelegramLanguage("uk"), "uk");
  assert.equal(parseTelegramLanguage("de"), "de");
  for (const value of [null, "", "_en", "en_US", 1]) {
    assert.equal(parseTelegramLanguage(value), null);
  }
});
