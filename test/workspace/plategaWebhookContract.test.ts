import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type WorkflowNode = {
  name?: string;
  type?: string;
  continueOnFail?: boolean;
  parameters?: {
    method?: string;
    body?: string;
    query?: string;
    inlineKeyboard?: unknown;
    conditions?: {
      conditions?: Array<{
        leftValue?: string;
      }>;
    };
    responseMode?: string;
    jsCode?: string;
    url?: string;
    numberOutputs?: number;
    output?: string;
    workflowId?: {
      value?: string;
      cachedResultName?: string;
    };
  };
};

type WorkflowConnection = {
  node?: string;
  type?: string;
  index?: number;
};

type Workflow = {
  nodes?: WorkflowNode[];
  connections?: Record<string, { main?: WorkflowConnection[][] }>;
};

function reachableNodeNames(workflow: Workflow, start: string): Set<string> {
  const reachable = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const targets = workflow.connections?.[current]?.main?.flat() ?? [];
    pending.push(...targets.map((target) => target.node ?? "").filter(Boolean));
  }
  return reachable;
}

async function loadWorkflow(): Promise<Workflow> {
  const raw = await loadWorkflowRaw();
  return JSON.parse(raw) as Workflow;
}

async function loadWorkflowRaw(): Promise<string> {
  const workflowPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "Актуальные",
    "RUS Media Commerce Flow v4.json",
  );
  return readFile(workflowPath, "utf8");
}

async function loadSbpMigration(name: string): Promise<string> {
  const migrationPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "..",
    "MP-DB",
    "supabase",
    "migrations",
    name,
  );
  return readFile(migrationPath, "utf8");
}

test("SBP migration makes checkout claims lifecycle-safe and ambiguous outcomes durable", async () => {
  const migration = await loadSbpMigration(
    "20260915165838_media_commerce_sbp_lifecycle_followup.sql",
  );
  const claimStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.media_claim_sbp_checkout_creation",
  );
  const claimEnd = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.media_release_sbp_checkout_creation",
  );
  const claimSql = migration.slice(claimStart, claimEnd);

  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.match(claimSql, /t\.status = 'invoice_sent'/u);
  assert.match(claimSql, /t\.action_kind IN \('subscription_payment', 'photo_payment', 'feature_payment'\)/u);
  assert.match(claimSql, /t\.expires_at IS NOT NULL/u);
  assert.match(claimSql, /t\.expires_at > now\(\)/u);
  assert.match(claimSql, /sbp_checkout_creation_state[\s\S]*= 'idle'/u);
  assert.doesNotMatch(claimSql, /INTERVAL '2 minutes'/u);
  assert.match(
    migration,
    /sbp_checkout_creation_started_at IS NOT NULL[\s\S]*THEN 'uncertain'/u,
  );
  assert.match(
    migration,
    /THEN COALESCE\(sbp_checkout_creation_uncertain_at, sbp_checkout_creation_started_at\)/u,
  );
  assert.match(migration, /media_mark_sbp_checkout_creation_uncertain/u);
  assert.match(migration, /media_mark_sbp_invoice_canceled/u);
  assert.match(migration, /media_record_sbp_status_conflict/u);
});

test("Stars payload migration provides a unique payload lookup without exposing internal tokens", async () => {
  const migration = await loadSbpMigration(
    "20260920010000_stars_invoice_payload_identifier.sql",
  );

  assert.match(migration, /uq_interaction_tokens_telegram_invoice_payload_invoice/u);
  assert.match(migration, /'stars_' \|\| encode\(extensions\.digest\(t\.token, 'sha256'\), 'hex'\)/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.media_load_invoice_token/u);
  assert.match(
    migration,
    /candidate\.token = i\.requested_token[\s\S]*candidate\.telegram_invoice_payload = i\.requested_token/u,
  );
  assert.match(migration, /t\.kind = 'invoice_payload'/u);
});

async function loadRouterWorkflow(): Promise<Workflow> {
  const workflowPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "Актуальные",
    "RUS Telegram Update Router v8 TS.json",
  );
  return JSON.parse(await readFile(workflowPath, "utf8")) as Workflow;
}

async function loadRouterWorkflowNodeCode(nodeName: string): Promise<string> {
  const workflow = await loadRouterWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === nodeName)
    : null;
  const jsCode = node?.parameters?.jsCode;

  assert.equal(typeof jsCode, "string");
  if (typeof jsCode !== "string") {
    throw new TypeError(`${nodeName} node must contain jsCode`);
  }
  assert.ok(jsCode.length > 0);

  return jsCode;
}

async function loadSceneTurnWorkflow(): Promise<Workflow> {
  const workflowPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "Актуальные",
    "Engine Scene Turn Core prod.v1.json",
  );
  return JSON.parse(await readFile(workflowPath, "utf8")) as Workflow;
}

async function loadBroadcastWorkflow(): Promise<Workflow> {
  const workflowPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "Дополнительные",
    "n8n_telegram_broadcast_template.json",
  );
  return JSON.parse(await readFile(workflowPath, "utf8")) as Workflow;
}

async function loadSceneTurnWorkflowNodeCode(nodeName: string): Promise<string> {
  const workflow = await loadSceneTurnWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === nodeName)
    : null;
  const jsCode = node?.parameters?.jsCode;

  assert.equal(typeof jsCode, "string");
  if (typeof jsCode !== "string") {
    throw new TypeError(`${nodeName} node must contain jsCode`);
  }
  assert.ok(jsCode.length > 0);

  return jsCode;
}

async function loadNormalizeSbpWebhookCode(): Promise<string> {
  const workflow = await loadWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === "Normalize SBP webhook event")
    : null;
  const jsCode = node?.parameters?.jsCode;

  assert.equal(typeof jsCode, "string");
  if (typeof jsCode !== "string") {
    throw new TypeError("Normalize SBP webhook event node must contain jsCode");
  }
  assert.ok(jsCode.length > 0);

  return jsCode;
}

async function loadWorkflowNodeCode(nodeName: string): Promise<string> {
  const workflow = await loadWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === nodeName)
    : null;
  const jsCode = node?.parameters?.jsCode;

  assert.equal(typeof jsCode, "string");
  if (typeof jsCode !== "string") {
    throw new TypeError(`${nodeName} node must contain jsCode`);
  }
  assert.ok(jsCode.length > 0);

  return jsCode;
}

async function runPrepareAssistantSendContext(input: {
  currentHint: Record<string, unknown> | null;
  previousHint: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  const jsCode = await loadSceneTurnWorkflowNodeCode("Prepare assistant send context");
  const evaluator = new Function("$node", jsCode) as (
    node: Record<string, { json: Record<string, unknown> }>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator({
    "Format response": {
      json: {
        formatted_text: "Assistant text",
        _writer_scene_hint: input.currentHint,
      },
    },
    "Create row in chat_turns": {
      json: {
        chat_id: 101,
        n: 14,
        scene_session_id: "scene-1",
        scene_turn_no: 9,
        scene_hint: input.previousHint,
      },
    },
    "Build Dynamic Instructions": { json: { chat_id: 101, n: 14 } },
    "Scene Turn Input": { json: { chat_id: 101 } },
  });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runWorkflowCodeNode(
  nodeName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadWorkflowNodeCode(nodeName);
  const evaluator = new Function("$json", "$items", jsCode) as (
    json: Record<string, unknown>,
    items: (nodeName: string) => Array<{ json: Record<string, unknown> }>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input, (sourceNodeName: string) => {
    assert.equal(sourceNodeName, "Evaluate media commerce decision");
    return [{ json: input }];
  });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runPrepareMediaOfferInput(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadSceneTurnWorkflowNodeCode("Prepare media offer input");
  const evaluator = new Function("$json", jsCode) as (
    json: Record<string, unknown>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runPrepareFastSceneSkipOfferInput(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadRouterWorkflowNodeCode("Prepare fast scene skip offer input");
  const evaluator = new Function("$json", jsCode) as (
    json: Record<string, unknown>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runApplyMediaOfferCooldown(
  input: {
    hasThreeCompletedTurns: boolean;
    recentMediaActivity: boolean;
  },
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadSceneTurnWorkflowNodeCode("Apply media offer cooldown");
  const evaluator = new Function("$json", "$node", jsCode) as (
    json: Record<string, unknown>,
    node: Record<string, { json: Record<string, unknown> }>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(
    {
      has_three_completed_turns: input.hasThreeCompletedTurns,
      recent_media_activity: input.recentMediaActivity,
    },
    { "Prepare assistant send context": { json: base } },
  );

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runNormalizeSbpWebhookContract(
  input: Record<string, unknown>,
  env: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadNormalizeSbpWebhookCode();
  const evaluator = new Function("$json", "$env", jsCode) as (
    json: Record<string, unknown>,
    localEnv: Record<string, unknown>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input, env);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runPrepareRefreshedSubscriptionOfferResult(
  input: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadWorkflowNodeCode("Prepare refreshed subscription offer result");
  const evaluator = new Function("$json", "$items", jsCode) as (
    json: Record<string, unknown>,
    items: (nodeName: string) => Array<{ json: Record<string, unknown> }>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input, (nodeName: string) => {
    assert.equal(nodeName, "Build subscription offer message");
    return [{ json: base }];
  });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

async function runPrepareFinalizeSubscriptionOfferInput(
  input: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jsCode = await loadWorkflowNodeCode("Prepare finalize subscription offer input");
  const evaluator = new Function("$json", "$items", jsCode) as (
    json: Record<string, unknown>,
    items: (nodeName: string) => Array<{ json: Record<string, unknown> }>,
  ) => Array<{ json: Record<string, unknown> }>;
  const result = evaluator(input, (nodeName: string) => {
    assert.equal(nodeName, "Build subscription offer message");
    return [{ json: base }];
  });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(typeof result[0]?.json, "object");
  assert.ok(result[0]?.json != null);

  return result[0].json;
}

test("Normalize SBP webhook event maps Platega CONFIRMED callback to gateway contract", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-transaction-1",
        status: "CONFIRMED",
        amount: 299.75,
        paymentMethod: 12,
        currency: "RUB",
      },
    },
    {
      SBP_MERCHANT_ID: "merchant-1",
      SBP_API_SECRET: "secret-1",
    },
  );

  assert.deepEqual(normalized, {
    interaction_mode: null,
    event_type: "payment.confirmed.received",
    payment_source: "sbp",
    external_payment_id: "platega-transaction-1",
    payment_currency: "RUB",
    payment_total_amount: null,
    provider_payment_amount: 299.75,
    provider_payment_method: 12,
    checkout_url: null,
    source: "sbp_webhook",
    sbp_webhook_action: "confirmed",
    response_code: 200,
    reason: null,
    raw_update: null,
  });
  assert.equal("payment_token" in normalized, false);
  assert.equal("chat_id" in normalized, false);
});

test("Normalize SBP webhook event maps Platega CANCELED callback to gateway contract", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-canceled-1",
        status: "CANCELED",
        amount: 299,
        currency: "RUB",
      },
    },
    {
      SBP_MERCHANT_ID: "merchant-1",
      SBP_API_SECRET: "secret-1",
    },
  );

  assert.equal(normalized.event_type, "payment.canceled.received");
  assert.equal(normalized.sbp_webhook_action, "canceled");
  assert.equal(normalized.external_payment_id, "platega-canceled-1");
  assert.equal(normalized.payment_total_amount, null);
  assert.equal(normalized.provider_payment_amount, 299);
  assert.equal(normalized.response_code, 200);
  assert.equal(normalized.reason, null);
});

test("Normalize SBP webhook event maps Platega CHARGEBACKED callback to audit-only gateway contract", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-chargebacked-1",
        status: "CHARGEBACKED",
        amount: 299.75,
        currency: "RUB",
      },
    },
    {
      SBP_MERCHANT_ID: "merchant-1",
      SBP_API_SECRET: "secret-1",
    },
  );

  assert.equal(normalized.event_type, "payment.chargebacked.received");
  assert.equal(normalized.sbp_webhook_action, "chargebacked");
  assert.equal(normalized.external_payment_id, "platega-chargebacked-1");
  assert.equal(normalized.payment_total_amount, null);
  assert.equal(normalized.provider_payment_amount, 299.75);
  assert.equal(normalized.response_code, 200);
  assert.equal(normalized.reason, null);
});

test("router workflow sends raw_update to gateway router decision", async () => {
  const workflow = await loadRouterWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === "Evaluate router decision")
    : null;
  const body = String(node?.parameters?.body ?? "");

  assert.match(body, /raw_update:\s*\$json\.raw_update\s*\?\?\s*null/u);
});

test("router terms gate renders Gateway-provided offer URL", async () => {
  const workflow = await loadRouterWorkflow();
  const node = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === "Build terms gate payload")
    : null;
  const code = String(node?.parameters?.jsCode ?? "");

  assert.match(code, /item\.terms_offer_url/u);
  assert.doesNotMatch(code, /\$env\.PUBLIC_OFFER_URL/u);
  assert.match(code, /terms_offer_url is required/u);
  assert.match(code, /inline_keyboard:\s*\[/u);
  assert.match(code, /url:\s*offerUrl/u);
  assert.match(code, /callback_data:\s*'terms_accept:' \+ requestedIntent/u);
});

test("router fast scene skip offer passes explicit feature discriminator", async () => {
  const result = await runPrepareFastSceneSkipOfferInput({
    chat_id: 101,
    active_scene_session_id: "scene-fast",
    current_turn_no: 12,
    scene_turn_no: 0,
    selected_character_i: 2,
    scene_mode: "fast",
    start_media_signature: "hotel_room_close_standing_towel",
  });
  const workflow = await loadRouterWorkflow();

  assert.equal(result.interaction_mode, "feature_offer");
  assert.equal(result.feature_key, "fast_scene_skip");
  assert.equal(result.chat_id, 101);
  assert.equal(result.scene_session_id, "scene-fast");
  assert.equal(result.turn_no, 12);
  assert.equal(result.scene_turn_no, 0);
  assert.equal(result.character_i, 2);
  assert.equal(result.scene_mode, "fast");
  assert.equal(result.target_message_id, null);
  assert.equal(result.media_signature, "hotel_room_close_standing_towel");
  assert.deepEqual(
    workflow.connections?.["Need fast scene skip offer?"]?.main?.[0]?.map((entry) => entry.node),
    ["Prepare fast scene skip offer input"],
  );
  assert.deepEqual(
    workflow.connections?.["Prepare fast scene skip offer input"]?.main?.[0]?.map((entry) => entry.node),
    ["Run fast scene skip offer"],
  );
  assert.deepEqual(
    workflow.connections?.["Run fast scene skip offer"]?.main?.[0]?.map((entry) => entry.node),
    ["Restore scene start context after fast scene skip offer"],
  );
});

test("scene turn core media signature keeps out_of_reach distinct and sex requires sex_position", async () => {
  const baseHint = {
    location: "hotel_room",
    pose: "standing",
    clothes: "towel",
  };
  const outOfReach = await runPrepareAssistantSendContext({
    currentHint: { ...baseHint, distance: "out_of_reach" },
    previousHint: null,
  });
  const close = await runPrepareAssistantSendContext({
    currentHint: { ...baseHint, distance: "close" },
    previousHint: null,
  });
  const touching = await runPrepareAssistantSendContext({
    currentHint: { ...baseHint, distance: "touching" },
    previousHint: null,
  });
  const sex = await runPrepareAssistantSendContext({
    currentHint: { ...baseHint, clothes: "naked", distance: "sex", sex_position: "cowgirl" },
    previousHint: null,
  });
  const sexMissingPosition = await runPrepareAssistantSendContext({
    currentHint: { ...baseHint, clothes: "naked", distance: "sex", sex_position: null },
    previousHint: null,
  });

  assert.equal(outOfReach.media_signature_preview, "hotel_room_out_of_reach_standing_towel");
  assert.equal(close.media_signature_preview, "hotel_room_close_standing_towel");
  assert.equal(touching.media_signature_preview, "hotel_room_close_standing_towel");
  assert.notEqual(outOfReach.media_signature_preview, close.media_signature_preview);
  assert.equal(sex.media_signature_preview, "hotel_room_sex_standing_naked_cowgirl");
  assert.equal(sexMissingPosition.media_signature_preview, null);
});

test("scene turn core passes photo_sku through prepare_offer for normal and premium media", async () => {
  const normal = await runPrepareAssistantSendContext({
    currentHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "close",
    },
    previousHint: null,
  });
  const premium = await runPrepareAssistantSendContext({
    currentHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "naked",
      distance: "close",
    },
    previousHint: null,
  });

  assert.equal(normal.photo_sku, "payment_media_1");
  assert.equal(normal.base_price_xtr, 10);
  assert.equal(premium.photo_sku, "payment_media_2");
  assert.equal(premium.base_price_xtr, 25);
  assert.equal((await runPrepareMediaOfferInput(normal)).photo_sku, "payment_media_1");
  assert.equal((await runPrepareMediaOfferInput(premium)).photo_sku, "payment_media_2");
});

test("scene turn core routes media offer cooldown only for same valid signature", async () => {
  const changed = await runPrepareAssistantSendContext({
    currentHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "close",
    },
    previousHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "out_of_reach",
    },
  });
  const same = await runPrepareAssistantSendContext({
    currentHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "close",
    },
    previousHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "touching",
    },
  });
  const invalid = await runPrepareAssistantSendContext({
    currentHint: {
      location: "hotel_room",
      pose: "standing",
      clothes: "towel",
      distance: "banana",
    },
    previousHint: null,
  });

  assert.equal(changed.should_prepare_media_offer, true);
  assert.equal(changed.should_check_media_offer_cooldown, false);
  assert.equal(invalid.media_signature_preview, null);
  assert.equal(invalid.should_prepare_media_offer, false);
  assert.equal(invalid.should_check_media_offer_cooldown, false);
  assert.equal(same.should_prepare_media_offer, false);
  assert.equal(same.should_check_media_offer_cooldown, true);
  assert.equal((await runApplyMediaOfferCooldown(
    { hasThreeCompletedTurns: false, recentMediaActivity: false },
    same,
  )).should_prepare_media_offer, false);
  assert.equal((await runApplyMediaOfferCooldown(
    { hasThreeCompletedTurns: true, recentMediaActivity: true },
    same,
  )).should_prepare_media_offer, false);
  assert.equal((await runApplyMediaOfferCooldown(
    { hasThreeCompletedTurns: true, recentMediaActivity: false },
    same,
  )).should_prepare_media_offer, true);

  const workflow = await loadSceneTurnWorkflow();
  assert.deepEqual(
    workflow.connections?.["Need media offer prepare?"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Prepare media offer input"],
      ["Need media offer cooldown check?"],
    ],
  );
  assert.deepEqual(
    workflow.connections?.["Need media offer cooldown check?"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Check recent media activity"],
      ["Assistant send payload ready"],
    ],
  );
  const gateNode = workflow.nodes?.find((entry) => entry.name === "Need media offer cooldown check?");
  assert.match(
    String(gateNode?.parameters?.conditions?.conditions?.[0]?.leftValue ?? ""),
    /should_check_media_offer_cooldown === true/u,
  );
  const cooldownNode = workflow.nodes?.find((entry) => entry.name === "Check recent media activity");
  const query = String(cooldownNode?.parameters?.query ?? "");
  assert.match(query, /FROM public\.chat_turns ct/u);
  assert.match(query, /ct\.n < i\.turn_no/u);
  assert.match(query, /ct\.sent_at IS NOT NULL/u);
  assert.match(query, /ORDER BY ct\.n DESC/u);
  assert.match(query, /LIMIT 3/u);
  assert.match(query, /has_three_completed_turns/u);
  assert.match(query, /cm\.turn_no IN \(SELECT n FROM completed_turns\)/u);
  assert.match(query, /media\.panel\.sent/u);
  assert.doesNotMatch(query, /created_at|interval/u);
});

test("router workflow preserves Telegram payment ingress and excludes SBP provider webhook fields", async () => {
  const workflow = await loadRouterWorkflow();
  const normalizeNode = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === "Normalize tg update")
    : null;
  const evaluateNode = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((entry) => entry?.name === "Evaluate router decision")
    : null;
  const normalizeCode = String(normalizeNode?.parameters?.jsCode ?? "");
  const routerBody = String(evaluateNode?.parameters?.body ?? "");

  assert.match(normalizeCode, /event_type = 'payment\.success\.received'/u);
  assert.match(normalizeCode, /invoice_payload = msg\.successful_payment\.invoice_payload/u);
  assert.match(normalizeCode, /telegram_payment_charge_id = msg\.successful_payment\.telegram_payment_charge_id/u);
  assert.match(normalizeCode, /provider_payment_charge_id = msg\.successful_payment\.provider_payment_charge_id/u);
  assert.match(normalizeCode, /payment_currency = msg\.successful_payment\.currency/u);
  assert.match(normalizeCode, /payment_total_amount = msg\.successful_payment\.total_amount/u);
  assert.match(normalizeCode, /event_type = 'payment\.pre_checkout\.received'/u);
  assert.match(normalizeCode, /pre_checkout_query_id = query\.id/u);
  assert.match(normalizeCode, /invoice_payload = query\.invoice_payload/u);
  assert.match(normalizeCode, /payment_currency = query\.currency/u);
  assert.match(normalizeCode, /payment_total_amount = query\.total_amount/u);

  assert.match(routerBody, /pre_checkout_query_id:\s*\$json\.pre_checkout_query_id/u);
  assert.match(routerBody, /invoice_payload:\s*\$json\.invoice_payload/u);
  assert.match(routerBody, /telegram_payment_charge_id:\s*\$json\.telegram_payment_charge_id/u);
  assert.match(routerBody, /provider_payment_charge_id:\s*\$json\.provider_payment_charge_id/u);
  assert.match(routerBody, /payment_currency:\s*\$json\.payment_currency/u);
  assert.match(routerBody, /payment_total_amount:\s*\$json\.payment_total_amount != null/u);
  assert.doesNotMatch(routerBody, /provider_payment_amount/u);
  assert.doesNotMatch(routerBody, /external_payment_id/u);
  assert.doesNotMatch(routerBody, /payment\.(confirmed|canceled|chargebacked)\.received/u);
  assert.doesNotMatch(routerBody, /CONFIRMED|CANCELED|CHARGEBACKED/u);
});

test("reward callback topology claims, answers callback, then routes the next action", async () => {
  const workflow = await loadRouterWorkflow();
  const nodes = workflow.nodes ?? [];
  const route = nodes.find((node) => node.name === "Route router action");
  const claim = nodes.find((node) => node.name === "Claim configured reward");
  const answer = nodes.find((node) => node.name === "Answer reward callback");

  assert.equal(route?.parameters?.numberOutputs, 17);
  assert.match(route?.parameters?.output ?? "", /handle_reward_claim/u);
  assert.match(claim?.parameters?.url ?? "", /\/v1\/rewards\/claim-slot/u);
  assert.match(claim?.parameters?.body ?? "", /reward_slot/u);
  assert.equal(answer?.type, "n8n-nodes-base.telegram");
  assert.deepEqual(
    workflow.connections?.["Claim configured reward"]?.main?.[0]?.map((item) => item.node),
    ["Answer reward callback"],
  );
  assert.deepEqual(
    workflow.connections?.["Answer reward callback"]?.main?.[0]?.map((item) => item.node),
    ["Route reward next action"],
  );
  assert.deepEqual(
    workflow.connections?.["Route reward next action"]?.main?.[0]?.map((item) => item.node),
    ["Build gallery flow input"],
  );
});

test("Normalize SBP webhook event ignores non-CONFIRMED Platega callback", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "X-MerchantId": "merchant-1",
        "X-Secret": "secret-1",
      },
      body: {
        id: "platega-transaction-2",
        status: "PENDING",
        amount: 299,
        currency: "RUB",
      },
    },
    {
      SBP_MERCHANT_ID: "merchant-1",
      SBP_API_SECRET: "secret-1",
    },
  );

  assert.equal(normalized.event_type, null);
  assert.equal(normalized.payment_source, "sbp");
  assert.equal(normalized.external_payment_id, "platega-transaction-2");
  assert.equal(normalized.payment_total_amount, null);
  assert.equal(normalized.provider_payment_amount, 299);
  assert.equal(normalized.payment_currency, "RUB");
  assert.equal(normalized.reason, "sbp_webhook_ignored");
  assert.equal(normalized.sbp_webhook_action, "ack");
  assert.equal(normalized.response_code, 200);
});

test("Normalize SBP webhook event rejects missing auth env fail-closed", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-transaction-3",
        status: "CONFIRMED",
        amount: 299,
        currency: "RUB",
      },
    },
    {},
  );

  assert.equal(normalized.event_type, null);
  assert.equal(normalized.sbp_webhook_action, "invalid");
  assert.equal(normalized.reason, "sbp_webhook_auth_not_configured");
  assert.equal(normalized.response_code, 500);
});

test("Normalize SBP webhook event rejects malformed confirmed callback", async () => {
  const normalized = await runNormalizeSbpWebhookContract(
    {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-transaction-4",
        status: "CONFIRMED",
        currency: "RUB",
      },
    },
    {
      SBP_MERCHANT_ID: "merchant-1",
      SBP_API_SECRET: "secret-1",
    },
  );

  assert.equal(normalized.event_type, null);
  assert.equal(normalized.sbp_webhook_action, "invalid");
  assert.equal(normalized.reason, "sbp_webhook_payload_invalid");
  assert.equal(normalized.response_code, 400);
});

test("SBP webhook topology responds once after confirmed fulfillment and bypasses fulfillment for canceled or chargebacked", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const webhook = nodes.find((entry) => entry.name === "SBP payment webhook");
  const route = nodes.find((entry) => entry.name === "Route SBP webhook event");
  const terminalRoute = nodes.find(
    (entry) => entry.name === "Route SBP confirmed terminal response",
  );
  const cancellationValidation = nodes.find(
    (entry) => entry.name === "Validate SBP cancellation persisted",
  );
  const chargebackValidation = nodes.find(
    (entry) => entry.name === "Validate SBP chargeback recorded",
  );

  assert.equal(webhook?.parameters?.responseMode, "responseNode");
  assert.equal(route?.parameters?.numberOutputs, 5);
  assert.match(String(route?.parameters?.output ?? ""), /confirmed.*canceled.*chargebacked/u);
  assert.match(
    String(terminalRoute?.parameters?.output ?? ""),
    /subscription_activated.*feature_fulfillment_required.*scene_access_activated/u,
  );
  assert.match(
    String(terminalRoute?.parameters?.output ?? ""),
    /feature_fast_scene_skip_config_missing/u,
  );
  assert.match(
    String(terminalRoute?.parameters?.output ?? ""),
    /subscription_already_activated/u,
  );
  assert.match(
    String(terminalRoute?.parameters?.output ?? ""),
    /payment_status_conflict/u,
  );
  assert.match(
    String(cancellationValidation?.parameters?.jsCode ?? ""),
    /payment_canceled.*payment_already_canceled.*payment_status_conflict/u,
  );
  assert.match(
    String(chargebackValidation?.parameters?.jsCode ?? ""),
    /payment_chargeback_recorded/u,
  );
  assert.deepEqual(
    workflow.connections?.["Normalize SBP webhook event"]?.main?.[0]?.map((entry) => entry.node),
    ["Route SBP webhook event"],
  );
  assert.deepEqual(
    workflow.connections?.["Route SBP webhook event"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Send SBP payment event to gateway"],
      ["Send SBP cancellation event to gateway"],
      ["Send SBP chargeback event to gateway"],
      ["Return SBP webhook ignored"],
      ["Return SBP webhook invalid"],
    ],
  );
  assert.deepEqual(
    workflow.connections?.["Send SBP payment event to gateway"]?.main?.[0]?.map((entry) => entry.node),
    ["Restore confirmed SBP webhook context"],
  );
  assert.deepEqual(
    workflow.connections?.["Restore confirmed SBP webhook context"]?.main?.[0]?.map((entry) => entry.node),
    ["Route operation group"],
  );
  assert.deepEqual(
    workflow.connections?.["Send SBP cancellation event to gateway"]?.main?.[0]?.map((entry) => entry.node),
    ["Validate SBP cancellation persisted"],
  );
  assert.deepEqual(
    workflow.connections?.["Validate SBP cancellation persisted"]?.main?.[0]?.map((entry) => entry.node),
    ["Return SBP webhook success"],
  );
  assert.deepEqual(
    workflow.connections?.["Send SBP chargeback event to gateway"]?.main?.[0]?.map((entry) => entry.node),
    ["Validate SBP chargeback recorded"],
  );
  assert.deepEqual(
    workflow.connections?.["Validate SBP chargeback recorded"]?.main?.[0]?.map((entry) => entry.node),
    ["Return SBP webhook success"],
  );
  for (const terminal of [
    "Return payment fulfillment result",
    "Mark fast scene skip fulfilled",
    "Return noop result",
  ]) {
    assert.deepEqual(
      workflow.connections?.[terminal]?.main?.[0]?.map((entry) => entry.node),
      ["Route SBP confirmed terminal response"],
      terminal,
    );
  }
  assert.deepEqual(
    workflow.connections?.["Route SBP confirmed terminal response"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Fail incomplete SBP confirmed fulfillment"],
      ["Return SBP webhook success"],
      ["Return non-webhook terminal result"],
    ],
  );

  const respondNodes = new Set(
    nodes
      .filter((node) => node.type === "n8n-nodes-base.respondToWebhook")
      .map((node) => node.name ?? ""),
  );
  const confirmedReachable = reachableNodeNames(workflow, "Send SBP payment event to gateway");
  const canceledReachable = reachableNodeNames(workflow, "Send SBP cancellation event to gateway");
  const chargebackedReachable = reachableNodeNames(workflow, "Send SBP chargeback event to gateway");
  assert.deepEqual(
    [...confirmedReachable].filter((name) => respondNodes.has(name)),
    ["Return SBP webhook success"],
  );
  assert.deepEqual(
    [...canceledReachable].filter((name) => respondNodes.has(name)),
    ["Return SBP webhook success"],
  );
  assert.deepEqual(
    [...chargebackedReachable].filter((name) => respondNodes.has(name)),
    ["Return SBP webhook success"],
  );
  assert.equal(canceledReachable.has("Route operation group"), false);
  assert.equal(canceledReachable.has("Need noop callback answer?"), false);
  assert.equal(chargebackedReachable.has("Route operation group"), false);
  assert.equal(chargebackedReachable.has("Need noop callback answer?"), false);
  const successIncoming = Object.entries(workflow.connections ?? {})
    .filter(([, connection]) => (connection.main ?? []).flat().some(
      (target) => target.node === "Return SBP webhook success",
    ))
    .map(([source]) => source)
    .sort();
  assert.deepEqual(successIncoming, [
    "Route SBP confirmed terminal response",
    "Validate SBP cancellation persisted",
    "Validate SBP chargeback recorded",
  ]);
});

test("subscription offer topology refreshes an existing offer message instead of skipping render", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const editNode = nodes.find((entry) => entry.name === "Edit subscription offer message");
  const prepareNode = nodes.find((entry) => entry.name === "Prepare refreshed subscription offer result");
  const fallbackNode = nodes.find((entry) => entry.name === "Need subscription edit fallback?");
  const callbackAnswerNode = nodes.find((entry) => entry.name === "Need subscription offer callback answer?");

  assert.equal(editNode?.type, "n8n-nodes-base.httpRequest");
  assert.equal(editNode?.continueOnFail, true);
  assert.match(String(editNode?.parameters?.url ?? ""), /editMessageText/u);
  assert.match(String(editNode?.parameters?.body ?? ""), /message_id/u);
  assert.match(String(editNode?.parameters?.body ?? ""), /reply_markup/u);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message is not modified/i);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message to edit not found/i);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message can't be edited/i);
  assert.equal(fallbackNode?.type, "n8n-nodes-base.if");
  assert.match(
    String(callbackAnswerNode?.parameters?.conditions?.conditions?.[0]?.leftValue ?? ""),
    /callback_query_id != null/u,
  );
  assert.deepEqual(
    workflow.connections?.["Subscription offer already sent?"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Edit subscription offer message"],
      ["Send subscription offer message"],
    ],
  );
  assert.deepEqual(
    workflow.connections?.["Edit subscription offer message"]?.main?.[0]?.map((entry) => entry.node),
    ["Prepare refreshed subscription offer result"],
  );
  assert.deepEqual(
    workflow.connections?.["Prepare refreshed subscription offer result"]?.main?.[0]?.map((entry) => entry.node),
    ["Need subscription edit fallback?"],
  );
  assert.deepEqual(
    workflow.connections?.["Need subscription edit fallback?"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Send subscription offer message"],
      ["Prepare finalize subscription offer input"],
    ],
  );
});

test("subscription offer prefixes free balances before choosing send or edit", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const formatter = nodes.find((entry) => entry.name === "Add free balances to subscription text");

  assert.equal(formatter?.type, "n8n-nodes-base.code");
  assert.match(String(formatter?.parameters?.jsCode ?? ""), /free_balance_text/u);
  assert.deepEqual(
    workflow.connections?.["Build subscription offer message"]?.main?.[0]?.map((entry) => entry.node),
    ["Add free balances to subscription text"],
  );
  assert.deepEqual(
    workflow.connections?.["Add free balances to subscription text"]?.main?.[0]?.map((entry) => entry.node),
    ["Subscription offer already sent?"],
  );
});

test("broadcast registers the campaign grant before sending a stable reward callback", async () => {
  const workflow = await loadBroadcastWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const grant = nodes.find((entry) => entry.name === "Зарегистрировать reward grant");
  const send = nodes.find((entry) => entry.name === "Отправить сообщение");

  assert.equal(grant?.parameters?.method, "POST");
  assert.match(String(grant?.parameters?.url ?? ""), /\/v1\/rewards\/grants$/u);
  assert.match(String(grant?.parameters?.body ?? ""), /reward_slot:\s*1/u);
  assert.match(JSON.stringify(send?.parameters?.inlineKeyboard ?? null), /reward_claim:1/u);
  assert.deepEqual(
    workflow.connections?.["По 1 сообщению каждые 3 секунды"]?.main?.[1]?.map((entry) => entry.node),
    ["Зарегистрировать reward grant"],
  );
  assert.deepEqual(
    workflow.connections?.["Зарегистрировать reward grant"]?.main?.[0]?.map((entry) => entry.node),
    ["Отправить сообщение"],
  );
});

test("feature payment reveal builder preserves entities and adds only hint italic entity", async () => {
  const result = await runWorkflowCodeNode("Build feature payment options reveal", {
    chat_id: 101,
    target_message_id: 777,
    inbound_message_id: 777,
    callback_data: "btn_reveal",
    message_kind: "text",
    panel_text: "Original bold",
    panel_entities_json: [{ type: "bold", offset: 0, length: 8 }],
    feature_payment_hint_text: "*Hint text",
    current_reply_markup: {
      inline_keyboard: [
        [{ text: "Пропустить прелюдию", callback_data: "btn_reveal" }],
        [{ text: "Other", callback_data: "btn_other" }],
      ],
    },
    payment_options: [
      {
        source: "sbp",
        checkout_url: "https://pay.example/sbp",
        button_text: "80 ₽ (СБП)",
      },
      {
        source: "stars",
        checkout_url: "https://t.me/invoice",
        button_text: "⭐ 50",
      },
    ],
  });

  assert.equal(result.text, "Original bold\n\n*Hint text");
  assert.deepEqual(result.entities, [
    { type: "bold", offset: 0, length: 8 },
    { type: "italic", offset: 15, length: 10 },
  ]);
  assert.deepEqual(result.reply_markup, {
    inline_keyboard: [
      [
        { text: "80 ₽ (СБП)", url: "https://pay.example/sbp" },
        { text: "⭐ 50", url: "https://t.me/invoice" },
      ],
      [{ text: "Other", callback_data: "btn_other" }],
    ],
  });
});

test("subscription offer builder keeps text price-free and toggles only subscription rows", async () => {
  const result = await runWorkflowCodeNode("Build subscription offer message", {
    callback_data: "btn_toggle_stars",
    selected_payment_source: "stars",
    text: "Subscription body only",
    payment_ui: {
      pay_with_stars_button: "⭐ Оплатить звёздами",
      pay_with_sbp_button: "Оплатить через СБП",
      subscription_stars_plan_button: "{label} · ⭐ {amount}",
      subscription_sbp_plan_button: "{label} · {amount} ₽",
    },
    payment_source_toggle_tokens: {
      stars: "btn_toggle_stars",
      sbp: "btn_toggle_sbp",
    },
    current_reply_markup: {
      inline_keyboard: [
        [{ text: "Разблокировать чат", callback_data: "btn_scene_unlock" }],
        [
          { text: "80 ₽ (СБП)", url: "https://pay.example/scene-sbp" },
          { text: "⭐ 80", url: "https://t.me/scene-stars" },
        ],
        [{ text: "7 дней · 199 ₽", url: "https://pay.example/sub-7-sbp" }],
        [{ text: "30 дней · 499 ₽", url: "https://pay.example/sub-30-sbp" }],
        [{ text: "⭐ Оплатить звёздами", callback_data: "btn_toggle_stars" }],
        [{ text: "Other", callback_data: "btn_other" }],
      ],
    },
    subscription_offer_items: [
      {
        sku: "payment_plan_7",
        payment_kind: "subscription",
        sort_order: 1,
        subscription_days: 7,
        label: "7 дней",
        payment_options: [
          {
            source: "sbp",
            amount: 199,
            currency: "RUB",
            checkout_url: "https://pay.example/sub-7-sbp",
          },
          {
            source: "stars",
            amount: 100,
            currency: "XTR",
            checkout_url: "https://t.me/sub-7-stars",
          },
        ],
      },
      {
        sku: "payment_plan_30",
        payment_kind: "subscription",
        sort_order: 2,
        subscription_days: 30,
        label: "30 дней",
        payment_options: [
          {
            source: "sbp",
            amount: 499,
            currency: "RUB",
            checkout_url: "https://pay.example/sub-30-sbp",
          },
          {
            source: "stars",
            amount: 300,
            currency: "XTR",
            checkout_url: "https://t.me/sub-30-stars",
          },
        ],
      },
    ],
  });

  assert.equal(result.text, "Subscription body only");
  assert.deepEqual(result.reply_markup, {
    inline_keyboard: [
      [{ text: "Разблокировать чат", callback_data: "btn_scene_unlock" }],
      [
        { text: "80 ₽ (СБП)", url: "https://pay.example/scene-sbp" },
        { text: "⭐ 80", url: "https://t.me/scene-stars" },
      ],
      [{ text: "7 дней · ⭐ 100", url: "https://t.me/sub-7-stars" }],
      [{ text: "30 дней · ⭐ 300", url: "https://t.me/sub-30-stars" }],
      [{ text: "Оплатить через СБП", callback_data: "btn_toggle_sbp" }],
      [{ text: "Other", callback_data: "btn_other" }],
    ],
  });
});

test("payment UI reveal topology answers callback and edits text or caption", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const answerNode = nodes.find((entry) => entry.name === "Answer payment UI callback");
  const buildNode = nodes.find((entry) => entry.name === "Build feature payment options reveal");
  const routeNode = nodes.find((entry) => entry.name === "Route feature payment edit target");
  const editTextNode = nodes.find((entry) => entry.name === "Edit feature payment text");
  const editCaptionNode = nodes.find((entry) => entry.name === "Edit feature payment caption");

  assert.equal(answerNode?.type, "n8n-nodes-base.httpRequest");
  assert.match(String(answerNode?.parameters?.url ?? ""), /answerCallbackQuery/u);
  assert.equal(buildNode?.type, "n8n-nodes-base.code");
  assert.match(String(buildNode?.parameters?.jsCode ?? ""), /current_reply_markup/u);
  assert.match(String(buildNode?.parameters?.jsCode ?? ""), /feature_payment_hint_text/u);
  assert.doesNotMatch(String(buildNode?.parameters?.jsCode ?? ""), /<i>|parse_mode/u);
  assert.equal(routeNode?.type, "n8n-nodes-base.switch");
  assert.match(String(editTextNode?.parameters?.url ?? ""), /editMessageText/u);
  assert.match(String(editCaptionNode?.parameters?.url ?? ""), /editMessageCaption/u);
  assert.doesNotMatch(String(editTextNode?.parameters?.body ?? ""), /parse_mode/u);
  assert.match(String(editTextNode?.parameters?.body ?? ""), /entities/u);
  assert.doesNotMatch(String(editCaptionNode?.parameters?.body ?? ""), /parse_mode/u);
  assert.match(String(editCaptionNode?.parameters?.body ?? ""), /caption_entities/u);
  assert.deepEqual(
    workflow.connections?.["Route operation group"]?.main?.[6]?.map((entry) => entry.node),
    ["Answer payment UI callback"],
  );
  assert.deepEqual(
    workflow.connections?.["Answer payment UI callback"]?.main?.[0]?.map((entry) => entry.node),
    ["Build feature payment options reveal"],
  );
  assert.deepEqual(
    workflow.connections?.["Build feature payment options reveal"]?.main?.[0]?.map((entry) => entry.node),
    ["Route feature payment edit target"],
  );
  assert.deepEqual(
    workflow.connections?.["Route feature payment edit target"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Edit feature payment text"],
      ["Edit feature payment caption"],
    ],
  );
});

test("subscription offer edit fallback only sends a new message for uneditable or missing messages", async () => {
  const base = {
    chat_id: 101,
    text: "fresh offer",
    reply_markup: { inline_keyboard: [] },
  };

  assert.deepEqual(
    await runPrepareRefreshedSubscriptionOfferResult(
      { error: { description: "Bad Request: message is not modified" } },
      base,
    ),
    {
      ...base,
      offer_sent: true,
      offer_reused: true,
      offer_refreshed: false,
      subscription_edit_fallback_required: false,
      reason: "subscription_offer_not_modified",
    },
  );
  assert.deepEqual(
    await runPrepareRefreshedSubscriptionOfferResult(
      { error: { description: "Bad Request: message to edit not found" } },
      base,
    ),
    {
      ...base,
      offer_sent: false,
      offer_reused: false,
      offer_refreshed: false,
      subscription_edit_fallback_required: true,
      reason: "subscription_offer_edit_fallback",
    },
  );
  assert.deepEqual(
    await runPrepareRefreshedSubscriptionOfferResult(
      { error: { description: "Bad Request: message can't be edited" } },
      base,
    ),
    {
      ...base,
      offer_sent: false,
      offer_reused: false,
      offer_refreshed: false,
      subscription_edit_fallback_required: true,
      reason: "subscription_offer_edit_fallback",
    },
  );
  await assert.rejects(
    () => runPrepareRefreshedSubscriptionOfferResult(
      { error: { description: "Bad Request: chat not found" } },
      base,
    ),
    /chat not found/u,
  );
});

test("prepare finalize subscription offer input preserves ab test context for gateway delivery mark", async () => {
  const base = {
    chat_id: 101,
    offer_message_id: 777,
    subscription_invoice_tokens: ["token-1"],
    ab_test: {
      key: "subscription_offer",
      starts_at: "2020-01-01T00:00:00+00:00",
      version: "v2",
      variant: "B",
    },
  };

  assert.deepEqual(
    await runPrepareFinalizeSubscriptionOfferInput(
      { result: { message_id: 888 }, offer_sent: true },
      base,
    ),
    {
      ...base,
      result: { message_id: 888 },
      offer_sent: true,
      interaction_mode: "finalize_subscription_offer",
      callback_query_id: null,
      callback_data: null,
      offer_message_id: 888,
    },
  );
  assert.deepEqual(
    await runPrepareFinalizeSubscriptionOfferInput(
      { reason: "subscription_offer_not_modified" },
      base,
    ),
    {
      ...base,
      reason: "subscription_offer_not_modified",
      interaction_mode: "finalize_subscription_offer",
      callback_query_id: null,
      callback_data: null,
      offer_message_id: 777,
    },
  );
});

test("commerce workflow does not branch on ab variants", async () => {
  const raw = await loadWorkflowRaw();

  assert.doesNotMatch(raw, /ab_test\.variant/u);
  assert.doesNotMatch(raw, /variant\s*={2,3}/u);
  assert.doesNotMatch(raw, /variant\s*!={1,2}/u);
  assert.doesNotMatch(raw, /EXP_[A-Z0-9_]+_JSON/u);
});

test("free action fulfillment topology answers Telegram callback before continuing fulfillment", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const needNode = nodes.find((entry) => entry.name === "Need free action callback answer?");
  const answerNode = nodes.find((entry) => entry.name === "Answer free action callback");
  const restoreNode = nodes.find((entry) => entry.name === "Restore free action fulfillment context");

  assert.equal(needNode?.type, "n8n-nodes-base.if");
  assert.match(String(needNode?.parameters?.conditions?.conditions?.[0]?.leftValue ?? ""), /free_fast_scene_skip/u);
  assert.match(String(needNode?.parameters?.conditions?.conditions?.[0]?.leftValue ?? ""), /free_scene_unlock_redeemed/u);
  assert.equal(answerNode?.type, "n8n-nodes-base.httpRequest");
  assert.match(String(answerNode?.parameters?.url ?? ""), /answerCallbackQuery/u);
  assert.equal(
    String(answerNode?.parameters?.body ?? ""),
    '={{ JSON.stringify({ callback_query_id: String($json.callback_query_id ?? "") }) }}',
  );
  assert.match(String(restoreNode?.parameters?.jsCode ?? ""), /Need free action callback answer/u);
  assert.deepEqual(
    workflow.connections?.["Route operation group"]?.main?.[4]?.map((entry) => entry.node),
    ["Need free action callback answer?"],
  );
  assert.deepEqual(
    workflow.connections?.["Need free action callback answer?"]?.main?.map((output) =>
      output.map((entry) => entry.node)
    ),
    [
      ["Answer free action callback"],
      ["Prepare payment fulfillment context"],
    ],
  );
  assert.deepEqual(
    workflow.connections?.["Answer free action callback"]?.main?.[0]?.map((entry) => entry.node),
    ["Restore free action fulfillment context"],
  );
  assert.deepEqual(
    workflow.connections?.["Restore free action fulfillment context"]?.main?.[0]?.map((entry) => entry.node),
    ["Prepare payment fulfillment context"],
  );
});
