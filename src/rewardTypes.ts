export type CreditRewardType = "scene_unlock" | "scene_skip" | "photo_unlock";

export type RewardDefinition =
  | { type: CreditRewardType; amount: number }
  | { type: "subscription"; days: number };

export type RewardSlot = {
  slot: number;
  campaign_id: string;
  enabled: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
  rewards: RewardDefinition[];
  success_text: string;
  already_claimed_text?: string;
  next_action?: string | null;
};

export type RewardClaimStatus = "claimed" | "already_claimed" | "not_eligible";

export type RewardClaimResult = {
  chat_id: number;
  campaign_id: string;
  status: RewardClaimStatus;
  free_scene_unlocks: number;
  free_fast_scene_skips: number;
  free_photo_unlocks: number;
  subscription_until: string | null;
};

export type RewardGrantClaimResult = Omit<RewardClaimResult, "campaign_id"> & {
  campaign_id: string | null;
  grant_id: number | null;
  slot: number;
  telegram_message_id: number | null;
  success_text: string | null;
  next_action: string | null;
};

export type RewardGrantResult = {
  grant_id: number;
  chat_id: number;
  slot: number;
  campaign_id: string;
  status: "assigned" | "already_assigned" | "claimed";
  assigned_at: string;
  claimed_at: string | null;
  telegram_message_id: number | null;
};
