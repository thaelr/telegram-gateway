import type { SbpPaymentClient } from "./sbp.js";
import type { StarsInvoiceClient } from "./stars.js";

export type PaymentPlatform = "telegram" | "web";
export type ProviderCreateInput = {
  order_id: string;
  attempt_id: string;
  amount: string;
  currency: string;
  description: string;
  chat_id?: number;
  telegram_invoice?: { title: string; label: string; payload: string };
};
export type ProviderCheckout = {
  external_id: string;
  external_kind: "invoice" | "payment";
  checkout_url: string;
  expires_at: string | null;
};
export type ProviderPayment = {
  provider: string;
  order_id: string | null;
  external_payment_id: string;
  external_invoice_id: string | null;
  status: "pending" | "paid" | "partial" | "failed" | "expired" | "refunded";
  price_amount: string;
  price_currency: string;
  pay_amount: string | null;
  paid_amount: string | null;
  pay_currency: string | null;
  raw_status: string;
};
export interface PaymentProvider {
  readonly id: string;
  readonly platforms: readonly PaymentPlatform[];
  create(input: ProviderCreateInput): Promise<ProviderCheckout>;
  getStatus?(paymentId: string, expected?: ProviderCreateInput): Promise<ProviderPayment>;
  verifyNotification?(rawBody: string, signature: string | undefined): ProviderPayment;
}
export class ProviderError extends Error {
  constructor(readonly code: string, readonly outcome: "definite_failure" | "ambiguous", readonly statusCode = 502) {
    super(code);
  }
}

/** Decimal strings stay decimal strings in storage and comparison. */
export function normalizeDecimal(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || text.length > 160) throw new ProviderError("invalid_amount", "definite_failure", 400);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) throw new ProviderError("invalid_amount", "definite_failure", 400);
  const integer = match[1]!;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80) throw new ProviderError("invalid_amount", "definite_failure", 400);
  const digits = integer + fraction;
  const point = integer.length + exponent;
  let whole: string;
  let decimal: string;
  if (point <= 0) { whole = "0"; decimal = "0".repeat(-point) + digits; }
  else if (point >= digits.length) { whole = digits + "0".repeat(point - digits.length); decimal = ""; }
  else { whole = digits.slice(0, point); decimal = digits.slice(point); }
  whole = whole.replace(/^0+(?=\d)/u, "");
  decimal = decimal.replace(/0+$/u, "");
  if (whole.length > 80 || decimal.length > 80) throw new ProviderError("invalid_amount", "definite_failure", 400);
  return decimal ? `${whole}.${decimal}` : whole;
}
export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const [li, lf = ""] = normalizeDecimal(left).split(".");
  const [ri, rf = ""] = normalizeDecimal(right).split(".");
  const scale = Math.max(lf.length, rf.length);
  const l = BigInt(li! + lf.padEnd(scale, "0"));
  const r = BigInt(ri! + rf.padEnd(scale, "0"));
  return l < r ? -1 : l > r ? 1 : 0;
}
function positiveSafeInteger(value: string): number {
  const decimal = normalizeDecimal(value);
  const number = Number(decimal);
  if (decimal.includes(".") || !Number.isSafeInteger(number) || number <= 0) throw new ProviderError("invalid_amount", "definite_failure", 400);
  return number;
}

/** Registry knows platforms and adapters, never SKUs or fulfillment rules. */
export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();
  constructor(providers: PaymentProvider[] = []) { for (const provider of providers) this.register(provider); }
  register(provider: PaymentProvider): void {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(provider.id) || this.providers.has(provider.id)) throw new Error("Invalid or duplicate payment provider");
    this.providers.set(provider.id, provider);
  }
  get(id: string, platform?: PaymentPlatform): PaymentProvider {
    const provider = this.providers.get(id);
    if (!provider || (platform != null && !provider.platforms.includes(platform))) throw new ProviderError("payment_provider_unavailable", "definite_failure", 400);
    return provider;
  }
  list(platform: PaymentPlatform): string[] { return [...this.providers.values()].filter((provider) => provider.platforms.includes(platform)).map((provider) => provider.id); }
}

/** Compatibility facade; Stars payment confirmation continues through verified Telegram ingress. */
export class StarsProvider implements PaymentProvider {
  readonly id = "stars";
  readonly platforms = ["telegram"] as const;
  constructor(private readonly client: StarsInvoiceClient) {}
  async create(input: ProviderCreateInput): Promise<ProviderCheckout> {
    if (input.currency.toUpperCase() !== "XTR" || !input.telegram_invoice) throw new ProviderError("invalid_stars_context", "definite_failure", 400);
    const invoice = await this.client.createStarsInvoice({
      title: input.telegram_invoice.title, description: input.description,
      payload: input.telegram_invoice.payload, label: input.telegram_invoice.label,
      amount_xtr: positiveSafeInteger(input.amount),
    });
    return { external_id: input.telegram_invoice.payload, external_kind: "invoice", checkout_url: invoice.invoice_link, expires_at: null };
  }
}

/** Uses the existing Platega transport, retaining integer RUB and old checkout semantics. */
export class SbpProvider implements PaymentProvider {
  readonly id = "sbp";
  readonly platforms = ["telegram", "web"] as const;
  constructor(private readonly client: SbpPaymentClient) {}
  async create(input: ProviderCreateInput): Promise<ProviderCheckout> {
    if (input.currency.toUpperCase() !== "RUB" || !Number.isSafeInteger(input.chat_id) || input.chat_id! <= 0) throw new ProviderError("invalid_sbp_context", "definite_failure", 400);
    const result = await this.client.createPayment({
      token: input.attempt_id, chat_id: input.chat_id!, description: input.description,
      amount_rub: positiveSafeInteger(input.amount), metadata: { order_id: input.order_id, attempt_id: input.attempt_id },
    });
    return { external_id: result.external_payment_id, external_kind: "payment", checkout_url: result.checkout_url, expires_at: result.provider_expires_at };
  }
  async getStatus(paymentId: string, expected?: ProviderCreateInput): Promise<ProviderPayment> {
    if (!this.client.getTransactionStatus || !expected || expected.currency.toUpperCase() !== "RUB") throw new ProviderError("status_context_required", "definite_failure", 400);
    const status = await this.client.getTransactionStatus(paymentId);
    if (!status) throw new ProviderError("payment_status_unavailable", "ambiguous");
    const amount = normalizeDecimal(expected.amount);
    return {
      provider: this.id, order_id: expected.order_id, external_payment_id: paymentId, external_invoice_id: null,
      status: status === "CONFIRMED" ? "paid" : status === "CANCELED" ? "failed" : status === "CHARGEBACKED" ? "refunded" : "pending",
      price_amount: amount, price_currency: "RUB", pay_amount: amount,
      paid_amount: status === "CONFIRMED" ? amount : null, pay_currency: "RUB", raw_status: status,
    };
  }
}
