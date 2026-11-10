import { sql } from '../../db.js';
import type { TelegramLanguage } from '../../telegramLanguage.js';
export async function setTelegramLanguage(query: typeof sql, 
    sourceUserId: number,
    language: TelegramLanguage,
    telegramChatId: number | null = null,
    navigationRevision: number | null = null,
  ): Promise<string | null> {
    const rows = await query<Array<{ language_confirmed_at: string }>>`
      UPDATE public.users AS account
      SET
        language = ${language}::text,
        language_confirmed_at = clock_timestamp()
      FROM public.user_identities AS identity
      WHERE identity.provider = 'telegram'
        AND identity.external_id = ${sourceUserId}::text
        AND account.user_id = identity.user_id
        AND (
          ${navigationRevision}::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.chat_state AS navigation_state
            WHERE navigation_state.chat_id = ${telegramChatId}::bigint
              AND navigation_state.navigation_revision = ${navigationRevision}::bigint
          )
        )
      RETURNING to_char(
        account.language_confirmed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS language_confirmed_at
    `;
    const confirmedAt = rows[0]?.language_confirmed_at;
    if (!confirmedAt && navigationRevision == null) {
      throw new Error(`Unable to save Telegram language for source_user_id=${sourceUserId}`);
    }
    return confirmedAt ?? null;
  }

export async function resolveTelegramLanguage(query: typeof sql, sourceUserId: number): Promise<TelegramLanguage | null> {
    const rows = await query<Array<{ language: TelegramLanguage | null }>>`
      SELECT account.language
      FROM public.user_identities AS identity
      JOIN public.users AS account
        ON account.user_id = identity.user_id
      WHERE identity.provider = 'telegram'
        AND identity.external_id = ${sourceUserId}::text
      LIMIT 1
    `;
    return rows[0]?.language ?? null;
  }

export async function ensureTelegramAccountLink(query: typeof sql, 
    chatId: number,
    sourceUserId: number,
  ): Promise<string> {
    const rows = await query<Array<{ user_id: string | null }>>`
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
