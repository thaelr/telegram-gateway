import type { PaidInvoiceToken } from "../mediaCommerceTypes.js";
import type {
  ActivateSceneAccessInput,
  ActivateSubscriptionInput,
  MarkInvoicePaidInput,
  QueryClient,
  SceneAccessStatus,
  SceneAccessStatusInput,
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

  async activateSceneAccess(
    input: ActivateSceneAccessInput,
  ): Promise<number> {
    const rows = await this.query<Array<{ activated_count: number }>>`
      SELECT public.media_activate_scene_access(
        ${input.payment_token}::text,
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.scene_access_sku}::text
      ) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
  }

  async loadSceneAccessStatus(
    input: SceneAccessStatusInput,
  ): Promise<SceneAccessStatus | null> {
    const rows = await this.query<SceneAccessStatus[]>`
      SELECT
        cs.chat_id,
        COALESCE(${input.scene_session_id}::text, cs.active_scene_session_id) AS scene_session_id,
        cs.active_scene_session_id,
        (cs.subscription_until IS NOT NULL AND cs.subscription_until > now()) AS subscription_active,
        COALESCE(css.scene_access_unlocked_at IS NOT NULL, FALSE) AS scene_access_active,
        (
          css.scene_session_id IS NOT NULL
          AND css.scene_session_id = cs.active_scene_session_id
        ) AS scene_is_active
      FROM public.chat_state cs
      LEFT JOIN public.chat_scene_sessions css
        ON css.chat_id = cs.chat_id
       AND css.scene_session_id = COALESCE(${input.scene_session_id}::text, cs.active_scene_session_id)
      WHERE cs.chat_id = ${input.chat_id}::bigint
      LIMIT 1
    `;

    return rows[0] ?? null;
  }
}
