import test from "node:test";
import assert from "node:assert/strict";
import { PaymentProviderRegistry, SbpProvider, StarsProvider, type PaymentProvider, type ProviderCreateInput } from "../src/payments/providers.js";

const input: ProviderCreateInput = { order_id: "order-1", attempt_id: "attempt-1", amount: "123", currency: "RUB", description: "Server product", chat_id: 8000000000000001 };

test("SBP facade retains integer RUB, persisted attempt token, internal chat context and status", async () => {
  const calls: unknown[] = [];
  const provider = new SbpProvider({
    async createPayment(value) { calls.push(value); return { external_payment_id: "external-1", checkout_url: "https://platega.example/pay", provider_expires_at: null }; },
    async getTransactionStatus(id) { assert.equal(id, "external-1"); return "CONFIRMED"; },
  });
  assert.equal((await provider.create(input)).external_id, "external-1");
  assert.deepEqual(calls[0], { token: "attempt-1", chat_id: input.chat_id, description: input.description, amount_rub: 123, metadata: { order_id: "order-1", attempt_id: "attempt-1" } });
  assert.equal((await provider.getStatus("external-1", input)).status, "paid");
  await assert.rejects(provider.getStatus("external-1"), { code: "status_context_required" });
});

test("Stars facade preserves existing invoice payload/XTR and stays unavailable to Web", async () => {
  const provider = new StarsProvider({ async createStarsInvoice(value) {
    assert.deepEqual(value, { title: "Title", description: input.description, payload: "old-invoice-payload", label: "Label", amount_xtr: 123 });
    return { invoice_link: "https://t.me/invoice" };
  } });
  const result = await provider.create({ ...input, currency: "XTR", telegram_invoice: { title: "Title", label: "Label", payload: "old-invoice-payload" } });
  assert.equal(result.external_id, "old-invoice-payload");
  const registry = new PaymentProviderRegistry([provider]);
  assert.deepEqual(registry.list("web"), []);
  assert.deepEqual(registry.list("telegram"), ["stars"]);
  assert.throws(() => registry.get("stars", "web"), { code: "payment_provider_unavailable" });
});

test("fourth test provider is registered and used without modifying product or fulfillment logic", async () => {
  const testProvider: PaymentProvider = {
    id: "test_provider", platforms: ["web"],
    async create(value) { assert.equal(value.order_id, input.order_id); return { external_id: "test-1", external_kind: "payment", checkout_url: "https://test.example/checkout", expires_at: null }; },
    async getStatus(paymentId, expected) { assert.ok(expected); return { provider: "test_provider", order_id: expected.order_id, external_payment_id: paymentId, external_invoice_id: null, status: "paid", price_amount: expected.amount, price_currency: expected.currency, pay_amount: expected.amount, paid_amount: expected.amount, pay_currency: expected.currency, raw_status: "settled" }; },
  };
  const registry = new PaymentProviderRegistry([testProvider]);
  const adapter = registry.get("test_provider", "web");
  const checkout = await adapter.create(input);
  assert.equal((await adapter.getStatus!(checkout.external_id, input)).status, "paid");
  assert.throws(() => registry.register(testProvider), /duplicate/u);
});
