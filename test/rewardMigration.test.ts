import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadMigration(): Promise<string> {
  return readFile(path.resolve(
    process.cwd(), "..", "..", "supabase", "migrations",
    "20260912_reward_system_and_free_photo_unlocks.sql",
  ), "utf8");
}

async function loadSnapshotMigration(): Promise<string> {
  return readFile(path.resolve(
    process.cwd(), "..", "..", "supabase", "migrations",
    "20260912120000_reward_grant_snapshots.sql",
  ), "utf8");
}

test("reward grants persist immutable reward and UX snapshots with message binding", async () => {
  const sql = await loadSnapshotMigration();
  assert.match(sql, /ADD COLUMN IF NOT EXISTS rewards_json JSONB/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS success_text TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS next_action TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT/u);
  assert.match(sql, /jsonb_typeof\(p_rewards\) <> 'array'/u);
  assert.match(sql, /INSERT INTO public\.reward_grants \([\s\S]*rewards_json, success_text, next_action/u);
  assert.match(sql, /campaign_snapshot_mismatch/u);
  const registerStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.register_reward_grant");
  const insertStart = sql.indexOf("INSERT INTO public.reward_grants", registerStart);
  const immutableCheck = sql.indexOf("WHERE rg.campaign_id = v_campaign_id", registerStart);
  assert.ok(registerStart >= 0 && immutableCheck > registerStart && insertStart > immutableCheck);
  const checkSql = sql.slice(registerStart, insertStart);
  assert.match(checkSql, /pg_advisory_xact_lock\(hashtextextended\(v_campaign_id, 0\)\)/u);
  assert.match(checkSql, /rg\.rewards_json IS DISTINCT FROM p_rewards/u);
  assert.match(checkSql, /rg\.success_text IS DISTINCT FROM v_success_text/u);
  assert.match(checkSql, /rg\.next_action IS DISTINCT FROM v_next_action/u);
  assert.doesNotMatch(checkSql, /rg\.chat_id = p_chat_id|rg\.slot = p_slot/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.bind_reward_grant_message/u);
  assert.match(sql, /SET telegram_message_id = p_telegram_message_id/u);
});

test("reward callback claim loads the exact message-bound database snapshot", async () => {
  const sql = await loadSnapshotMigration();
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_reward_grant");
  const end = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_redeem_free_photo_unlock");
  assert.ok(start >= 0 && end > start);
  const functionSql = sql.slice(start, end);

  assert.match(functionSql, /rg\.chat_id = p_chat_id[\s\S]*rg\.slot = p_slot[\s\S]*rg\.telegram_message_id = p_telegram_message_id/u);
  assert.match(functionSql, /FOR UPDATE/u);
  assert.match(functionSql, /v_grant\.campaign_id,[\s\S]*v_grant\.rewards_json/u);
  assert.match(functionSql, /v_grant\.success_text/u);
  assert.match(functionSql, /v_grant\.next_action/u);
  assert.match(functionSql, /'not_eligible'::text/u);
  assert.doesNotMatch(functionSql, /p_campaign_id|p_rewards/u);
});

test("internal reward and free-photo RPCs are executable only by service_role", async () => {
  const sql = await loadSnapshotMigration();
  for (const signature of [
    "claim_reward\\(BIGINT, TEXT, JSONB\\)",
    "register_reward_grant\\(BIGINT, INTEGER, TEXT, JSONB, TEXT, TEXT\\)",
    "bind_reward_grant_message\\(BIGINT, BIGINT\\)",
    "claim_reward_grant\\(BIGINT, INTEGER, BIGINT\\)",
    "media_redeem_free_photo_unlock\\(TEXT, BIGINT\\)",
    "media_finalize_free_photo_unlock\\(TEXT, BIGINT, TEXT, INTEGER, INTEGER, TEXT, TEXT, BIGINT\\)",
    "media_redeem_free_scene_unlock\\(TEXT, BIGINT\\)",
    "media_redeem_free_fast_scene_skip\\(TEXT, BIGINT\\)",
  ]) {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM ${role}`, "u"));
    }
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`, "u"));
  }
});

test("consumed free-photo callback is retriable before expiry rejection", async () => {
  const sql = await loadSnapshotMigration();
  const fulfilled = sql.indexOf("IF v_token.status = 'fulfilled'");
  const consumed = sql.indexOf("IF v_token.consumed_at IS NOT NULL");
  const expired = sql.indexOf("IF v_token.expires_at IS NOT NULL");
  assert.ok(fulfilled >= 0);
  assert.ok(consumed > fulfilled);
  assert.ok(expired > consumed);
  assert.match(sql.slice(consumed, expired), /free_photo_uuid/u);
  assert.match(sql.slice(consumed, expired), /reason := 'already_consumed'/u);
});

test("reward claims are unique and all balances are granted in one database function", async () => {
  const sql = await loadMigration();
  assert.match(sql, /CONSTRAINT reward_claims_chat_campaign_unique UNIQUE \(chat_id, campaign_id\)/u);
  assert.match(sql, /ON CONFLICT ON CONSTRAINT reward_claims_chat_campaign_unique DO NOTHING/u);
  assert.match(sql, /free_scene_unlocks = cs\.free_scene_unlocks \+ v_scene_unlocks/u);
  assert.match(sql, /free_fast_scene_skips = cs\.free_fast_scene_skips \+ v_scene_skips/u);
  assert.match(sql, /free_photo_unlocks = cs\.free_photo_unlocks \+ v_photo_unlocks/u);
  assert.match(sql, /GREATEST\(COALESCE\(cs\.subscription_until, now\(\)\), now\(\)\)/u);
  assert.match(sql, /cs\.subscription_until IS NULL OR cs\.subscription_until <= now\(\)[\s\S]*THEN 'reward_subscription'/u);
  assert.match(sql, /ELSE cs\.subscription_sku/u);
});

test("reward grants bind a recipient and slot to the exact campaign before claim", async () => {
  const sql = await loadMigration();
  assert.match(sql, /UNIQUE \(chat_id, slot, campaign_id\)/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.register_reward_grant/u);
  const claimStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_granted_reward");
  const claimEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_redeem_free_photo_unlock");
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claimSql = sql.slice(claimStart, claimEnd);
  assert.match(claimSql, /rg\.chat_id = p_chat_id[\s\S]*rg\.slot = p_slot[\s\S]*rg\.campaign_id = v_campaign_id/u);
  assert.match(claimSql, /'not_eligible'::text/u);
  assert.match(claimSql, /FROM public\.claim_reward\(p_chat_id, v_campaign_id, p_rewards\)/u);
  assert.match(claimSql, /status = 'claimed'/u);
});

test("free photo redemption locks state and consumes the token and credit atomically", async () => {
  const sql = await loadMigration();
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_redeem_free_photo_unlock");
  assert.ok(start >= 0);
  const functionSql = sql.slice(start);

  assert.match(functionSql, /FROM public\.interaction_tokens[\s\S]*FOR UPDATE;/u);
  assert.match(functionSql, /FROM public\.chat_state[\s\S]*FOR UPDATE;/u);
  assert.match(functionSql, /v_context\.subscription_active = TRUE/u);
  assert.match(functionSql, /v_context\.scene_access_active = TRUE/u);
  assert.match(functionSql, /v_context\.delivered_in_scene, 0\) < 3/u);
  assert.match(functionSql, /SET free_photo_unlocks = cs\.free_photo_unlocks - 1/u);
  assert.match(functionSql, /SET\s+consumed_at = COALESCE\(t\.consumed_at, now\(\)\)/u);
  assert.match(functionSql, /jsonb_build_object\('free_photo_uuid', v_photo_uuid\)/u);
  assert.match(functionSql, /v_token\.status = 'fulfilled'[\s\S]*reason := 'already_fulfilled'/u);
});

test("free photo finalization records the bound UUID once and fulfills the callback token", async () => {
  const sql = await loadMigration();
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_finalize_free_photo_unlock");
  assert.ok(start >= 0);
  const functionSql = sql.slice(start);

  assert.match(functionSql, /v_token\.payload_json ->> 'free_photo_uuid'[\s\S]*IS DISTINCT FROM v_photo_uuid/u);
  assert.match(functionSql, /v_token\.status = 'fulfilled'/u);
  assert.match(functionSql, /'media\.photo\.unlocked\.free'/u);
  assert.match(functionSql, /'access_mode', 'free_credit'/u);
  assert.match(functionSql, /'action_kind', 'free_photo_unlock'/u);
  assert.match(functionSql, /'free_photo_unlock:' \|\| v_token\.token/u);
  assert.match(functionSql, /ON CONFLICT \(source, chat_id, source_event_id\)[\s\S]*DO NOTHING/u);
  assert.match(functionSql, /status = 'fulfilled'/u);
});
