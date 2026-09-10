import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadFreeCreditsMigration(): Promise<string> {
  const migrationPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260909_free_action_credits.sql",
  );
  return readFile(migrationPath, "utf8");
}

async function loadFreeFastSceneSkipFunctionSql(): Promise<string> {
  const sql = await loadFreeCreditsMigration();
  const functionStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_redeem_free_fast_scene_skip");
  const functionEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.media_redeem_free_scene_unlock");
  assert.ok(functionStart >= 0);
  assert.ok(functionEnd > functionStart);

  return sql.slice(functionStart, functionEnd);
}

test("free fast scene skip consumed retry allows the already-created skip scene", async () => {
  const functionSql = await loadFreeFastSceneSkipFunctionSql();
  const consumedRetryCheck = functionSql.indexOf("IF v_token.status = 'active' AND v_token.consumed_at IS NOT NULL THEN");
  const strictSceneCheck = functionSql.indexOf(
    "OR v_state.active_scene_session_id IS DISTINCT FROM v_token.scene_session_id THEN",
  );
  const consumedBlock = functionSql.slice(consumedRetryCheck, strictSceneCheck);

  assert.ok(consumedRetryCheck >= 0);
  assert.ok(strictSceneCheck > consumedRetryCheck);
  assert.match(consumedBlock, /v_token\.payload_json ->> 'skip_scene_session_id'/u);
  assert.match(consumedBlock, /already_consumed := TRUE;/u);
  assert.match(consumedBlock, /reason := 'already_consumed';/u);
});

test("free fast scene skip fulfilled retry is idempotent after the skip scene became active", async () => {
  const functionSql = await loadFreeFastSceneSkipFunctionSql();
  const fulfilledRetryCheck = functionSql.indexOf("IF v_token.status = 'fulfilled' THEN");
  const fulfilledBlockEnd = functionSql.indexOf("IF v_token.status = 'active' AND v_token.consumed_at IS NOT NULL THEN");
  const fulfilledBlock = functionSql.slice(fulfilledRetryCheck, fulfilledBlockEnd);
  const strictSceneCheck = functionSql.indexOf(
    "OR v_state.active_scene_session_id IS DISTINCT FROM v_token.scene_session_id THEN",
  );

  assert.ok(fulfilledRetryCheck >= 0);
  assert.ok(fulfilledBlockEnd > fulfilledRetryCheck);
  assert.ok(strictSceneCheck > fulfilledBlockEnd);
  assert.match(fulfilledBlock, /v_token\.payload_json ->> 'skip_scene_session_id'/u);
  assert.match(fulfilledBlock, /already_fulfilled := TRUE;/u);
  assert.match(fulfilledBlock, /reason := 'already_fulfilled';/u);
});
