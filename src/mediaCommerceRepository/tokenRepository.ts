import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  StoredInvoiceToken,
} from "../mediaCommerceTypes.js";
import {
  type QueryClient,
  type UpsertInvoiceTokenInput,
} from "./shared.js";

export class MediaInteractionTokenRepository {
  constructor(private readonly query: QueryClient) {}

  async upsertCallbackTokens(tokenRows: InteractionTokenRow[]): Promise<number> {
    const rows = await this.query<Array<{ inserted_count: number }>>`
      SELECT public.media_upsert_callback_tokens(
        ${JSON.stringify(tokenRows)}::jsonb
      ) AS inserted_count
    `;

    return rows[0]?.inserted_count ?? 0;
  }

  async upsertInvoiceToken(
    input: UpsertInvoiceTokenInput,
  ): Promise<StoredInvoiceToken | null> {
    const rows = await this.query<StoredInvoiceToken[]>`
      SELECT *
      FROM public.media_upsert_invoice_token(
        ${input.token}::text,
        ${input.kind}::text,
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::bigint,
        ${input.scene_turn_no}::smallint,
        ${JSON.stringify(input.payload_json)}::jsonb,
        ${input.action_kind}::text,
        ${input.sku}::text,
        ${input.amount_xtr}::integer,
        ${input.telegram_invoice_payload}::text,
        ${input.expires_at}::timestamptz,
        ${input.invoice_title}::text,
        ${input.invoice_description}::text,
        ${input.invoice_label}::text,
        ${input.invoice_button_text}::text
      )
    `;

    return rows[0] ?? null;
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
          amount_xtr: row.amount_xtr ?? null,
          expires_at: row.expires_at,
          telegram_invoice_message_id: row.telegram_invoice_message_id ?? null,
          found: row.found,
        }
      : null;
  }

  async storeInvoiceLinks(
    items: Array<{ token: string; chat_id: number; invoice_link: string }>,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      SELECT public.media_store_invoice_links(
        ${JSON.stringify(items)}::jsonb
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
        ${JSON.stringify(tokens)}::jsonb
      )
    `;
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
        ${JSON.stringify(tokens)}::jsonb,
        ${chatId}::bigint,
        ${offerMessageId}::bigint
      ) AS updated_count
    `;

    return rows[0]?.updated_count ?? 0;
  }
}
