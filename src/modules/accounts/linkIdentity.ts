import { sql } from '../../db.js';
import { WebError } from '../../web/types.js';
import type { LinkChallenge } from '../../web/featuresTypes.js';
import { businessResult } from '../../web/featureResult.js';
type Row = Record<string, any>;
type DB = Pick<typeof sql, 'unsafe'>;
export async function telegramStatus(query: typeof sql, userId: string) {
    const identity = (await query.unsafe<Row[]>("SELECT external_id FROM public.user_identities WHERE user_id=$1 AND provider='telegram' ORDER BY linked_at LIMIT 1", [userId]))[0];
    return { linked: Boolean(identity), telegram_user_id: identity?.external_id ?? null };
  }

export async function issueTelegramChallenge(query: typeof sql, userId: string, authUserId: string, hash: string) {
    const result = (await query.unsafe<Row[]>(`INSERT INTO app_private.web_telegram_link_challenges(challenge_hash,user_id,auth_user_id,expires_at)
      SELECT $3::text,$1::varchar,$2::text,now()+interval '10 minutes' WHERE EXISTS(SELECT 1 FROM public.user_identities WHERE user_id=$1::varchar AND provider='supabase' AND external_id=$2::text)
      RETURNING expires_at::text`, [userId, authUserId, hash]))[0];
    if (!result) throw new WebError(401, 'account_not_found');
    return { expires_at: new Date(result.expires_at).toISOString() };
  }

export async function telegramChallenge(query: typeof sql, userId: string, authUserId: string, hash: string): Promise<LinkChallenge> {
    const challenge = (await query.unsafe<Row[]>(`SELECT user_id,auth_user_id,expires_at::text,consumed_at::text,linked_user_id
      FROM app_private.web_telegram_link_challenges WHERE challenge_hash=$1 AND auth_user_id=$2
      AND (user_id=$3 OR (consumed_at IS NOT NULL AND linked_user_id=$3))`, [hash, authUserId, userId]))[0];
    if (!challenge || (!challenge.consumed_at && Date.parse(challenge.expires_at) <= Date.now())) throw new WebError(410, 'telegram_link_expired');
    return challenge as LinkChallenge;
  }

export async function completeTelegramLink(query: typeof sql, userId: string, authUserId: string, hash: string, telegramId: string, proofHash: string) {
    let row: Row | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      row = (await query.unsafe<Row[]>('SELECT app_private.web_complete_telegram_link($1::varchar,$2::text,$3::text,$4::text,$5::text) AS result',
        [userId, authUserId, hash, telegramId, proofHash]))[0];
      if (row?.result?.code !== 'account_busy' || attempt === 2) break;
      // SQL explicitly reports this only before any state change. Preserve proof.
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
    const result = businessResult(row);
    if (result.status !== 'linked' || typeof result.user_id !== 'string') throw new WebError(500, 'internal_error');
    return { linked: true as const, user_id: result.user_id };
  }
