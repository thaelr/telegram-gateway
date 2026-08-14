import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  StoredInvoiceToken,
} from "../mediaCommerceTypes.js";
import {
  buildJsonTextRowsCte,
  type QueryClient,
  sqlJsonObject,
  sqlTrimmedJsonText,
  sqlTrimmedText,
  sqlUtcTimestamp,
  type UpsertInvoiceTokenInput,
} from "./shared.js";

export class MediaInteractionTokenRepository {
  constructor(private readonly query: QueryClient) {}

  private buildTokenLookupProjection(extraProjection: string): string {
    return `
      i.requested_token,
      t.token,
      t.kind,
      t.chat_id,
      t.scene_session_id,
      t.turn_no,
      ${sqlJsonObject("t.payload_json")} AS payload_json,
      t.status,
      t.action_kind,
      ${extraProjection}
      (t.token IS NOT NULL) AS found
    `;
  }

  async upsertCallbackTokens(tokenRows: InteractionTokenRow[]): Promise<number> {
    const rows = await this.query<Array<{ inserted_count: number }>>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(tokenRows)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT
          NULLIF(BTRIM(item ->> 'token'), '') AS token,
          COALESCE(NULLIF(BTRIM(item ->> 'kind'), ''), 'button_callback') AS kind,
          NULLIF(item ->> 'chat_id', '')::bigint AS chat_id,
          NULLIF(BTRIM(item ->> 'scene_session_id'), '') AS scene_session_id,
          NULLIF(item ->> 'turn_no', '')::bigint AS turn_no,
          COALESCE(item -> 'payload_json', '{}'::jsonb) AS payload_json,
          COALESCE(NULLIF(BTRIM(item ->> 'status'), ''), 'active') AS status,
          NULLIF(BTRIM(item ->> 'action_kind'), '') AS action_kind,
          CASE
            WHEN item ? 'expires_at' AND NULLIF(BTRIM(item ->> 'expires_at'), '') IS NOT NULL
              THEN (item ->> 'expires_at')::timestamptz
            ELSE NULL
          END AS expires_at
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements(p.items) AS item
      ),
      ins AS (
        INSERT INTO public.interaction_tokens AS t (
          token,
          kind,
          chat_id,
          scene_session_id,
          turn_no,
          payload_json,
          status,
          action_kind,
          expires_at
        )
        SELECT
          token,
          kind,
          chat_id,
          scene_session_id,
          turn_no,
          payload_json,
          status,
          action_kind,
          expires_at
        FROM rows
        WHERE token IS NOT NULL
        ON CONFLICT (token) DO NOTHING
        RETURNING 1
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS inserted_count
      FROM ins
    `;

    return rows[0]?.inserted_count ?? 0;
  }

  async upsertInvoiceToken(
    input: UpsertInvoiceTokenInput,
  ): Promise<StoredInvoiceToken | null> {
    const rows = await this.query<StoredInvoiceToken[]>`
      WITH input AS (
        SELECT
          ${input.token}::text AS token,
          ${input.kind}::text AS kind,
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.scene_session_id}), '') AS scene_session_id,
          ${input.turn_no}::bigint AS turn_no,
          ${input.scene_turn_no}::smallint AS scene_turn_no,
          COALESCE(${JSON.stringify(input.payload_json)}::jsonb, '{}'::jsonb) AS payload_json,
          ${input.action_kind}::text AS action_kind,
          ${input.sku}::text AS sku,
          ${input.amount_xtr}::integer AS amount_xtr,
          ${input.telegram_invoice_payload}::text AS telegram_invoice_payload,
          ${input.expires_at}::timestamptz AS expires_at,
          ${input.invoice_title}::text AS invoice_title,
          ${input.invoice_description}::text AS invoice_description,
          ${input.invoice_label}::text AS invoice_label,
          ${input.invoice_button_text}::text AS invoice_button_text
      )
      INSERT INTO public.interaction_tokens AS t (
        token,
        kind,
        chat_id,
        scene_session_id,
        turn_no,
        payload_json,
        status,
        action_kind,
        sku,
        amount_xtr,
        telegram_invoice_payload,
        expires_at,
        invoiced_at
      )
      SELECT
        i.token,
        i.kind,
        i.chat_id,
        i.scene_session_id,
        i.turn_no,
        i.payload_json,
        'invoice_sent',
        i.action_kind,
        i.sku,
        i.amount_xtr,
        i.telegram_invoice_payload,
        i.expires_at,
        COALESCE(t.invoiced_at, now())
      FROM input i
      LEFT JOIN public.interaction_tokens t ON t.token = i.token
      ON CONFLICT (token) DO UPDATE
      SET token = EXCLUDED.token
      RETURNING
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        (SELECT scene_turn_no FROM input) AS scene_turn_no,
        COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
        t.sku,
        t.amount_xtr,
        t.telegram_invoice_payload,
        CASE
          WHEN t.expires_at IS NULL THEN NULL
          ELSE to_char(t.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        t.telegram_invoice_message_id,
        NULLIF(BTRIM(t.payload_json ->> 'invoice_link'), '') AS invoice_link,
        (t.xmax = 0) AS stored,
        (SELECT invoice_title FROM input) AS invoice_title,
        (SELECT invoice_description FROM input) AS invoice_description,
        (SELECT invoice_label FROM input) AS invoice_label,
        (SELECT invoice_button_text FROM input) AS invoice_button_text
    `;

    return rows[0] ?? null;
  }

  private async loadInteractionToken<
    T extends LoadedCallbackToken | LoadedInvoiceToken,
  >(
    token: string | null,
    chatId: number | null,
    extraProjection: string,
  ): Promise<T | null> {
    const rows = await this.query.unsafe<T[]>(
      `
        WITH input AS (
          SELECT
            ${sqlTrimmedText("$1::text")} AS requested_token,
            $2::bigint AS requested_chat_id
        )
        SELECT
          ${this.buildTokenLookupProjection(extraProjection)}
        FROM input i
        LEFT JOIN public.interaction_tokens t
          ON t.token = i.requested_token
         AND t.chat_id = i.requested_chat_id
        LIMIT 1
      `,
      [token, chatId],
    );

    return rows[0] ?? null;
  }

  async loadCallbackToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedCallbackToken | null> {
    return this.loadInteractionToken<LoadedCallbackToken>(
      token,
      chatId,
      `
        ${sqlUtcTimestamp("t.expires_at", "expires_at")},
      `,
    );
  }

  async loadInvoiceToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedInvoiceToken | null> {
    return this.loadInteractionToken<LoadedInvoiceToken>(
      token,
      chatId,
      `
        t.sku,
        t.amount_xtr,
        ${sqlUtcTimestamp("t.expires_at", "expires_at")},
        t.telegram_invoice_message_id,
      `,
    );
  }

  async storeInvoiceLinks(
    items: Array<{ token: string; chat_id: number; invoice_link: string }>,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(items)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT
          NULLIF(BTRIM(item ->> 'token'), '') AS token,
          NULLIF(item ->> 'chat_id', '')::bigint AS chat_id,
          NULLIF(BTRIM(item ->> 'invoice_link'), '') AS invoice_link
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements(p.items) AS item
      ),
      upd AS (
        UPDATE public.interaction_tokens t
        SET payload_json = COALESCE(t.payload_json, '{}'::jsonb)
          || jsonb_build_object('invoice_link', r.invoice_link)
        FROM rows r
        WHERE t.token = r.token
          AND t.chat_id = r.chat_id
          AND r.invoice_link IS NOT NULL
        RETURNING t.token
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS updated_count
      FROM upd
    `;

    return rows[0]?.updated_count ?? 0;
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    if (tokens.length === 0) {
      return [];
    }

    return this.query.unsafe<StoredInvoiceToken[]>(
      `
      WITH ${buildJsonTextRowsCte("$1")}
      SELECT
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        NULL::smallint AS scene_turn_no,
        ${sqlJsonObject("t.payload_json")} AS payload_json,
        t.sku,
        t.amount_xtr,
        t.telegram_invoice_payload,
        ${sqlUtcTimestamp("t.expires_at", "expires_at")},
        t.telegram_invoice_message_id,
        ${sqlTrimmedJsonText("t.payload_json", "invoice_link")} AS invoice_link,
        FALSE AS stored,
        '' AS invoice_title,
        '' AS invoice_description,
        '' AS invoice_label,
        '' AS invoice_button_text
      FROM public.interaction_tokens t
      JOIN rows r ON r.token = t.token
    `,
      [JSON.stringify(tokens)],
    );
  }

  async storeSubscriptionOfferMessageId(
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ): Promise<number> {
    if (tokens.length === 0) {
      return 0;
    }

    const rows = await this.query.unsafe<Array<{ updated_count: number }>>(
      `
      WITH ${buildJsonTextRowsCte("$1")},
      upd AS (
        UPDATE public.interaction_tokens t
        SET telegram_invoice_message_id = $3::bigint
        FROM rows r
        WHERE t.token = r.token
          AND t.chat_id = $2::bigint
        RETURNING t.token
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS updated_count
      FROM upd
    `,
      [JSON.stringify(tokens), chatId, offerMessageId],
    );

    return rows[0]?.updated_count ?? 0;
  }
}
