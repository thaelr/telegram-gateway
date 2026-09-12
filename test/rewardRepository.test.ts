import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

process.env.NODE_ENV = "test";
installTestEnv();
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON = JSON.stringify([{
  sku: "payment_plan_1", days: 7, amount_xtr: 100,
  title: "text", description: "text", label: "text", button_text: "text",
}]);
process.env.MEDIA_PHOTO_PLANS_JSON = JSON.stringify([{
  sku: "payment_media_1", amount_xtr: 10,
  title: "text", description: "text", label: "text", button_text: "text",
}]);
process.env.MEDIA_ACTION_PLANS_JSON = JSON.stringify([{
  sku: "payment_action_1", feature_key: "scene_unlock", amount_xtr: 50,
  title: "text", description: "text", label: "text", button_text: "text",
}]);

const { RewardRepository } = await import("../src/rewardRepository.js");

test("claimReward delegates all reward types to the atomic database function", async () => {
  const calls: string[] = [];
  const query = Object.assign(
    async (strings: TemplateStringsArray) => {
      calls.push(strings.join("?"));
      return [{
        chat_id: 42,
        campaign_id: "campaign-1",
        status: "claimed",
        free_scene_unlocks: 1,
        free_fast_scene_skips: 2,
        free_photo_unlocks: 3,
        subscription_until: null,
      }];
    },
    { json: (value: unknown) => value },
  );
  const repository = new RewardRepository(query as never);

  const response = await repository.claimReward({
    chatId: 42,
    campaignId: "campaign-1",
    rewards: [
      { type: "scene_unlock", amount: 1 },
      { type: "scene_skip", amount: 2 },
      { type: "photo_unlock", amount: 3 },
      { type: "subscription", days: 5 },
    ],
  });

  assert.equal(response?.status, "claimed");
  assert.match(calls[0] ?? "", /public\.claim_reward/u);
});

test("reward grant repository snapshots, binds, and claims by callback identity", async () => {
  const calls: string[] = [];
  const query = Object.assign(
    async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      calls.push(statement);
      if (statement.includes("register_reward_grant") || statement.includes("bind_reward_grant_message")) {
        return [{
          grant_id: 10,
          chat_id: 42,
          slot: 1,
          campaign_id: "campaign-1",
          status: "assigned",
          assigned_at: "2026-09-12T00:00:00Z",
          claimed_at: null,
          telegram_message_id: statement.includes("bind_reward_grant_message") ? 100 : null,
        }];
      }
      return [{
        grant_id: 10,
        chat_id: 42,
        slot: 1,
        campaign_id: "campaign-1",
        telegram_message_id: 100,
        status: "claimed",
        free_scene_unlocks: 1,
        free_fast_scene_skips: 0,
        free_photo_unlocks: 0,
        subscription_until: null,
        success_text: "Gift claimed",
        next_action: "show_character_gallery",
      }];
    },
    { json: (value: unknown) => value },
  );
  const repository = new RewardRepository(query as never);

  const grant = await repository.registerGrant({
    chatId: 42,
    slot: 1,
    campaignId: "campaign-1",
    rewards: [{ type: "scene_unlock", amount: 1 }],
    successText: "Gift claimed",
    nextAction: "show_character_gallery",
  });
  const bound = await repository.bindGrantMessage({
    grantId: 10,
    telegramMessageId: 100,
  });
  const claim = await repository.claimRewardGrant({
    chatId: 42,
    slot: 1,
    telegramMessageId: 100,
  });

  assert.equal(grant?.grant_id, 10);
  assert.equal(grant?.campaign_id, "campaign-1");
  assert.equal(bound?.telegram_message_id, 100);
  assert.equal(claim?.status, "claimed");
  assert.match(calls[0] ?? "", /public\.register_reward_grant/u);
  assert.match(calls[1] ?? "", /public\.bind_reward_grant_message/u);
  assert.match(calls[2] ?? "", /public\.claim_reward_grant/u);
});
