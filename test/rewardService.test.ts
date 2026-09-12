import test from "node:test";
import assert from "node:assert/strict";
import { RewardService, RewardUnavailableError } from "../src/rewardService.js";
import type {
  RewardClaimResult,
  RewardDefinition,
  RewardGrantClaimResult,
  RewardSlot,
} from "../src/rewardTypes.js";

const claimResult = (status: RewardClaimResult["status"]): RewardClaimResult => ({
  chat_id: 42,
  campaign_id: "campaign-a",
  status,
  free_scene_unlocks: 2,
  free_fast_scene_skips: 3,
  free_photo_unlocks: 4,
  subscription_until: "2026-09-20T00:00:00Z",
});

const grantClaimResult = (
  status: RewardClaimResult["status"],
  overrides: Partial<RewardGrantClaimResult> = {},
): RewardGrantClaimResult => ({
  ...claimResult(status),
  grant_id: 10,
  slot: 1,
  telegram_message_id: 100,
  success_text: "Gift A claimed",
  next_action: "show_character_gallery",
  ...overrides,
});

const slot: RewardSlot = {
  slot: 1,
  campaign_id: "campaign-a",
  enabled: true,
  valid_from: "2026-09-01T00:00:00Z",
  valid_until: "2026-09-30T23:59:59Z",
  rewards: [
    { type: "scene_unlock", amount: 2 },
    { type: "scene_skip", amount: 3 },
    { type: "photo_unlock", amount: 4 },
    { type: "subscription", days: 5 },
  ],
  success_text: "Gift A claimed",
  next_action: "show_character_gallery",
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    async claimReward() { return claimResult("claimed"); },
    async claimRewardGrant() { return grantClaimResult("claimed"); },
    async registerGrant() {
      return {
        grant_id: 10,
        chat_id: 42,
        slot: 1,
        campaign_id: "campaign-a",
        status: "assigned" as const,
        assigned_at: "2026-09-12T00:00:00Z",
        claimed_at: null,
        telegram_message_id: null,
      };
    },
    async bindGrantMessage() {
      return {
        grant_id: 10,
        chat_id: 42,
        slot: 1,
        campaign_id: "campaign-a",
        status: "assigned" as const,
        assigned_at: "2026-09-12T00:00:00Z",
        claimed_at: null,
        telegram_message_id: 100,
      };
    },
    ...overrides,
  };
}

test("claimReward resolves backend campaign rewards without Telegram callback context", async () => {
  let received: { chatId: number; campaignId: string; rewards: RewardDefinition[] } | null = null;
  const service = new RewardService(repository({
    async claimReward(input: { chatId: number; campaignId: string; rewards: RewardDefinition[] }) {
      received = input;
      return claimResult("claimed");
    },
  }), [slot]);

  const claimed = await service.claimReward({ chatId: 42, campaignId: "campaign-a" });

  assert.equal(claimed.status, "claimed");
  assert.deepEqual(received, {
    chatId: 42,
    campaignId: "campaign-a",
    rewards: slot.rewards,
  });
});

test("grant creation snapshots the current Railway slot config", async () => {
  let received: unknown = null;
  const service = new RewardService(repository({
    async registerGrant(input: unknown) {
      received = input;
      return repository().registerGrant();
    },
  }), [slot]);

  const result = await service.assignConfiguredSlot({
    chatId: 42,
    slot: 1,
    now: new Date("2026-09-12T00:00:00Z"),
  });

  assert.equal(result.grant_id, 10);
  assert.deepEqual(received, {
    chatId: 42,
    slot: 1,
    campaignId: "campaign-a",
    rewards: slot.rewards,
    successText: "Gift A claimed",
    nextAction: "show_character_gallery",
  });
});

test("callback resolves campaign A and B snapshots only by their message ids", async () => {
  const calls: unknown[] = [];
  const service = new RewardService(repository({
    async claimRewardGrant(input: { chatId: number; slot: number; telegramMessageId: number | null }) {
      calls.push(input);
      return input.telegramMessageId === 100
        ? grantClaimResult("claimed")
        : grantClaimResult("claimed", {
          grant_id: 20,
          campaign_id: "campaign-b",
          telegram_message_id: 200,
          success_text: "Gift B claimed",
          next_action: null,
        });
    },
  }), [{ ...slot, campaign_id: "current-railway-campaign-b" }]);

  const a = await service.claimConfiguredSlot({ chatId: 42, slot: 1, telegramMessageId: 100 });
  const b = await service.claimConfiguredSlot({ chatId: 42, slot: 1, telegramMessageId: 200 });

  assert.deepEqual(calls, [
    { chatId: 42, slot: 1, telegramMessageId: 100 },
    { chatId: 42, slot: 1, telegramMessageId: 200 },
  ]);
  assert.equal(a.campaign_id, "campaign-a");
  assert.equal(a.callback_answer_text, "Gift A claimed");
  assert.equal(a.next_action, "show_character_gallery");
  assert.equal(b.campaign_id, "campaign-b");
  assert.equal(b.callback_answer_text, "Gift B claimed");
});

test("an issued grant remains claimable after Railway config is removed", async () => {
  const service = new RewardService(repository(), []);
  const result = await service.claimConfiguredSlot({
    chatId: 42,
    slot: 1,
    telegramMessageId: 100,
  });
  assert.equal(result.status, "claimed");
  assert.equal(result.campaign_id, "campaign-a");
});

test("unknown or mismatched callback identity reports not eligible", async () => {
  const service = new RewardService(repository({
    async claimRewardGrant(input: { chatId: number; slot: number; telegramMessageId: number | null }) {
      return grantClaimResult("not_eligible", {
        grant_id: null,
        campaign_id: null,
        slot: input.slot,
        telegram_message_id: input.telegramMessageId,
        success_text: null,
        next_action: null,
      });
    },
  }), []);

  for (const input of [
    { chatId: 42, slot: 1, telegramMessageId: 999 },
    { chatId: 43, slot: 1, telegramMessageId: 100 },
    { chatId: 42, slot: 2, telegramMessageId: 100 },
    { chatId: 42, slot: 1, telegramMessageId: null },
  ]) {
    const response = await service.claimConfiguredSlot(input);
    assert.equal(response.status, "not_eligible");
    assert.equal(response.callback_answer_text, "Подарок недоступен");
    assert.equal(response.next_action, null);
  }
});

test("repeat claim uses idempotent status without reading Railway config", async () => {
  const service = new RewardService(repository({
    async claimRewardGrant() { return grantClaimResult("already_claimed"); },
  }), []);
  const result = await service.claimConfiguredSlot({
    chatId: 42,
    slot: 1,
    telegramMessageId: 100,
  });
  assert.equal(result.status, "already_claimed");
  assert.equal(result.callback_answer_text, "Подарок уже активирован");
});

test("bindGrantMessage delegates grant and Telegram message identifiers", async () => {
  let received: unknown = null;
  const service = new RewardService(repository({
    async bindGrantMessage(input: unknown) {
      received = input;
      return repository().bindGrantMessage();
    },
  }), []);
  const result = await service.bindGrantMessage({ grantId: 10, telegramMessageId: 100 });
  assert.deepEqual(received, { grantId: 10, telegramMessageId: 100 });
  assert.equal(result.telegram_message_id, 100);
});

test("disabled, future, expired, and unknown reward templates cannot create new grants", async () => {
  for (const candidate of [
    { ...slot, enabled: false },
    { ...slot, valid_from: "2026-09-13T00:00:00Z" },
    { ...slot, valid_until: "2026-09-11T23:59:59Z" },
  ]) {
    const service = new RewardService(repository(), [candidate]);
    await assert.rejects(
      service.assignConfiguredSlot({
        chatId: 42,
        slot: 1,
        now: new Date("2026-09-12T00:00:00Z"),
      }),
      RewardUnavailableError,
    );
  }

  await assert.rejects(
    new RewardService(repository(), [slot]).claimReward({ chatId: 42, campaignId: "unknown" }),
    RewardUnavailableError,
  );
});
