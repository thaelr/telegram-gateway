import { sql } from '../db.js';
import { WebError, type WebRepositoryContract } from './types.js';
import { WEB_HISTORY_CTE } from './history.js';
import type { LinkChallenge, PublicationPage, VotingCampaign, WebFeaturesRepositoryContract } from './featuresTypes.js';

type Row = Record<string, any>;
type DB = Pick<typeof sql, 'unsafe'>;
async function rows(db: DB, query: string, values: (string | number | null)[] = []): Promise<Row[]> {
  return db.unsafe(query, values);
}
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const localized = (column: string, parameter: string) => `COALESCE(NULLIF(${column}->>${parameter},''),NULLIF(${column}->>'ru',''),NULLIF(${column}->>'en',''),'')`;
function businessResult(row: Row | undefined): Record<string, any> {
  const result = row?.result;
  if (!result || typeof result !== 'object') throw new WebError(500, 'internal_error');
  if (result.status === 'error') {
    const codes: Record<string, [number, string]> = {
      campaign_not_active: [409, 'campaign_not_active'], candidate_not_found: [404, 'candidate_not_found'],
      vote_conflict: [409, 'vote_conflict'], account_not_found: [401, 'account_not_found'],
      telegram_link_expired: [410, 'telegram_link_expired'], telegram_link_used: [409, 'telegram_link_used'],
      telegram_identity_conflict: [409, 'telegram_account_conflict'], telegram_proof_reused: [409, 'telegram_proof_reused'],
      subscription_conflict: [409, 'subscription_conflict'], identity_conflict: [409, 'identity_conflict'],
      account_busy: [409, 'account_busy'],
    };
    const [status, code] = codes[String(result.code)] ?? [500, 'internal_error'];
    throw new WebError(status, code);
  }
  return result;
}

export class WebFeaturesRepository implements WebFeaturesRepositoryContract {
  constructor(private readonly repository: WebRepositoryContract, private readonly query: typeof sql = sql) {}

  async publications(userId: string, before?: string, limit = 30): Promise<PublicationPage> {
    const locale = (await this.repository.getMe(userId)).language ?? 'ru';
    let stamp: string | null = null, id = '9223372036854775807';
    if (before) {
      try {
        const tuple = JSON.parse(Buffer.from(before, 'base64url').toString());
        if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string'
          || !Number.isFinite(Date.parse(tuple[0])) || typeof tuple[1] !== 'string'
          || !/^\d{1,19}$/.test(tuple[1]) || BigInt(tuple[1]) > 9223372036854775807n) throw new Error();
        [stamp, id] = tuple;
      } catch { throw new WebError(400, 'invalid_publication_cursor'); }
    }
    const found = await rows(this.query, `SELECT id::text,${localized('title_translations', '$1')} AS title,
      ${localized('body_translations', '$1')} AS body,published_at::text
      FROM app_private.web_publications WHERE published_at<=now()
      AND ($2::text::timestamptz IS NULL OR (published_at,id)<($2::text::timestamptz,$3::bigint))
      ORDER BY published_at DESC,id DESC LIMIT $4`, [locale, stamp, id, limit + 1]);
    const page = found.slice(0, limit), last = page.at(-1);
    return {
      posts: page.map(post => ({ id: post.id, title: post.title, body: post.body, published_at: iso(post.published_at) })),
      next_before: found.length > limit && last ? Buffer.from(JSON.stringify([last.published_at, last.id])).toString('base64url') : null,
    };
  }

  async voting(userId: string): Promise<{ campaign: VotingCampaign | null }> {
    const locale = (await this.repository.getMe(userId)).language ?? 'ru';
    const campaign = (await rows(this.query, `SELECT campaign_id::text,${localized('title_translations', '$2')} AS title,
      (SELECT candidate_id::text FROM mp_campaign.votes v WHERE v.campaign_id=c.campaign_id AND v.user_id=$1) AS selected_candidate_id
      FROM mp_campaign.voting_campaigns c WHERE status='active' AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())
      ORDER BY starts_at DESC,campaign_id LIMIT 1`, [userId, locale]))[0];
    if (!campaign) return { campaign: null };
    const candidates = await rows(this.query, `SELECT candidate_id::text AS id,
      ${localized('name_translations', '$2')} AS name,${localized('description_translations', '$2')} AS description,image_url
      FROM mp_campaign.voting_candidates WHERE campaign_id=$1::uuid ORDER BY sort_order,candidate_id`, [campaign.campaign_id, locale]);
    return { campaign: { id: campaign.campaign_id, title: campaign.title, selected_candidate_id: campaign.selected_candidate_id,
      candidates: candidates.map(candidate => ({ id: candidate.id, name: candidate.name, description: candidate.description, image_url: candidate.image_url })) } };
  }

  async castVote(userId: string, campaignId: string, candidateId: string): Promise<void> {
    businessResult((await rows(this.query, 'SELECT mp_campaign.web_vote($1::varchar,$2::uuid,$3::uuid) AS result', [userId, campaignId, candidateId]))[0]);
  }

  async summaries(userId: string) {
    if (!this.repository.listChatSummaries) throw new WebError(503, 'chat_summaries_unavailable');
    const chats = await this.repository.listChatSummaries(userId);
    return { chats: chats.map(chat => ({ chat_code: chat.chat_code, last_message: chat.last_message ?? null,
      unread_count: chat.unread_count ?? 0, last_read_message_id: chat.last_read_message_id ?? null })) };
  }

  async markRead(userId: string, code: string, messageId: string) {
    return this.query.begin(async tx => {
      const chat = (await rows(tx, 'SELECT chat_id FROM public.chat_state WHERE user_id=$1 AND chat_code=$2 AND is_active FOR SHARE', [userId, code]))[0];
      if (!chat) throw new WebError(404, 'chat_not_found');
      const message = (await rows(tx, `${WEB_HISTORY_CTE} SELECT id,created_at::text AS created_at FROM history WHERE id=$2`, [String(chat.chat_id), messageId]))[0];
      if (!message) throw new WebError(404, 'message_not_found');
      await rows(tx, `INSERT INTO app_private.web_activity(chat_id,last_read_at,last_read_message_id)
        VALUES($1,$2::text::timestamptz,$3) ON CONFLICT(chat_id) DO UPDATE
        SET last_read_at=EXCLUDED.last_read_at,last_read_message_id=EXCLUDED.last_read_message_id
        WHERE (COALESCE(web_activity.last_read_at,'-infinity'::timestamptz),COALESCE(web_activity.last_read_message_id,''))<(EXCLUDED.last_read_at,EXCLUDED.last_read_message_id)`,
      [String(chat.chat_id), message.created_at, message.id]);
      const current = (await rows(tx, 'SELECT last_read_message_id FROM app_private.web_activity WHERE chat_id=$1', [String(chat.chat_id)]))[0]!;
      return { last_read_message_id: String(current.last_read_message_id) };
    });
  }

  async telegramStatus(userId: string) {
    const identity = (await rows(this.query, "SELECT external_id FROM public.user_identities WHERE user_id=$1 AND provider='telegram' ORDER BY linked_at LIMIT 1", [userId]))[0];
    return { linked: Boolean(identity), telegram_user_id: identity?.external_id ?? null };
  }

  async issueTelegramChallenge(userId: string, authUserId: string, hash: string) {
    const result = (await rows(this.query, `INSERT INTO app_private.web_telegram_link_challenges(challenge_hash,user_id,auth_user_id,expires_at)
      SELECT $3::text,$1::varchar,$2::text,now()+interval '10 minutes' WHERE EXISTS(SELECT 1 FROM public.user_identities WHERE user_id=$1::varchar AND provider='supabase' AND external_id=$2::text)
      RETURNING expires_at::text`, [userId, authUserId, hash]))[0];
    if (!result) throw new WebError(401, 'account_not_found');
    return { expires_at: iso(result.expires_at) };
  }

  async telegramChallenge(userId: string, authUserId: string, hash: string): Promise<LinkChallenge> {
    const challenge = (await rows(this.query, `SELECT user_id,auth_user_id,expires_at::text,consumed_at::text,linked_user_id
      FROM app_private.web_telegram_link_challenges WHERE challenge_hash=$1 AND auth_user_id=$2
      AND (user_id=$3 OR (consumed_at IS NOT NULL AND linked_user_id=$3))`, [hash, authUserId, userId]))[0];
    if (!challenge || (!challenge.consumed_at && Date.parse(challenge.expires_at) <= Date.now())) throw new WebError(410, 'telegram_link_expired');
    return challenge as LinkChallenge;
  }

  async completeTelegramLink(userId: string, authUserId: string, hash: string, telegramId: string, proofHash: string) {
    let row: Row | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      row = (await rows(this.query,
        'SELECT app_private.web_complete_telegram_link($1::varchar,$2::text,$3::text,$4::text,$5::text) AS result',
        [userId, authUserId, hash, telegramId, proofHash]))[0];
      if (row?.result?.code !== 'account_busy' || attempt === 2) break;
      // SQL explicitly reports this only before any state change. Preserve proof.
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
    const result = businessResult(row);
    if (result.status !== 'linked' || typeof result.user_id !== 'string') throw new WebError(500, 'internal_error');
    return { linked: true as const, user_id: result.user_id };
  }
}
