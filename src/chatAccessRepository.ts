import { sql } from "./db.js";
import { normalizePositiveInteger } from "./numeric.js";
import type { AccessContext } from "./types.js";

type AccessContextRow = {
  chat_id: number;
  telegram_chat_id: number;
  user_id: string | null;
  character_i: number | null;
  source: string | null;
  source_user_id: number | null;
  terms_accepted_at: string | null;
  subscription_sku: string | null;
  subscription_until: string | null;
  subscription_active: boolean;
  active_scene_session_id: string | null;
  active_scene_exists: boolean;
  scene_access_active: boolean;
  turns_today: number;
  scene_turn_no: number;
  selected_character_i: number | null;
  active_menu_screen: string | null;
  active_menu_message_id: number | null;
  free_fast_scene_skips: number;
  free_scene_unlocks: number;
  free_photo_unlocks: number;
};

export class ChatAccessRepository {
  constructor(private readonly query: typeof sql = sql) {}

  async ensureTelegramAccountLink(
    chatId: number,
    sourceUserId: number,
  ): Promise<string> {
    const rows = await this.query<Array<{ user_id: string | null }>>`
      SELECT app_private.ensure_telegram_chat_account(
        ${chatId}::bigint,
        ${sourceUserId}::bigint
      ) AS user_id
    `;

    const userId = rows[0]?.user_id ?? null;
    if (!userId) {
      throw new Error(`Unable to resolve Telegram account for chat_id=${chatId}`);
    }

    return userId;
  }

  async resolveTelegramChatId(chatId: number): Promise<number | null> {
    const rows = await this.query<Array<{ telegram_chat_id: number | string | null }>>`
      SELECT COALESCE(
        (
          SELECT identity.external_id::bigint
          FROM public.user_identities AS identity
          WHERE identity.user_id = state.user_id
            AND identity.provider = 'telegram'
            AND identity.external_id ~ '^[1-9][0-9]*$'
          LIMIT 1
        ),
        CASE
          WHEN state.source = 'telegram' THEN state.source_user_id
          ELSE NULL
        END
      ) AS telegram_chat_id
      FROM public.chat_state AS state
      WHERE state.chat_id = ${chatId}::bigint
      LIMIT 1
    `;

    return normalizePositiveInteger(rows[0]?.telegram_chat_id);
  }

  async popActiveSubscriptionOffer(
    chatId: number,
    currentOfferId: string | null,
  ): Promise<number | null> {
    const rows = await this.query<Array<{ message_id: number | null }>>`
      SELECT public.media_pop_active_subscription_offer(
        ${chatId}::bigint,
        ${currentOfferId}::text
      ) AS message_id
    `;

    return rows[0]?.message_id ?? null;
  }

  async ensureAndLoadAccessContext(
    telegramChatId: number,
    source: string | null,
    sourceUserId: number | null,
    timeZone: string,
    requestedCharacterId: number | null = null,
    updateSelectedCharacter = true,
  ): Promise<AccessContext> {
    const routingRows = await this.query<Array<{
      user_id: string;
      selected_character_i: number | null;
      active_menu_screen: string | null;
      active_menu_message_id: number | null;
      requested_character_i: number | null;
    }>>`
      WITH input AS (
        SELECT
          ${telegramChatId}::bigint AS chat_id,
          NULLIF(BTRIM(${source}), '') AS source,
          ${sourceUserId}::bigint AS source_user_id,
          ${requestedCharacterId}::smallint AS requested_character_i,
          ${updateSelectedCharacter}::boolean AS update_selected_character
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
          followup_anchor_json,
          selected_character_i
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
          '{}'::jsonb,
          CASE
            WHEN i.update_selected_character THEN i.requested_character_i
            ELSE NULL
          END
        FROM input i
        WHERE i.chat_id IS NOT NULL
        ON CONFLICT (chat_id) DO UPDATE
        SET
          source = COALESCE(EXCLUDED.source, cs.source, 'telegram'),
          source_user_id = COALESCE(cs.source_user_id, EXCLUDED.source_user_id),
          selected_character_i = CASE
            WHEN ${updateSelectedCharacter}::boolean THEN COALESCE(
              EXCLUDED.selected_character_i,
              cs.selected_character_i
            )
            ELSE cs.selected_character_i
          END
        RETURNING
          cs.chat_id,
          cs.source_user_id,
          cs.selected_character_i,
          cs.active_menu_screen,
          cs.active_menu_message_id
      ),
      linked_account AS MATERIALIZED (
        SELECT app_private.ensure_telegram_chat_account(
          u.chat_id,
          u.source_user_id
        ) AS user_id
        FROM upserted u
      )
      SELECT
        link.user_id,
        u.selected_character_i,
        u.active_menu_screen,
        u.active_menu_message_id,
        i.requested_character_i
      FROM upserted u
      JOIN input i ON TRUE
      JOIN linked_account link ON TRUE
    `;

    const routing = routingRows[0];
    if (!routing?.user_id) {
      throw new Error(
        `Unable to resolve Telegram account for chat_id=${telegramChatId}`,
      );
    }

    let dialogueChatId = telegramChatId;
    const selectedCharacterId = routing.requested_character_i
      ?? routing.selected_character_i;
    if (selectedCharacterId != null) {
      const existingRows = await this.query<Array<{ chat_id: number }>>`
        SELECT chat_id
        FROM public.chat_state
        WHERE user_id = ${routing.user_id}::varchar(8)
          AND character_i = ${selectedCharacterId}::smallint
          AND is_active
        LIMIT 1
      `;

      dialogueChatId = normalizePositiveInteger(existingRows[0]?.chat_id) ?? 0;
      if (dialogueChatId <= 0) {
        const dialogueRows = await this.query<Array<{ chat_id: number }>>`
          INSERT INTO public.chat_state (
          source,
          source_user_id,
          user_id,
          character_i,
          selected_character_i,
          mode,
          current_turn_no,
          scene_turn_no,
          debounce_revision,
          active_scene_session_id,
          reachability_status,
          followup_anchor_json
          )
          VALUES (
          'telegram',
          ${sourceUserId}::bigint,
          ${routing.user_id}::varchar(8),
          ${selectedCharacterId}::smallint,
          ${selectedCharacterId}::smallint,
          'bot_active',
          -1,
          -1,
          0,
          md5(
            ${routing.user_id}::text
            || ':'
            || ${selectedCharacterId}::text
            || ':'
            || clock_timestamp()::text
            || ':'
            || random()::text
          ),
          'reachable',
          '{}'::jsonb
          )
          ON CONFLICT (user_id, character_i)
            WHERE user_id IS NOT NULL
              AND character_i IS NOT NULL
              AND is_active
          DO UPDATE SET
            user_id = public.chat_state.user_id
          RETURNING chat_id
        `;

        dialogueChatId = normalizePositiveInteger(dialogueRows[0]?.chat_id) ?? 0;
      }
      if (dialogueChatId <= 0) {
        throw new Error(
          `Unable to resolve active dialogue for user_id=${routing.user_id}, character_i=${selectedCharacterId}`,
        );
      }
    }

    const rows = await this.query<AccessContextRow[]>`
      WITH target AS (
        SELECT
          cs.chat_id,
          cs.source,
          cs.source_user_id,
          cs.user_id,
          cs.character_i,
          cs.active_scene_session_id,
          COALESCE(cs.scene_turn_no, -1) AS scene_turn_no,
          cs.active_menu_screen,
          cs.active_menu_message_id
        FROM public.chat_state cs
        WHERE cs.chat_id = ${dialogueChatId}::bigint
        LIMIT 1
      ),
      active_scene AS (
        SELECT
          css.scene_session_id,
          css.scene_access_unlocked_at IS NOT NULL AS scene_access_active
        FROM public.chat_scene_sessions css
        JOIN target t
          ON css.chat_id = t.chat_id
         AND css.scene_session_id = t.active_scene_session_id
        LIMIT 1
      ),
      usage AS (
        SELECT COUNT(*)::integer AS turns_today
        FROM public.chat_turns ct
        WHERE ct.chat_id = ${dialogueChatId}::bigint
          AND COALESCE(ct.message_type, 'text') <> 'command'
          AND (ct.created_at AT TIME ZONE ${timeZone})::date = (now() AT TIME ZONE ${timeZone})::date
      )
      SELECT
        t.chat_id,
        ${telegramChatId}::bigint AS telegram_chat_id,
        t.user_id,
        t.character_i,
        t.source,
        t.source_user_id,
        CASE
          WHEN account.terms_accepted_at IS NULL THEN NULL
          ELSE to_char(account.terms_accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS terms_accepted_at,
        account.subscription_sku,
        CASE
          WHEN account.subscription_until IS NULL THEN NULL
          ELSE to_char(account.subscription_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS subscription_until,
        (
          account.subscription_until IS NOT NULL
          AND account.subscription_until > now()
        ) AS subscription_active,
        t.active_scene_session_id,
        (active_scene.scene_session_id IS NOT NULL) AS active_scene_exists,
        COALESCE(active_scene.scene_access_active, FALSE) AS scene_access_active,
        COALESCE(usage.turns_today, 0) AS turns_today,
        t.scene_turn_no,
        ${selectedCharacterId}::smallint AS selected_character_i,
        ${routing.active_menu_screen}::text AS active_menu_screen,
        ${routing.active_menu_message_id}::bigint AS active_menu_message_id,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_fast_scene_skips')::integer,
          0
        ) AS free_fast_scene_skips,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_scene_unlocks')::integer,
          0
        ) AS free_scene_unlocks,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_photo_unlocks')::integer,
          0
        ) AS free_photo_unlocks
      FROM target t
      LEFT JOIN public.users account
        ON account.user_id = t.user_id
      LEFT JOIN active_scene ON TRUE
      LEFT JOIN usage ON TRUE
    `;

    const row = rows[0];
    if (!row) {
      throw new Error(`Unable to load chat_state for chat_id=${dialogueChatId}`);
    }

    const normalizedChatId = normalizePositiveInteger(row.chat_id);
    if (normalizedChatId == null) {
      throw new Error(`Invalid chat_id returned for dialogue=${dialogueChatId}`);
    }

    return {
      ...row,
      chat_id: normalizedChatId,
      telegram_chat_id: telegramChatId,
    };
  }
}
