import type { PaidInvoiceToken } from '../../mediaCommerceTypes.js';
import type { MarkInvoicePaidInput, QueryClient, RecordSbpProviderEventInput, StorePrecheckoutResultInput } from '../../mediaCommerceRepository/shared.js';

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
        ${input.payment_source ?? null}::text,
        ${input.telegram_payment_charge_id ?? null}::text,
        ${input.provider_payment_charge_id ?? null}::text,
        ${input.external_payment_id ?? null}::text,
        ${input.payment_currency ?? null}::text,
        ${input.payment_total_amount ?? null}::integer,
        ${input.checkout_url ?? null}::text
      )
    `;

    return rows[0] ?? null;
  }

  async markSbpInvoiceCanceled(externalPaymentId: string): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_mark_sbp_invoice_canceled(
        ${externalPaymentId}::text
      ) AS updated_count
    `;
    return rows[0]?.updated_count ?? 0;
  }

  async markSbpInvoiceExpired(token: string, chatId: number): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_mark_sbp_invoice_expired(
        ${token}::text,
        ${chatId}::bigint
      ) AS updated_count
    `;
    return rows[0]?.updated_count ?? 0;
  }

  async recordSbpStatusConflict(
    externalPaymentId: string,
    providerStatus: string,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_record_sbp_status_conflict(
        ${externalPaymentId}::text,
        ${providerStatus}::text
      ) AS updated_count
    `;
    return rows[0]?.updated_count ?? 0;
  }

  async recordSbpProviderEvent(input: RecordSbpProviderEventInput): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_record_sbp_provider_event(
        ${input.external_payment_id}::text,
        ${input.provider_status}::text,
        ${input.provider_amount}::numeric,
        ${input.provider_currency}::text,
        ${input.provider_payment_method ?? null}::integer
      ) AS updated_count
    `;
    return rows[0]?.updated_count ?? 0;
  }
}
