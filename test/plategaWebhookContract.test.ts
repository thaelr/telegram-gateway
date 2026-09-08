import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type WorkflowNode = {
  name?: string;
  type?: string;
  parameters?: {
    responseMode?: string;
    jsCode?: string;
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
  const workflowPath = path.resolve(
    process.cwd(),
    "..",
    "..",
    "Актуальные",
    "RUS Media Commerce Flow v3.json",
  );
  const raw = await readFile(workflowPath, "utf8");
  return JSON.parse(raw) as Workflow;
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
