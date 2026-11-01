import test from "node:test";
import assert from "node:assert/strict";
import { parseTelegramLanguage } from "../src/telegramLanguage.js";

test("accepts only languages explicitly submitted by the selector", () => {
  assert.equal(parseTelegramLanguage("ru"), "ru");
  assert.equal(parseTelegramLanguage("en"), "en");
  for (const value of [null, "", "EN", "en-US", "uk", "de", 1]) {
    assert.equal(parseTelegramLanguage(value), null);
  }
});
