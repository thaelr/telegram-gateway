import type { WebMessage } from './types.js';

export type Publication = { id: string; title: string; body: string; published_at: string };
export type PublicationPage = { posts: Publication[]; next_before: string | null };
export type VotingCampaign = {
  id: string; title: string; selected_candidate_id: string | null;
  candidates: { id: string; name: string; description: string; image_url: string | null }[];
};
export type ChatSummary = {
  chat_code: string; last_message: WebMessage | null; unread_count: number;
  last_read_message_id: string | null;
};
export type LinkChallenge = {
  user_id: string; auth_user_id: string; expires_at: string;
  consumed_at: string | null; linked_user_id: string | null;
};
export interface WebFeaturesRepositoryContract {
  publications(userId: string, before?: string, limit?: number): Promise<PublicationPage>;
  voting(userId: string): Promise<{ campaign: VotingCampaign | null }>;
  castVote(userId: string, campaignId: string, candidateId: string): Promise<void>;
  summaries(userId: string): Promise<{ chats: ChatSummary[] }>;
  markRead(userId: string, code: string, messageId: string): Promise<{ last_read_message_id: string }>;
  telegramStatus(userId: string): Promise<{ linked: boolean; telegram_user_id: string | null }>;
  issueTelegramChallenge(userId: string, authUserId: string, hash: string): Promise<{ expires_at: string }>;
  telegramChallenge(userId: string, authUserId: string, hash: string): Promise<LinkChallenge>;
  completeTelegramLink(userId: string, authUserId: string, hash: string, telegramId: string, proofHash: string): Promise<{ linked: true; user_id: string }>;
}
