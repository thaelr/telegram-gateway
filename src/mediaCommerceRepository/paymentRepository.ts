import type { PaidInvoiceToken } from "../mediaCommerceTypes.js";
import type {
  ActivateSubscriptionInput,
  MarkInvoicePaidInput,
  QueryClient,
  StorePrecheckoutResultInput,
} from "./shared.js";

export class MediaPaymentRepository {
  constructor(private readonly query: QueryClient) {}

  async storePrecheckoutResult(input: StorePrecheckoutResultInput): Promise<void> {
    await this.query`
      SELECT public.media_store_precheckout_result(
        ${input.token}::text,
        ${input.pre_checkout_query_id}::text,
        ${input.ok}::boolean,
        ${input.error_message}::text
      )
    `;
  }

  async markInvoicePaid(input: MarkInvoicePaidInput): Promise<PaidInvoiceToken | null> {
    const rows = await this.query<PaidInvoiceToken[]>`
      SELECT *
      FROM public.media_mark_invoice_paid(
        ${input.token}::text,
        ${input.chat_id}::bigint,
        ${input.expected_kind}::text,
        ${input.expected_action_kind}::text,
        ${input.telegram_payment_charge_id}::text,
        ${input.provider_payment_charge_id}::text,
        ${input.payment_currency}::text,
        ${input.payment_total_amount}::integer
      )
    `;

    return rows[0] ?? null;
  }

  async activateSubscription(
    input: ActivateSubscriptionInput,
  ): Promise<number> {
    const rows = await this.query<Array<{ activated_count: number }>>`
      SELECT public.media_activate_subscription(
        ${input.payment_token}::text,
        ${input.chat_id}::bigint,
        ${input.subscription_sku}::text,
        ${input.subscription_days}::integer
      ) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
  }
}
