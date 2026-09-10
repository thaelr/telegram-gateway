import type {
  AbTestAssignment,
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  StoredInvoiceToken,
} from "../mediaCommerceTypes.js";
import { sql } from "../db.js";
import {
  asJsonValue,
  type QueryClient,
  parseJsonObject,
  type LoadAbTestAssignmentResult,
  type SbpCheckoutCreationClaim,
  type UpsertInvoiceTokenBatchInput,
  type UpsertInvoiceTokenInput,
} from "./shared.js";

export class MediaInteractionTokenRepository {
  constructor(private readonly query: QueryClient) {}

  private normalizeInvoiceTokenInput(
    input: UpsertInvoiceTokenInput,
  ): UpsertInvoiceTokenInput {
    const paymentSource = input.payment_source ?? "stars";
    const amount = input.amount ?? input.amount_xtr ?? null;
    const currency = input.currency ?? (paymentSource === "sbp" ? "RUB" : "XTR");

    return {
      ...input,
      payment_source: paymentSource,
      amount,
      currency,
      payload_json: parseJsonObject(input.payload_json) ?? {},
    };
  }

  async upsertCallbackTokens(tokenRows: InteractionTokenRow[]): Promise<number> {
    const rows = await this.query<Array<{ inserted_count: number }>>`
      SELECT public.media_upsert_callback_tokens(
        ${sql.json(asJsonValue(tokenRows))}
      ) AS inserted_count
    `;

    return rows[0]?.inserted_count ?? 0;
  }

  async upsertInvoiceToken(
    input: UpsertInvoiceTokenInput,
  ): Promise<StoredInvoiceToken | null> {
    const normalizedInput = this.normalizeInvoiceTokenInput(input);

    const rows = await this.query<StoredInvoiceToken[]>`
      SELECT *
      FROM public.media_upsert_invoice_token(
        ${normalizedInput.token}::text,
        ${normalizedInput.kind}::text,
        ${normalizedInput.chat_id}::bigint,
        ${normalizedInput.scene_session_id}::text,
        ${normalizedInput.turn_no}::bigint,
        ${normalizedInput.scene_turn_no}::smallint,
        ${sql.json(asJsonValue(normalizedInput.payload_json))},
        ${normalizedInput.action_kind}::text,
        ${normalizedInput.sku}::text,
        ${normalizedInput.payment_source ?? null}::text,
        ${normalizedInput.amount ?? null}::integer,
        ${normalizedInput.currency ?? null}::text,
        ${normalizedInput.amount_xtr}::integer,
        ${normalizedInput.telegram_invoice_payload}::text,
        ${normalizedInput.checkout_url ?? null}::text,
        ${normalizedInput.external_payment_id ?? null}::text,
        ${normalizedInput.expires_at}::timestamptz,
        ${normalizedInput.invoice_title}::text,
        ${normalizedInput.invoice_description}::text,
        ${normalizedInput.invoice_label}::text,
        ${normalizedInput.invoice_button_text}::text
      )
    `;

    return rows[0] ?? null;
  }

  async upsertInvoiceTokens(
    inputs: UpsertInvoiceTokenBatchInput,
  ): Promise<StoredInvoiceToken[]> {
    if (inputs.length === 0) {
      return [];
    }

    const normalizedInputs = inputs.map((input) => this.normalizeInvoiceTokenInput(input));

    return this.query<StoredInvoiceToken[]>`
      SELECT *
      FROM public.media_upsert_invoice_tokens(
        ${sql.json(asJsonValue(normalizedInputs))}
      )
    `;
  }

  private async loadInteractionToken(
    token: string | null,
    chatId: number | null,
  ): Promise<(LoadedCallbackToken & Partial<LoadedInvoiceToken>) | null> {
    const rows = await this.query<Array<LoadedCallbackToken & Partial<LoadedInvoiceToken>>>`
      SELECT *
      FROM public.media_load_interaction_token(
        ${token}::text,
        ${chatId}::bigint
      )
    `;

    return rows[0] ?? null;
  }

  async loadCallbackToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedCallbackToken | null> {
    const row = await this.loadInteractionToken(token, chatId);
    return row
      ? {
          requested_token: row.requested_token,
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: row.scene_session_id,
          turn_no: row.turn_no,
          payload_json: row.payload_json,
          status: row.status,
          action_kind: row.action_kind,
          expires_at: row.expires_at,
          found: row.found,
        }
      : null;
  }

  async loadInvoiceToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedInvoiceToken | null> {
    const row = await this.loadInteractionToken(token, chatId);
    return row
      ? {
          requested_token: row.requested_token,
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: row.scene_session_id,
          turn_no: row.turn_no,
          payload_json: row.payload_json,
          status: row.status,
          action_kind: row.action_kind,
          sku: row.sku ?? null,
          payment_source: row.payment_source ?? null,
          amount: row.amount ?? null,
          currency: row.currency ?? null,
          checkout_url: row.checkout_url ?? null,
          external_payment_id: row.external_payment_id ?? null,
          amount_xtr: row.amount_xtr ?? null,
          expires_at: row.expires_at,
          telegram_invoice_message_id: row.telegram_invoice_message_id ?? null,
          found: row.found,
        }
      : null;
  }

  async loadInvoiceTokenByExternalPaymentId(
    externalPaymentId: string | null,
  ): Promise<LoadedInvoiceToken | null> {
    const rows = await this.query<LoadedInvoiceToken[]>`
      SELECT *
      FROM public.media_load_invoice_token_by_external_payment_id(
        ${externalPaymentId}::text
      )
    `;

    const row = rows[0] ?? null;
    return row
      ? {
          requested_token: row.requested_token,
          token: row.token,
          kind: row.kind,
          chat_id: row.chat_id,
          scene_session_id: row.scene_session_id,
          turn_no: row.turn_no,
          payload_json: row.payload_json,
          status: row.status,
          action_kind: row.action_kind,
          sku: row.sku ?? null,
          payment_source: row.payment_source ?? null,
          amount: row.amount ?? null,
          currency: row.currency ?? null,
          checkout_url: row.checkout_url ?? null,
          external_payment_id: row.external_payment_id ?? null,
          amount_xtr: row.amount_xtr ?? null,
          expires_at: row.expires_at,
          telegram_invoice_message_id: row.telegram_invoice_message_id ?? null,
          found: row.found,
        }
      : null;
  }

  async storeInvoiceLinks(
    items: Array<{
      token: string;
      chat_id: number;
      invoice_link?: string | null;
      checkout_url?: string | null;
      external_payment_id?: string | null;
    }>,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_store_invoice_links(
        ${sql.json(asJsonValue(items))}
      ) AS updated_count
    `;

    return rows[0]?.updated_count ?? 0;
  }

  async claimSbpCheckoutCreation(
    token: string | null,
    chatId: number | null,
  ): Promise<SbpCheckoutCreationClaim | null> {
    const rows = await this.query<SbpCheckoutCreationClaim[]>`
      SELECT *
      FROM public.media_claim_sbp_checkout_creation(
        ${token}::text,
        ${chatId}::bigint
      )
    `;

    return rows[0] ?? null;
  }

  async releaseSbpCheckoutCreation(
    token: string | null,
    chatId: number | null,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_release_sbp_checkout_creation(
        ${token}::text,
        ${chatId}::bigint
      ) AS updated_count
    `;

    return rows[0]?.updated_count ?? 0;
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    if (tokens.length === 0) {
      return [];
    }

    return this.query<StoredInvoiceToken[]>`
      SELECT *
      FROM public.media_load_stored_invoice_tokens(
        ${sql.json(asJsonValue(tokens))}
      )
    `;
  }

  async loadAbTestAssignment(
    chatId: number,
    assignmentKey: string,
  ): Promise<AbTestAssignment | null> {
    const rows = await this.query<LoadAbTestAssignmentResult[]>`
      SELECT
        CASE
          WHEN jsonb_typeof(cs.ab_tests_json -> ${assignmentKey}::text) = 'object'
            THEN cs.ab_tests_json -> ${assignmentKey}::text
          ELSE NULL
        END AS assignment
      FROM public.chat_state cs
      WHERE cs.chat_id = ${chatId}::bigint
      LIMIT 1
    `;

    return rows[0]?.assignment ?? null;
  }

  async storeAbTestAssignment(
    chatId: number,
    assignmentKey: string,
    assignment: AbTestAssignment,
  ): Promise<AbTestAssignment | null> {
    const rows = await this.query<LoadAbTestAssignmentResult[]>`
      WITH updated AS (
        UPDATE public.chat_state cs
        SET ab_tests_json = jsonb_set(
          COALESCE(cs.ab_tests_json, '{}'::jsonb),
          ARRAY[${assignmentKey}::text],
          ${sql.json(asJsonValue(assignment))},
          TRUE
        )
        WHERE cs.chat_id = ${chatId}::bigint
          AND NOT (
            COALESCE(cs.ab_tests_json, '{}'::jsonb) ? ${assignmentKey}::text
          )
        RETURNING cs.ab_tests_json -> ${assignmentKey}::text AS assignment
      )
      SELECT assignment FROM updated
      UNION ALL
      SELECT cs.ab_tests_json -> ${assignmentKey}::text AS assignment
      FROM public.chat_state cs
      WHERE cs.chat_id = ${chatId}::bigint
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1
    `;

    return rows[0]?.assignment ?? null;
  }

  async storeSubscriptionOfferMessageId(
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ): Promise<number> {
    if (tokens.length === 0) {
      return 0;
    }

    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_store_subscription_offer_message_id(
        ${sql.json(asJsonValue(tokens))},
        ${chatId}::bigint,
        ${offerMessageId}::bigint
      ) AS updated_count
    `;

    return rows[0]?.updated_count ?? 0;
  }
}
