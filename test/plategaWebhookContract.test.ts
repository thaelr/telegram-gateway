import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type WorkflowNode = {
  name?: string;
  type?: string;
  continueOnFail?: boolean;
  parameters?: {
    body?: string;
    conditions?: {
      conditions?: Array<{
        leftValue?: string;
      }>;
    };
    responseMode?: string;
    jsCode?: string;
    url?: string;
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
    "RUS Media Commerce Flow v3.json",
  );
  return readFile(workflowPath, "utf8");
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
        amount: 299,
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
    payment_total_amount: 299,
    checkout_url: null,
    source: "sbp_webhook",
    sbp_webhook_action: "confirmed",
    response_code: 200,
    reason: null,
    raw_update: {
      headers: {
        "x-merchantid": "merchant-1",
        "x-secret": "secret-1",
      },
      body: {
        id: "platega-transaction-1",
        status: "CONFIRMED",
        amount: 299,
        currency: "RUB",
      },
    },
  });
  assert.equal("payment_token" in normalized, false);
  assert.equal("chat_id" in normalized, false);
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
  assert.equal(normalized.payment_total_amount, 299);
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

test("SBP webhook topology calls gateway only for confirmed route and responds through response node", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const webhook = nodes.find((entry) => entry.name === "SBP payment webhook");

  assert.equal(webhook?.parameters?.responseMode, "responseNode");
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
      ["Return SBP webhook ignored"],
      ["Return SBP webhook invalid"],
    ],
  );
  assert.deepEqual(
    workflow.connections?.["Send SBP payment event to gateway"]?.main?.[0]?.map((entry) => entry.node),
    ["Route operation group", "Return SBP webhook success"],
  );
});

test("subscription offer topology refreshes an existing offer message instead of skipping render", async () => {
  const workflow = await loadWorkflow();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const editNode = nodes.find((entry) => entry.name === "Edit subscription offer message");
  const prepareNode = nodes.find((entry) => entry.name === "Prepare refreshed subscription offer result");
  const fallbackNode = nodes.find((entry) => entry.name === "Need subscription edit fallback?");

  assert.equal(editNode?.type, "n8n-nodes-base.httpRequest");
  assert.equal(editNode?.continueOnFail, true);
  assert.match(String(editNode?.parameters?.url ?? ""), /editMessageText/u);
  assert.match(String(editNode?.parameters?.body ?? ""), /message_id/u);
  assert.match(String(editNode?.parameters?.body ?? ""), /reply_markup/u);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message is not modified/i);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message to edit not found/i);
  assert.match(String(prepareNode?.parameters?.jsCode ?? ""), /message can't be edited/i);
  assert.equal(fallbackNode?.type, "n8n-nodes-base.if");
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
