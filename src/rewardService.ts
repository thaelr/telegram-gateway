import type { RewardRepository } from "./rewardRepository.js";
import type {
  RewardClaimResult,
  RewardDefinition,
  RewardGrantClaimResult,
  RewardSlot,
} from "./rewardTypes.js";

type RewardClaimRepository = Pick<
  RewardRepository,
  "claimReward" | "claimRewardGrant" | "registerGrant" | "bindGrantMessage"
>;

export class RewardService {
  constructor(
    private readonly repository: RewardClaimRepository,
    private readonly slots: RewardSlot[] = [],
  ) {}

  async claimReward(input: {
    chatId: number;
    campaignId: string;
    rewards?: RewardDefinition[];
    now?: Date;
  }): Promise<RewardClaimResult> {
    const configuredSlot = input.rewards
      ? null
      : this.findAvailableCampaign(input.campaignId, input.now ?? new Date());
    const rewards = input.rewards ?? configuredSlot?.rewards;
    if (!rewards) {
      throw new RewardUnavailableError();
    }

    const result = await this.repository.claimReward({
      chatId: input.chatId,
      campaignId: input.campaignId,
      rewards,
    });
    if (!result) {
      throw new Error("Reward claim returned no result");
    }
    return result;
  }

  async claimConfiguredSlot(input: {
    chatId: number;
    slot: number;
    telegramMessageId: number | null;
  }): Promise<RewardGrantClaimResult & {
    callback_answer_text: string;
    next_action: string | null;
    reward_slot: number;
  }> {
    const result = await this.repository.claimRewardGrant({
      chatId: input.chatId,
      slot: input.slot,
      telegramMessageId: input.telegramMessageId,
    });
    if (!result) {
      throw new Error("Granted reward claim returned no result");
    }

    return {
      ...result,
      callback_answer_text:
        result.status === "claimed"
          ? result.success_text ?? "Подарок активирован"
          : result.status === "already_claimed"
            ? "Подарок уже активирован"
            : "Подарок недоступен",
      next_action: result.status === "not_eligible" ? null : result.next_action,
      reward_slot: input.slot,
    };
  }

  async assignConfiguredSlot(input: {
    chatId: number;
    slot: number;
    now?: Date;
  }) {
    const slot = this.findAvailableSlot(input.slot, input.now ?? new Date());
    if (!slot) {
      throw new RewardUnavailableError();
    }
    const result = await this.repository.registerGrant({
      chatId: input.chatId,
      slot: slot.slot,
      campaignId: slot.campaign_id,
      rewards: slot.rewards,
      successText: slot.success_text,
      nextAction: slot.next_action ?? null,
    });
    if (!result) {
      throw new Error("Reward grant registration returned no result");
    }
    return result;
  }

  async bindGrantMessage(input: {
    grantId: number;
    telegramMessageId: number;
  }) {
    const result = await this.repository.bindGrantMessage(input);
    if (!result) {
      throw new RewardUnavailableError();
    }
    return result;
  }

  private findAvailableSlot(slotNumber: number, now: Date): RewardSlot | null {
    return this.slots.find((slot) =>
      slot.slot === slotNumber
      && slot.enabled
      && (!slot.valid_from || now >= new Date(slot.valid_from))
      && (!slot.valid_until || now <= new Date(slot.valid_until))) ?? null;
  }

  private findAvailableCampaign(campaignId: string, now: Date): RewardSlot | null {
    return this.slots.find((slot) =>
      slot.campaign_id === campaignId
      && slot.enabled
      && (!slot.valid_from || now >= new Date(slot.valid_from))
      && (!slot.valid_until || now <= new Date(slot.valid_until))) ?? null;
  }
}

export class RewardUnavailableError extends Error {
  constructor() {
    super("Reward is unavailable");
    this.name = "RewardUnavailableError";
  }
}
