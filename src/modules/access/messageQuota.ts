import type { sql } from '../../db.js';

type DB = Pick<typeof sql, 'unsafe'>;

export async function loadDailyMessageUsage(db: DB, userId: string, timeZone: string, acceptedAt: string | null = null): Promise<number> {
  const [row] = await db.unsafe<Array<{ used: number }>>(`
    SELECT count(*)::integer AS used FROM app_private.message_admissions
    WHERE user_id=$1
      AND accepted_at >= (date_trunc('day', COALESCE($3::timestamptz, statement_timestamp()) AT TIME ZONE $2) AT TIME ZONE $2)
      AND accepted_at < ((date_trunc('day', COALESCE($3::timestamptz, statement_timestamp()) AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2)
  `, [userId, timeZone, acceptedAt]);
  return Number(row?.used ?? 0);
}

// Caller supplies its current transaction: Web admission and web_operations insert
// commit together; Telegram supplies a short transaction before the existing Router.
export async function admitMessage(
  db: DB,
  userId: string,
  chatId: number,
  source: 'telegram' | 'web',
  messageKey: string,
  timeZone: string,
  limit: number,
): Promise<{ allowed: boolean; turnsToday: number; subscriptionActive: boolean; sceneAccessActive: boolean }> {
  if (!messageKey) throw new Error('Message admission requires a stable ingress identifier');
  // Preserve the existing chat -> account ordering. Take the quota lock last;
  // another channel can hold a different chat lock while waiting for this user.
  const chat = await db.unsafe(`SELECT chat_id FROM public.chat_state WHERE chat_id=$1 AND user_id=$2 FOR SHARE`, [chatId, userId]);
  if (!chat.length) throw new Error('Message admission chat owner changed');
  await db.unsafe(`SELECT user_id FROM public.users WHERE user_id=$1 FOR SHARE`, [userId]);
  await db.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, ['message-quota:' + userId]);
  // Separate statements after the lock use a fresh READ COMMITTED snapshot.
  const [rights] = await db.unsafe<Array<{ subscription_active: boolean; scene_access_active: boolean; accepted_at: string }>>(`
    SELECT statement_timestamp()::text AS accepted_at, COALESCE(u.subscription_until>statement_timestamp(),false) AS subscription_active,
      COALESCE((SELECT e.scene_access_active FROM app_private.scene_entitlements(c.chat_id,c.active_scene_session_id) e),false) AS scene_access_active
    FROM public.chat_state c JOIN public.users u ON u.user_id=c.user_id WHERE c.chat_id=$1 AND u.user_id=$2
  `, [chatId, userId]);
  const subscriptionActive = rights?.subscription_active === true;
  const sceneAccessActive = rights?.scene_access_active === true;
  const existing = await db.unsafe(`SELECT 1 FROM app_private.message_admissions WHERE source=$1 AND message_key=$2`, [source, messageKey]);
  const turnsToday = await loadDailyMessageUsage(db, userId, timeZone, rights!.accepted_at);
  // A previously admitted event stays admitted after a day change or cap expiry.
  if (existing.length) return { allowed: true, turnsToday, subscriptionActive, sceneAccessActive };
  if (!subscriptionActive && !sceneAccessActive && turnsToday >= limit) {
    return { allowed: false, turnsToday, subscriptionActive, sceneAccessActive };
  }
  await db.unsafe(`INSERT INTO app_private.message_admissions(user_id,chat_id,source,message_key,accepted_at) VALUES($1,$2,$3,$4,$5::timestamptz)`, [userId, chatId, source, messageKey, rights!.accepted_at]);
  return { allowed: true, turnsToday: turnsToday + 1, subscriptionActive, sceneAccessActive };
}
