import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalNowPaymentsJson, NowPaymentsProvider } from "../src/payments/nowpayments.js";
import { compareDecimals, normalizeDecimal, ProviderError, type ProviderCreateInput } from "../src/payments/providers.js";

const secret = "test-ipn-secret-with-no-real-value";
const options = { apiKey: "test-api-key", ipnSecret: secret, callbackUrl: "https://gateway.example/web/commerce/nowpayments/ipn", successUrl: "https://web.example/return", cancelUrl: "https://web.example/cancel" };
const order: ProviderCreateInput = { order_id: "order-1", attempt_id: "attempt-1", amount: "100.25", currency: "RUB", description: "Server product" };
const payment = { payment_id: "123456", invoice_id: "654321", order_id: "order-1", payment_status: "finished", price_amount: "100.25", price_currency: "rub", pay_amount: "0.001000000000000001", actually_paid: "0.001000000000000001", pay_currency: "btc" };
const sign = (payload: unknown) => createHmac("sha512", secret).update(canonicalNowPaymentsJson(payload)).digest("hex");
const mock = (fn: (url: string, init: RequestInit) => Promise<Response>) => ((url, init) => fn(String(url), init ?? {})) as typeof fetch;
const reply = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("NOW hosted invoice uses server price and saves distinct invoice ID", async () => {
  const adapter = new NowPaymentsProvider({ ...options, fetchImpl: mock(async (url, init) => {
    assert.equal(url, "https://api.nowpayments.io/v1/invoice");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>)["x-api-key"], options.apiKey);
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { price_amount: 100.25, price_currency: "rub", order_id: "order-1", order_description: "Server product", ipn_callback_url: options.callbackUrl, success_url: options.successUrl, cancel_url: options.cancelUrl });
    assert.equal("pay_currency" in body, false);
    return reply({ id: "654321", order_id: "order-1", price_amount: "100.25", price_currency: "rub", invoice_url: "https://nowpayments.io/payment/?iid=654321" });
  }) });
  assert.deepEqual(await adapter.create(order), { external_id: "654321", external_kind: "invoice", checkout_url: "https://nowpayments.io/payment/?iid=654321", expires_at: null });
});

test("NOW signed finished payment normalizes exact crypto decimals without comparing to fiat", () => {
  const adapter = new NowPaymentsProvider(options);
  const result = adapter.verifyNotification(JSON.stringify(payment), sign(payment));
  assert.equal(result.status, "paid");
  assert.equal(result.price_amount, "100.25");
  assert.equal(result.price_currency, "RUB");
  assert.equal(result.pay_amount, "0.001000000000000001");
  assert.equal(result.paid_amount, "0.001000000000000001");
  assert.equal(result.pay_currency, "BTC");
  assert.equal(result.external_invoice_id, "654321");
  assert.equal(result.external_payment_id, "123456");
  const underpaid = { ...payment, actually_paid: "0.001" };
  assert.equal(adapter.verifyNotification(JSON.stringify(underpaid), sign(underpaid)).status, "partial");
});

test("NOW only fully paid finished status is eligible, other statuses stay distinct", () => {
  const adapter = new NowPaymentsProvider(options);
  for (const [providerStatus, expected] of Object.entries({ waiting: "pending", confirming: "pending", confirmed: "pending", sending: "pending", partially_paid: "partial", failed: "failed", expired: "expired", refunded: "refunded" })) {
    const body = { ...payment, payment_status: providerStatus };
    assert.equal(adapter.verifyNotification(JSON.stringify(body), sign(body)).status, expected);
  }
  const zero = { ...payment, pay_amount: "0", actually_paid: "0" };
  assert.equal(adapter.verifyNotification(JSON.stringify(zero), sign(zero)).status, "partial");
  const unknown = { ...payment, payment_status: "some_future_status" };
  assert.throws(() => adapter.verifyNotification(JSON.stringify(unknown), sign(unknown)), { code: "unknown_payment_status" });
});

test("NOW IPN signature recursively sorts nested keys and fails closed when tampered", () => {
  const adapter = new NowPaymentsProvider(options);
  const payload = { ...payment, fee: { withdrawalFee: 0, currency: "btc", depositFee: 0.002 }, payment_extra_ids: [1, 2] };
  assert.equal(adapter.verifyNotification(JSON.stringify(payload), sign(payload)).status, "paid");
  assert.throws(() => adapter.verifyNotification(JSON.stringify(payload), undefined), { code: "invalid_ipn_signature" });
  assert.throws(() => adapter.verifyNotification(JSON.stringify(payload), "0".repeat(128)), { code: "invalid_ipn_signature" });
  assert.throws(() => adapter.verifyNotification(JSON.stringify({ ...payload, order_id: "another-order" }), sign(payload)), { code: "invalid_ipn_signature" });
});

test("NOW rejects duplicated fields and numeric precision that cannot be authenticated exactly", () => {
  const adapter = new NowPaymentsProvider(options);
  const duplicate = JSON.stringify(payment).replace('"payment_id":"123456"', '"payment_id":"7","payment_id":"123456"');
  assert.throws(() => adapter.verifyNotification(duplicate, sign(payment)), { code: "duplicate_provider_field" });
  const raw = JSON.stringify(payment).replace('"actually_paid":"0.001000000000000001"', '"actually_paid":0.12345678901234567890123456789');
  assert.throws(() => adapter.verifyNotification(raw, sign(JSON.parse(raw))), { code: "unsafe_numeric_precision" });
});

test("NOW signed missing full-payment evidence cannot grant rights", () => {
  const adapter = new NowPaymentsProvider(options);
  for (const key of ["pay_amount", "actually_paid", "pay_currency", "price_amount", "payment_id"]) {
    const body: Record<string, unknown> = { ...payment };
    delete body[key];
    assert.throws(() => adapter.verifyNotification(JSON.stringify(body), sign(body)), ProviderError);
  }
});

test("NOW create timeout and malformed successful response remain ambiguous, with no automatic retry", async () => {
  let calls = 0;
  const adapter = new NowPaymentsProvider({ ...options, fetchImpl: mock(async () => { calls++; throw new Error("timeout after remote creation"); }) });
  await assert.rejects(adapter.create(order), { outcome: "ambiguous" });
  assert.equal(calls, 1);
  const malformed = new NowPaymentsProvider({ ...options, fetchImpl: mock(async () => reply({ id: "654321", order_id: "wrong", price_amount: "100.25", price_currency: "rub", invoice_url: "https://nowpayments.io/payment/?iid=654321" })) });
  await assert.rejects(malformed.create(order), { outcome: "ambiguous" });
  const rejected = new NowPaymentsProvider({ ...options, fetchImpl: mock(async () => reply({}, 400)) });
  await assert.rejects(rejected.create(order), { outcome: "definite_failure" });
});

test("NOW fetches status by payment ID and checks response association", async () => {
  const adapter = new NowPaymentsProvider({ ...options, fetchImpl: mock(async (url) => {
    assert.equal(url, "https://api.nowpayments.io/v1/payment/123456"); return reply(payment);
  }) });
  assert.equal((await adapter.getStatus("123456")).status, "paid");
  const wrong = new NowPaymentsProvider({ ...options, fetchImpl: mock(async () => reply({ ...payment, payment_id: "987654" })) });
  await assert.rejects(wrong.getStatus("123456"), { code: "provider_payment_mismatch" });
});

test("decimal utilities preserve scale and reject non-money values", () => {
  assert.equal(normalizeDecimal("0001.23000"), "1.23");
  assert.equal(normalizeDecimal("1e-18"), "0.000000000000000001");
  assert.equal(compareDecimals("0.100000000000000000001", "0.1"), 1);
  assert.equal(compareDecimals("100.00", "1e2"), 0);
  for (const value of ["-1", "NaN", "Infinity", "1e9999", "1.2.3"]) assert.throws(() => normalizeDecimal(value), ProviderError);
});
