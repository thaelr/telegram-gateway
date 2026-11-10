import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { admitMessage, loadDailyMessageUsage } from '../src/modules/access/messageQuota.js';

const url = process.env.TEST_DATABASE_URL;

test('daily message admission is shared, durable and atomic across channels', { skip: !url }, async () => {
  const target = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('test'), 'Dedicated local test database required');
  const db = postgres(url!, { max: 6, prepare: false, onnotice: () => {} });
  const [user] = await db`INSERT INTO public.users(display_name) VALUES('Neutral quota fixture') RETURNING user_id`;
  const chats = await db`INSERT INTO public.chat_state(user_id,character_i,source,selected_character_i)
    VALUES(${user!.user_id},1,'web',1),(${user!.user_id},2,'web',2) RETURNING chat_id`;
  const userId = String(user!.user_id), first = Number(chats[0]!.chat_id), second = Number(chats[1]!.chat_id);
  const key = () => randomUUID();
  const admit = (chat: number, source: 'telegram' | 'web', id: string, limit: number) =>
    db.begin(tx => admitMessage(tx, userId, chat, source, id, 'Europe/Moscow', limit));
  try {
    const ids = [key(), key(), key()];
    for (const id of ids) assert.equal((await admit(first, 'telegram', id, 3)).allowed, true);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 3);
    assert.equal((await db`SELECT count(*)::int AS n FROM public.chat_turns WHERE chat_id=${first}`)[0]!.n, 0);
    assert.equal((await admit(second, 'web', key(), 3)).allowed, false);
    assert.equal((await admit(first, 'telegram', ids[0]!, 3)).allowed, true);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 3);

    // Receipt is not charged again on a different business day, even at cap=0.
    await db`UPDATE app_private.message_admissions SET accepted_at=now()-interval '2 days' WHERE user_id=${userId}`;
    assert.equal((await admit(first, 'telegram', ids[0]!, 0)).allowed, true);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 0);

    const competing = await Promise.all([
      admit(first, 'telegram', key(), 1),
      admit(second, 'web', key(), 1),
    ]);
    assert.equal(competing.filter(result => result.allowed).length, 1);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 1);

    // A failed enqueue must roll back its receipt together with the operation.
    await assert.rejects(db.begin(async tx => {
      assert.equal((await admitMessage(tx, userId, second, 'web', key(), 'Europe/Moscow', 2)).allowed, true);
      throw new Error('synthetic enqueue rollback');
    }), /synthetic enqueue rollback/);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 1);

    // Existing paid exemptions are unchanged; the accepted message still counts.
    await db`UPDATE public.users SET subscription_sku='neutral',subscription_until=now()+interval '1 day' WHERE user_id=${userId}`;
    assert.equal((await admit(second, 'web', key(), 1)).allowed, true);
    assert.equal(await loadDailyMessageUsage(db, userId, 'Europe/Moscow'), 2);
    await db`UPDATE public.users SET subscription_until=now()-interval '1 day' WHERE user_id=${userId}`;
    assert.equal((await admit(first, 'telegram', key(), 1)).allowed, false);

    // A purchased scene exemption belongs to that dialogue, but its accepted
    // messages still contribute to the account's shared daily usage.
    const scene=key(),token=key();
    await db`INSERT INTO public.chat_scene_sessions(chat_id,character_i,scene_session_id) VALUES(${second},2,${scene})`;
    await db`UPDATE public.chat_state SET active_scene_session_id=${scene} WHERE chat_id=${second}`;
    await db`INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,status,sku,action_kind,payload_json,payment_source,currency,amount,paid_at)
      VALUES(${token},'invoice_payload',${second},${scene},'paid','neutral_scene','feature_payment',
      '{"feature_key":"scene_unlock","duration_days":7}'::jsonb,'stars','XTR',15,now())`;
    await db`SELECT public.media_activate_scene_access(${token},${second},${scene},'neutral_scene')`;
    const unlocked=await admit(second,'web',key(),1);
    assert.equal(unlocked.allowed,true);
    assert.equal(unlocked.sceneAccessActive,true);
    assert.equal(await loadDailyMessageUsage(db,userId,'Europe/Moscow'),3);
    assert.equal((await admit(first,'telegram',key(),1)).allowed,false);
  } finally {
    await db`DELETE FROM app_private.message_admissions WHERE user_id=${userId}`;
    await db`DELETE FROM public.interaction_tokens WHERE chat_id IN (${first},${second})`;
    await db`DELETE FROM public.chat_scene_sessions WHERE chat_id IN (${first},${second})`;
    await db`DELETE FROM public.chat_state WHERE user_id=${userId}`;
    await db`DELETE FROM public.users WHERE user_id=${userId}`;
    await db.end();
  }
});
