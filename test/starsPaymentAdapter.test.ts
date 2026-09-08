import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_2",
    days: 14,
    amount_xtr: 200,
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
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);

const {
  TelegramStarsInvoiceError,
  TelegramStarsPaymentAdapter,
} = await import("../src/payments/stars.js");

test("TelegramStarsPaymentAdapter returns invoice link on successful response", async () => {
  const adapter = new TelegramStarsPaymentAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      ok: true,
      result: "https://t.me/invoice-success",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const result = await adapter.createStarsInvoice({
      title: "title",
      description: "description",
      payload: "payload",
      label: "label",
      amount_xtr: 123,
    });

    assert.equal(result.invoice_link, "https://t.me/invoice-success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramStarsPaymentAdapter throws on non-OK HTTP status", async () => {
  const adapter = new TelegramStarsPaymentAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        adapter.createStarsInvoice({
          title: "title",
          description: "description",
          payload: "payload",
          label: "label",
          amount_xtr: 123,
        }),
      (error: unknown) =>
        error instanceof TelegramStarsInvoiceError
        && error.code === "stars_invoice_creation_failed"
        && error.stage === "response"
        && error.statusCode === 400
        && error.description === "Bad Request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramStarsPaymentAdapter throws when Telegram returns ok !== true", async () => {
  const adapter = new TelegramStarsPaymentAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      ok: false,
      error_code: 500,
      description: "Telegram error",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        adapter.createStarsInvoice({
          title: "title",
          description: "description",
          payload: "payload",
          label: "label",
          amount_xtr: 123,
        }),
      (error: unknown) =>
        error instanceof TelegramStarsInvoiceError
        && error.code === "stars_invoice_creation_failed"
        && error.stage === "response"
        && error.statusCode === 500
        && error.description === "Telegram error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramStarsPaymentAdapter throws when result is empty", async () => {
  const adapter = new TelegramStarsPaymentAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      ok: true,
      result: "",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        adapter.createStarsInvoice({
          title: "title",
          description: "description",
          payload: "payload",
          label: "label",
          amount_xtr: 123,
        }),
      (error: unknown) =>
        error instanceof TelegramStarsInvoiceError
        && error.stage === "response",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
