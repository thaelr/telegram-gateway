import { sql } from "./db.js";
import type {
  RewardClaimResult,
  RewardDefinition,
  RewardGrantClaimResult,
  RewardGrantResult,
} from "./rewardTypes.js";

type RewardQuery = typeof sql;

export class RewardRepository {
  constructor(private readonly query: RewardQuery = sql) {}

  async claimReward(input: {
    chatId: number;
    campaignId: string;
    rewards: RewardDefinition[];
  }): Promise<RewardClaimResult | null> {
    const rows = await this.query<RewardClaimResult[]>`
      SELECT *
      FROM public.claim_reward(
        ${input.chatId}::bigint,
        ${input.campaignId}::text,
        ${sql.json(input.rewards)}
      )
    `;

    return rows[0] ?? null;
  }

  async registerGrant(input: {
    chatId: number;
    slot: number;
    campaignId: string;
    rewards: RewardDefinition[];
    successText: string;
    nextAction: string | null;
  }): Promise<RewardGrantResult | null> {
    const rows = await this.query<RewardGrantResult[]>`
      SELECT *
      FROM public.register_reward_grant(
        ${input.chatId}::bigint,
        ${input.slot}::integer,
        ${input.campaignId}::text,
        ${sql.json(input.rewards)},
        ${input.successText}::text,
        ${input.nextAction}::text
      )
    `;
    return rows[0] ?? null;
  }

  async bindGrantMessage(input: {
    grantId: number;
    telegramMessageId: number;
  }): Promise<RewardGrantResult | null> {
    const rows = await this.query<RewardGrantResult[]>`
      SELECT *
      FROM public.bind_reward_grant_message(
        ${input.grantId}::bigint,
        ${input.telegramMessageId}::bigint
      )
    `;
    return rows[0] ?? null;
  }

  async claimRewardGrant(input: {
    chatId: number;
    slot: number;
    telegramMessageId: number | null;
  }): Promise<RewardGrantClaimResult | null> {
    const rows = await this.query<RewardGrantClaimResult[]>`
      SELECT *
      FROM public.claim_reward_grant(
        ${input.chatId}::bigint,
        ${input.slot}::integer,
        ${input.telegramMessageId}::bigint
      )
    `;
    return rows[0] ?? null;
  }
}
