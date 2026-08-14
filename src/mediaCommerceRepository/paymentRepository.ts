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
      UPDATE public.interaction_tokens AS t
      SET
        telegram_pre_checkout_query_id = ${input.pre_checkout_query_id}::text,
        failure_reason = CASE
          WHEN ${input.ok}::boolean THEN t.failure_reason
          WHEN t.status = 'invoice_sent' THEN ${input.error_message}::text
          ELSE t.failure_reason
        END,
        status = CASE
          WHEN ${input.ok}::boolean THEN t.status
          WHEN t.status = 'invoice_sent' THEN 'failed'
          ELSE t.status
        END
      WHERE t.token = ${input.token}::text
    `;
  }

  async markInvoicePaid(input: MarkInvoicePaidInput): Promise<PaidInvoiceToken | null> {
    const rows = await this.query<PaidInvoiceToken[]>`
      WITH input AS (
        SELECT
          ${input.token}::text AS token,
          ${input.chat_id}::bigint AS chat_id,
          ${input.expected_kind}::text AS expected_kind,
          ${input.expected_action_kind}::text AS expected_action_kind,
          NULLIF(BTRIM(${input.telegram_payment_charge_id}), '') AS payment_charge_id,
          NULLIF(BTRIM(${input.provider_payment_charge_id}), '') AS provider_payment_charge_id,
          NULLIF(BTRIM(${input.payment_currency}), '') AS currency,
          ${input.payment_total_amount}::integer AS total_amount
      ),
      updated AS (
        UPDATE public.interaction_tokens t
        SET
          status = 'paid',
          paid_at = COALESCE(t.paid_at, now()),
          telegram_payment_charge_id = i.payment_charge_id,
          telegram_provider_payment_charge_id = i.provider_payment_charge_id,
          payload_json = COALESCE(t.payload_json, '{}'::jsonb)
            || jsonb_build_object('currency', i.currency, 'total_amount', i.total_amount)
        FROM input i
        WHERE t.token = i.token
          AND t.chat_id = i.chat_id
          AND t.kind = i.expected_kind
          AND t.action_kind = i.expected_action_kind
          AND t.status = 'invoice_sent'
        RETURNING
          t.token,
          t.kind,
          t.chat_id,
          t.scene_session_id,
          t.turn_no,
          COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
          t.status,
          t.action_kind,
          t.sku,
          t.amount_xtr,
          t.telegram_invoice_message_id
      ),
      updated_state AS (
        UPDATE public.chat_state cs
        SET last_paid_at = now()
        FROM updated u
        WHERE cs.chat_id = u.chat_id
        RETURNING cs.chat_id
      )
      SELECT * FROM updated
    `;

    return rows[0] ?? null;
  }

  async activateSubscription(
    input: ActivateSubscriptionInput,
  ): Promise<number> {
    const rows = await this.query<Array<{ activated_count: number }>>`
      WITH input AS (
        SELECT
          ${input.payment_token}::text AS token,
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.subscription_sku}), '') AS sku,
          GREATEST(COALESCE(${input.subscription_days}::integer, 0), 0) AS subscription_days
      ),
      claimed_token AS (
        SELECT t.token, t.chat_id, t.sku
        FROM public.interaction_tokens t
        JOIN input i
          ON t.token = i.token
         AND t.chat_id = i.chat_id
         AND t.sku IS NOT DISTINCT FROM i.sku
         AND t.action_kind = 'subscription_payment'
        WHERE t.status = 'paid'
          AND i.subscription_days > 0
          AND i.sku IS NOT NULL
          AND i.sku LIKE 'media_sub_%'
        FOR UPDATE
      ),
      upd_state AS (
        UPDATE public.chat_state cs
        SET
          subscription_sku = i.sku,
          subscription_until = (
            CASE
              WHEN cs.subscription_until IS NOT NULL AND cs.subscription_until > now() THEN cs.subscription_until
              ELSE now()
            END + make_interval(days => i.subscription_days)
          ),
          last_paid_at = now()
        FROM input i
        JOIN claimed_token ct
          ON ct.chat_id = i.chat_id
        WHERE cs.chat_id = i.chat_id
        RETURNING ct.token, ct.chat_id, ct.sku
      ),
      upd_token AS (
        UPDATE public.interaction_tokens t
        SET
          status = 'fulfilled',
          fulfilled_at = COALESCE(t.fulfilled_at, now()),
          consumed_at = COALESCE(t.consumed_at, now())
        FROM upd_state us
        WHERE t.token = us.token
          AND t.chat_id = us.chat_id
          AND t.sku IS NOT DISTINCT FROM us.sku
          AND t.status = 'paid'
        RETURNING t.token
      )
      SELECT COALESCE((SELECT COUNT(*)::integer FROM upd_token), 0) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
  }
}
