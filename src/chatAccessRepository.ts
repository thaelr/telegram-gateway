import { sql } from "./db.js";
import type { AccessContext } from "./types.js";

type AccessContextRow = {
  chat_id: number;
  source: string | null;
  source_user_id: number | null;
  terms_accepted_at: string | null;
  subscription_sku: string | null;
  subscription_until: string | null;
  subscription_active: boolean;
  turns_today: number;
  selected_character_i: number | null;
  active_menu_screen: string | null;
  active_menu_message_id: number | null;
};

export class ChatAccessRepository {
  constructor(private readonly query: typeof sql = sql) {}

  async ensureAndLoadAccessContext(
    chatId: number,
    source: string | null,
    sourceUserId: number | null,
    timeZone: string,
  ): Promise<AccessContext> {
    const rows = await this.query<AccessContextRow[]>`
      WITH input AS (
        SELECT
          ${chatId}::bigint AS chat_id,
          NULLIF(BTRIM(${source}), '') AS source,
          ${sourceUserId}::bigint AS source_user_id
      ),
      upserted AS (
        INSERT INTO public.chat_state AS cs (
          chat_id,
          source,
          source_user_id,
          mode,
          current_turn_no,
          scene_turn_no,
          debounce_revision,
          active_scene_session_id,
          reachability_status,
          followup_anchor_json
        )
        SELECT
          i.chat_id,
          COALESCE(i.source, 'telegram'),
          i.source_user_id,
          'bot_active',
          -1,
          -1,
          0,
          md5(i.chat_id::text || clock_timestamp()::text || random()::text),
          'reachable',
          '{}'::jsonb
        FROM input i
        WHERE i.chat_id IS NOT NULL
        ON CONFLICT (chat_id) DO UPDATE
        SET
          source = COALESCE(EXCLUDED.source, cs.source, 'telegram'),
          source_user_id = COALESCE(EXCLUDED.source_user_id, cs.source_user_id)
        RETURNING
          cs.chat_id,
          cs.source,
          cs.source_user_id,
          cs.terms_accepted_at,
          cs.subscription_sku,
          cs.subscription_until,
          cs.selected_character_i,
          cs.active_menu_screen,
          cs.active_menu_message_id,
          (
            cs.subscription_until IS NOT NULL
            AND cs.subscription_until > now()
          ) AS subscription_active
      ),
      usage AS (
        SELECT COUNT(*)::integer AS turns_today
        FROM public.chat_turns ct
        WHERE ct.chat_id = ${chatId}::bigint
          AND COALESCE(ct.message_type, 'text') <> 'command'
          AND (ct.created_at AT TIME ZONE ${timeZone})::date = (now() AT TIME ZONE ${timeZone})::date
      )
      SELECT
        u.chat_id,
        u.source,
        u.source_user_id,
        CASE
          WHEN u.terms_accepted_at IS NULL THEN NULL
          ELSE to_char(u.terms_accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS terms_accepted_at,
        u.subscription_sku,
        CASE
          WHEN u.subscription_until IS NULL THEN NULL
          ELSE to_char(u.subscription_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS subscription_until,
        u.subscription_active,
        COALESCE(usage.turns_today, 0) AS turns_today,
        u.selected_character_i,
        u.active_menu_screen,
        u.active_menu_message_id
      FROM upserted u
      LEFT JOIN usage ON TRUE
    `;

    const row = rows[0];
    if (!row) {
      throw new Error(`Unable to load chat_state for chat_id=${chatId}`);
    }

    return row;
  }
}
