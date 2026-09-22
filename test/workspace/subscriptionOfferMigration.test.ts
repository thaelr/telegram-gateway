import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadMigration(): Promise<string> {
  return readFile(path.resolve(
    process.cwd(), "..", "..", "..", "MP-DB", "supabase", "migrations",
    "20260922090000_active_subscription_offer_pointer.sql",
  ), "utf8");
}

test("active subscription offer migration stores, compare-and-pops, and clears the panel pointer", async () => {
  const sql = await loadMigration();

  assert.match(sql, /ADD COLUMN IF NOT EXISTS active_subscription_offer_id text/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS active_subscription_offer_message_id bigint/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.media_store_subscription_offer_message_id/u);
  assert.match(sql, /active_subscription_offer_id = offer\.offer_id/u);
  assert.match(sql, /active_subscription_offer_message_id = p_offer_message_id/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.media_pop_active_subscription_offer/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.match(sql, /offer_id IS DISTINCT FROM NULLIF\(BTRIM\(p_current_offer_id\), ''\)/u);
  assert.match(sql, /RETURNING c\.message_id/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.media_clear_active_subscription_offer/u);
  assert.match(sql, /n\.offer_id IS NOT NULL/u);
  assert.match(sql, /active_subscription_offer_id IS NOT DISTINCT FROM n\.offer_id/u);
  assert.doesNotMatch(sql, /n\.offer_id IS NULL[\s\S]*active_subscription_offer_id/u);

  for (const signature of [
    "media_store_subscription_offer_message_id\\(jsonb, bigint, bigint\\)",
    "media_pop_active_subscription_offer\\(bigint, text\\)",
    "media_clear_active_subscription_offer\\(bigint, text\\)",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated`, "u"));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`, "u"));
  }
});
