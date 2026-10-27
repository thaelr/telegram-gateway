import { createHmac, timingSafeEqual } from "node:crypto";
import { compareDecimals, normalizeDecimal, ProviderError, type PaymentProvider, type ProviderCheckout, type ProviderCreateInput, type ProviderPayment } from "./providers.js";

export type NowPaymentsOptions = {
  apiKey: string;
  ipnSecret: string;
  callbackUrl: string;
  successUrl: string;
  cancelUrl: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};
type JsonRecord = Record<string, unknown>;

/** The documented recursive alphabetic-key canonicalization. */
export function canonicalNowPaymentsJson(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as JsonRecord)[key])]));
    }
    return item;
  }
  return JSON.stringify(sort(value));
}

function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("NOWPayments URLs must use HTTPS without credentials");
  return url.toString();
}

/** Preserve top-level number lexemes and reject duplicate keys. JSON.parse alone loses precision. */
function parseBody(raw: string): { object: JsonRecord; rawFields: Map<string, string> } {
  if (raw.length > 65_536) throw new ProviderError("invalid_provider_payload", "definite_failure", 400);
  let object: unknown;
  try { object = JSON.parse(raw); } catch { throw new ProviderError("invalid_provider_payload", "definite_failure", 400); }
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new ProviderError("invalid_provider_payload", "definite_failure", 400);
  const fields = new Map<string, string>();
  let index = 0;
  const ws = () => { while (/\s/u.test(raw[index] ?? "") && index < raw.length) index++; };
  const stringEnd = () => {
    index++;
    while (index < raw.length) {
      if (raw[index] === "\\") { index += 2; continue; }
      if (raw[index++] === '"') return;
    }
  };
  const skipValue = () => {
    if (raw[index] === '"') { stringEnd(); return; }
    if (raw[index] === "{" || raw[index] === "[") {
      let depth = 0;
      do {
        if (raw[index] === '"') { stringEnd(); continue; }
        if (raw[index] === "{" || raw[index] === "[") depth++;
        if (raw[index] === "}" || raw[index] === "]") depth--;
        index++;
      } while (depth > 0 && index < raw.length);
      return;
    }
    while (index < raw.length && !/[\s,}]/u.test(raw[index]!)) index++;
  };
  ws(); index++; ws();
  while (raw[index] !== "}") {
    const keyStart = index; stringEnd();
    const key = JSON.parse(raw.slice(keyStart, index)) as string;
    if (fields.has(key)) throw new ProviderError("duplicate_provider_field", "definite_failure", 400);
    ws(); index++; ws();
    const valueStart = index; skipValue();
    fields.set(key, raw.slice(valueStart, index));
    ws(); if (raw[index] === "}") break;
    index++; ws();
  }
  return { object: object as JsonRecord, rawFields: fields };
}

function fieldText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw new ProviderError(`invalid_${name}`, "definite_failure", 400);
  return value;
}
function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{2,24}$/iu.test(value)) throw new ProviderError("invalid_currency", "definite_failure", 400);
  return value.toUpperCase();
}
function exactDecimal(parsed: ReturnType<typeof parseBody>, key: string, optional = false): string | null {
  const value = parsed.object[key];
  if (optional && (value == null)) return null;
  if (typeof value !== "number" && typeof value !== "string") throw new ProviderError(`invalid_${key}`, "definite_failure", 400);
  const raw = typeof value === "number" ? parsed.rawFields.get(key)! : value;
  const decimal = normalizeDecimal(raw);
  // A signature over JS's canonical number cannot authenticate extra rounded digits.
  // Fail closed for those numeric literals; exact decimal strings remain supported.
  if (typeof value === "number" && normalizeDecimal(value) !== decimal) throw new ProviderError("unsafe_numeric_precision", "definite_failure", 400);
  return decimal;
}
function identifier(parsed: ReturnType<typeof parseBody>, key: string, optional = false): string | null {
  const value = parsed.object[key];
  if (optional && value == null) return null;
  const result = exactDecimal(parsed, key);
  if (!result || !/^[1-9]\d{0,39}$/u.test(result)) throw new ProviderError(`invalid_${key}`, "definite_failure", 400);
  return result;
}

function normalizedPayment(raw: string): ProviderPayment {
  const parsed = parseBody(raw);
  const object = parsed.object;
  const status = fieldText(object.payment_status, "payment_status");
  if (!["waiting", "confirming", "confirmed", "sending", "partially_paid", "finished", "failed", "refunded", "expired"].includes(status)) throw new ProviderError("unknown_payment_status", "definite_failure", 400);
  const payAmount = exactDecimal(parsed, "pay_amount", status !== "finished");
  const paidAmount = exactDecimal(parsed, "actually_paid", status !== "finished");
  const payCurrency = object.pay_currency == null && status !== "finished" ? null : currency(object.pay_currency);
  const full = payAmount != null && paidAmount != null && compareDecimals(payAmount, "0") > 0 && compareDecimals(paidAmount, payAmount) >= 0;
  const state: ProviderPayment["status"] = status === "finished" ? (full ? "paid" : "partial")
    : status === "partially_paid" ? "partial" : status === "failed" ? "failed"
      : status === "expired" ? "expired" : status === "refunded" ? "refunded" : "pending";
  return {
    provider: "nowpayments", order_id: object.order_id == null ? null : fieldText(object.order_id, "order_id"),
    external_payment_id: identifier(parsed, "payment_id")!, external_invoice_id: identifier(parsed, "invoice_id", true),
    status: state, price_amount: exactDecimal(parsed, "price_amount")!, price_currency: currency(object.price_currency),
    pay_amount: payAmount, paid_amount: paidAmount, pay_currency: payCurrency, raw_status: status,
  };
}

export class NowPaymentsProvider implements PaymentProvider {
  readonly id = "nowpayments";
  readonly platforms = ["web"] as const;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: NowPaymentsOptions) {
    this.base = httpsUrl(options.apiBaseUrl ?? "https://api.nowpayments.io/v1").replace(/\/+$/u, "");
    for (const url of [options.callbackUrl, options.successUrl, options.cancelUrl]) httpsUrl(url);
    if (!options.apiKey || !options.ipnSecret) throw new Error("NOWPayments API and IPN credentials are required");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("Invalid NOWPayments timeout");
    this.fetcher = options.fetchImpl ?? fetch;
  }

  private async request(path: string, body?: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method: body == null ? "GET" : "POST",
        headers: { "x-api-key": this.options.apiKey, "content-type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), ...(body == null ? {} : { body }),
      });
    } catch { throw new ProviderError("provider_request_ambiguous", "ambiguous"); }
    if (!response.ok) {
      const definite = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
      throw new ProviderError("provider_request_failed", definite ? "definite_failure" : "ambiguous");
    }
    let text: string;
    try { text = await response.text(); } catch { throw new ProviderError("provider_response_ambiguous", "ambiguous"); }
    if (text.length > 65_536) throw new ProviderError("provider_response_ambiguous", "ambiguous");
    return text;
  }

  async create(input: ProviderCreateInput): Promise<ProviderCheckout> {
    const amount = normalizeDecimal(input.amount);
    if (compareDecimals(amount, "0") <= 0) throw new ProviderError("invalid_amount", "definite_failure", 400);
    const orderId = fieldText(input.order_id, "order_id");
    const priceCurrency = currency(input.currency).toLowerCase();
    if (priceCurrency === "xtr") throw new ProviderError("unsupported_price_currency", "definite_failure", 400);
    const fields = JSON.stringify({ price_currency: priceCurrency, order_id: orderId, order_description: input.description.slice(0, 500), ipn_callback_url: this.options.callbackUrl, success_url: this.options.successUrl, cancel_url: this.options.cancelUrl });
    // Decimal text is validated above and injected only as a JSON number; no floating conversion.
    const body = `{"price_amount":${amount},${fields.slice(1)}`;
    const raw = await this.request("/invoice", body);
    try {
      const parsed = parseBody(raw);
      const id = identifier(parsed, "id")!;
      const checkout = httpsUrl(fieldText(parsed.object.invoice_url, "invoice_url"));
      if (parsed.object.order_id !== orderId || currency(parsed.object.price_currency) !== priceCurrency.toUpperCase()
        || compareDecimals(exactDecimal(parsed, "price_amount")!, amount) !== 0) throw new Error("Invoice association mismatch");
      return { external_id: id, external_kind: "invoice", checkout_url: checkout, expires_at: null };
    } catch { throw new ProviderError("provider_response_ambiguous", "ambiguous"); }
  }

  verifyNotification(rawBody: string, signature: string | undefined): ProviderPayment {
    if (!signature || !/^[a-f0-9]{128}$/iu.test(signature)) throw new ProviderError("invalid_ipn_signature", "definite_failure", 401);
    const parsed = parseBody(rawBody);
    const expected = createHmac("sha512", this.options.ipnSecret).update(canonicalNowPaymentsJson(parsed.object)).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new ProviderError("invalid_ipn_signature", "definite_failure", 401);
    return normalizedPayment(rawBody);
  }

  async getStatus(paymentId: string): Promise<ProviderPayment> {
    if (!/^[1-9]\d{0,39}$/u.test(paymentId)) throw new ProviderError("invalid_payment_id", "definite_failure", 400);
    const payment = normalizedPayment(await this.request(`/payment/${encodeURIComponent(paymentId)}`));
    if (payment.external_payment_id !== paymentId) throw new ProviderError("provider_payment_mismatch", "ambiguous");
    return payment;
  }
}
