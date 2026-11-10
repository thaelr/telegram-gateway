import { sql } from '../../db.js';
import { normalizePositiveInteger } from '../../numeric.js';

export async function resolveTelegramChatId(query: typeof sql, chatId: number): Promise<number | null> {
    const rows = await query<Array<{ telegram_chat_id: number | string | null }>>`
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
