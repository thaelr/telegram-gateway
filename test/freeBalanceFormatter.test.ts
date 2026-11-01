import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFreeBalances,
  prependFreeBalances,
} from "../src/freeBalanceFormatter.js";

const copy = {
  heading: "🎁 У тебя есть:",
  scene_unlock: {
    one: "{count} бесплатная разблокировка сцены",
    few: "{count} бесплатные разблокировки сцены",
    many: "{count} бесплатных разблокировок сцены",
  },
  photo: {
    one: "{count} бесплатное фото",
    few: "{count} бесплатных фото",
    many: "{count} бесплатных фото",
  },
  fast_scene_skip: {
    one: "{count} бесплатный пропуск сцены",
    few: "{count} бесплатных пропуска сцены",
    many: "{count} бесплатных пропусков сцены",
  },
};

test("free balance formatter omits the gift block when every balance is zero", () => {
  assert.equal(formatFreeBalances({
    free_scene_unlocks: 0,
    free_photo_unlocks: 0,
    free_fast_scene_skips: 0,
  }), null);
});

test("free balance formatter renders exactly one positive balance", () => {
  assert.equal(formatFreeBalances({ free_photo_unlocks: 1 }, copy), [
    "🎁 У тебя есть:",
    "• 1 бесплатное фото",
  ].join("\n"));
});

test("free balance formatter renders every positive balance and omits zero values", () => {
  assert.equal(formatFreeBalances({
    free_scene_unlocks: 3,
    free_photo_unlocks: 5,
    free_fast_scene_skips: 2,
  }, copy), [
    "🎁 У тебя есть:",
    "• 3 бесплатные разблокировки сцены",
    "• 5 бесплатных фото",
    "• 2 бесплатных пропуска сцены",
  ].join("\n"));
});

test("free balance formatter prepends the gift block to subscription text", () => {
  assert.equal(prependFreeBalances("Подписка активна", {
    free_scene_unlocks: 1,
  }, copy), [
    "🎁 У тебя есть:",
    "• 1 бесплатная разблокировка сцены",
    "",
    "Подписка активна",
  ].join("\n"));
});
