import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadMigration(): Promise<string> {
  return readFile(path.resolve(
    process.cwd(), "..", "..", "..", "MP-DB", "supabase", "migrations",
    "20260922100000_payment_attempt_lifecycle.sql",
  ), "utf8");
}

test("payment attempt lifecycle migration expires local SBP attempts and atomically cancels unpaid siblings", async () => {
  const sql = await loadMigration();
  const expireStart = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.media_mark_sbp_invoice_expired",
  );
  const markPaidStart = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.media_mark_invoice_paid",
  );
  const grantsStart = sql.indexOf("REVOKE ALL ON FUNCTION");
  const expireSql = sql.slice(expireStart, markPaidStart);
  const markPaidSql = sql.slice(markPaidStart, grantsStart);

  assert.ok(expireStart >= 0);
  assert.match(expireSql, /payment_source[\s\S]*= 'sbp'/u);
  assert.match(expireSql, /t\.status = 'invoice_sent'/u);
  assert.match(expireSql, /t\.expires_at IS NOT NULL/u);
  assert.match(expireSql, /t\.expires_at <= now\(\)/u);
  assert.match(expireSql, /NULLIF\(BTRIM\(t\.external_payment_id\), ''\) IS NULL/u);
  assert.match(expireSql, /sbp_checkout_creation_state[\s\S]*= 'idle'/u);
  assert.doesNotMatch(expireSql, /sbp_checkout_creation_state[\s\S]*<> 'uncertain'/u);
  assert.match(expireSql, /failure_reason = 'sbp_expired'/u);

  assert.ok(markPaidStart > expireStart);
  const targetCandidateIndex = markPaidSql.indexOf("target_candidate AS");
  const lockedGroupIndex = markPaidSql.indexOf("locked_group AS");
  const targetIndex = markPaidSql.indexOf("target AS");
  const updateIndex = markPaidSql.indexOf("UPDATE public.interaction_tokens t");
  assert.ok(targetCandidateIndex >= 0);
  assert.ok(lockedGroupIndex > targetCandidateIndex);
  assert.ok(targetIndex > lockedGroupIndex);
  assert.ok(updateIndex > targetIndex);
  assert.match(sql, /UPDATE public\.interaction_tokens t[\s\S]*jsonb_set\([\s\S]*'\{idempotency_key\}'[\s\S]*WHEN t\.token LIKE '%:stars' THEN regexp_replace\(t\.token, ':stars\$', ''\)[\s\S]*WHEN t\.token LIKE '%:sbp' THEN regexp_replace\(t\.token, ':sbp\$', ''\)[\s\S]*ELSE t\.token[\s\S]*t\.action_kind = 'feature_payment'[\s\S]*t\.status = 'invoice_sent'[\s\S]*payload_json ->> 'idempotency_key'/u);
  assert.match(markPaidSql, /FROM locked_group t[\s\S]*WHERE t\.token = NULLIF/u);
  assert.match(markPaidSql, /FOR UPDATE OF g/u);
  assert.match(markPaidSql, /NULLIF\(BTRIM\(t\.payload_json ->> 'idempotency_key'\), ''\) AS purchase_id/u);
  assert.match(markPaidSql, /g\.chat_id = t\.chat_id/u);
  assert.match(markPaidSql, /g\.action_kind = t\.action_kind/u);
  assert.match(markPaidSql, /g\.sku IS NOT DISTINCT FROM t\.sku/u);
  assert.match(
    markPaidSql,
    /NULLIF\(BTRIM\(g\.payload_json ->> 'idempotency_key'\), ''\) = t\.purchase_id/u,
  );
  assert.doesNotMatch(markPaidSql, /g\.payment_source = t\.payment_source/u);
  assert.match(markPaidSql, /WHERE status IN \('paid', 'fulfilled'\)/u);
  assert.match(markPaidSql, /NOT EXISTS \(SELECT 1 FROM winner_exists\)/u);
  assert.match(markPaidSql, /failure_reason = 'sibling_paid'/u);
  assert.match(markPaidSql, /s\.status = 'invoice_sent'/u);
});
