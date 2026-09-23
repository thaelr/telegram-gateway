import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.SBP_ENABLED = "true";
process.env.SBP_API_BASE_URL ??= "https://platega.example/api";
process.env.SBP_MERCHANT_ID ??= "merchant-1";
process.env.SBP_API_SECRET ??= "secret-1";
process.env.SBP_RETURN_URL ??= "https://t.me/yufi_bot?start=payment_success";
process.env.SBP_FAILED_URL ??= "https://t.me/yufi_bot?start=payment_failed";
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_2",
    days: 14,
    amount_xtr: 200,
    amount_rub: 299,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 10,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_action_1",
    feature_key: "fast_scene_skip",
    amount_xtr: 50,
    amount_rub: 80,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);

const { config } = await import("../src/config.js");

config.SBP_ENABLED = true;
config.SBP_API_BASE_URL = process.env.SBP_API_BASE_URL ?? "https://platega.example/api";
config.SBP_MERCHANT_ID = process.env.SBP_MERCHANT_ID ?? "merchant-1";
config.SBP_API_SECRET = process.env.SBP_API_SECRET ?? "secret-1";
config.SBP_RETURN_URL = process.env.SBP_RETURN_URL ?? "https://t.me/yufi_bot?start=payment_success";
config.SBP_FAILED_URL = process.env.SBP_FAILED_URL ?? "https://t.me/yufi_bot?start=payment_failed";

const {
  SBP_PAYMENT_REQUEST_TIMEOUT_MS,
  SbpPaymentAdapter,
  SbpPaymentError,
} = await import("../src/payments/sbp.js");

test("SbpPaymentAdapter sends Platega transaction/process request and maps response", async () => {
  const adapter = new SbpPaymentAdapter();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      init,
    });

    return new Response(JSON.stringify({
      transactionId: "platega-transaction-1",
      redirect: "https://pay.platega.example/redirect/1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await adapter.createPayment({
      token: "payment-token-1",
      chat_id: 1318122313,
      description: "Пропустить вступление",
      amount_rub: 80,
    });

    assert.deepEqual(result, {
      external_payment_id: "platega-transaction-1",
      checkout_url: "https://pay.platega.example/redirect/1",
      provider_expires_at: null,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://platega.example/api/transaction/process");
    assert.equal((requests[0]?.init?.method ?? "").toUpperCase(), "POST");
    assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
    assert.ok(SBP_PAYMENT_REQUEST_TIMEOUT_MS < 120_000);
    assert.deepEqual(requests[0]?.init?.headers, {
      "content-type": "application/json",
      "X-MerchantId": "merchant-1",
      "X-Secret": "secret-1",
    });
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body ?? "{}")), {
      paymentMethod: 2,
      paymentDetails: {
        amount: 80,
        currency: "RUB",
      },
      description: "Пропустить вступление",
      return: "https://t.me/yufi_bot?start=payment_success",
      failedUrl: "https://t.me/yufi_bot?start=payment_failed",
      payload: "payment-token-1",
      metadata: {
        userId: 1318122313,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SbpPaymentAdapter maps valid expiresIn and keeps invalid or missing expiry nullable", async () => {
  const adapter = new SbpPaymentAdapter();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const baseNow = Date.parse("2026-09-22T10:00:00.000Z");
  const cases = [
    {
      name: "valid",
      expiresIn: "01:02:03",
      expected: "2026-09-22T11:02:03.000Z",
    },
    { name: "zero", expiresIn: "00:00:00", expected: null },
    { name: "invalid", expiresIn: "1:99:00", expected: null },
    { name: "missing", expiresIn: undefined, expected: null },
  ] as const;

  Date.now = () => baseNow;
  try {
    for (const entry of cases) {
      globalThis.fetch = async () => {
        const body: Record<string, unknown> = {
          transactionId: `platega-${entry.name}`,
          redirect: `https://pay.platega.example/${entry.name}`,
        };
        if (entry.expiresIn !== undefined) body.expiresIn = entry.expiresIn;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const result = await adapter.createPayment({
        token: `payment-token-${entry.name}`,
        chat_id: 1318122313,
        description: "Пропустить вступление",
        amount_rub: 80,
      });

      assert.equal(result.provider_expires_at, entry.expected, entry.name);
    }
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("SbpPaymentAdapter throws stable error code on malformed Platega response", async () => {
  const adapter = new SbpPaymentAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      transactionId: "",
      redirect: "",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        adapter.createPayment({
          token: "payment-token-1",
          chat_id: 1318122313,
          description: "Пропустить вступление",
          amount_rub: 80,
        }),
      (error: unknown) =>
        error instanceof SbpPaymentError
        && error.code === "sbp_payment_creation_failed"
        && error.stage === "response"
        && error.statusCode === 200
        && error.outcome === "ambiguous",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SbpPaymentAdapter treats 400, 408, and 5xx as ambiguous by default", async () => {
  const adapter = new SbpPaymentAdapter();
  const originalFetch = globalThis.fetch;

  try {
    for (const status of [400, 408, 500]) {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: `provider-${status}` }),
        { status, headers: { "content-type": "application/json" } },
      );
      await assert.rejects(
        () => adapter.createPayment({
          token: `payment-token-${status}`,
          chat_id: 1318122313,
          description: "Пропустить вступление",
          amount_rub: 80,
        }),
        (error: unknown) => error instanceof SbpPaymentError
          && error.statusCode === status
          && error.outcome === "ambiguous",
        String(status),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SbpPaymentAdapter treats network and timeout failures as ambiguous", async () => {
  const adapter = new SbpPaymentAdapter();
  const originalFetch = globalThis.fetch;

  try {
    for (const failure of [new TypeError("network down"), new DOMException("timed out", "TimeoutError")]) {
      globalThis.fetch = async () => { throw failure; };
      await assert.rejects(
        () => adapter.createPayment({
          token: "payment-token-network",
          chat_id: 1318122313,
          description: "Пропустить вступление",
          amount_rub: 80,
        }),
        (error: unknown) => error instanceof SbpPaymentError
          && error.stage === "request"
          && error.outcome === "ambiguous",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
