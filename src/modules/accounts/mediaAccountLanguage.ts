import type { QueryClient } from '../../mediaCommerceRepository/shared.js';

export async function loadAccountLanguage(query: QueryClient, chatId: number | null,
    sourceUserId: number | null,
  ): Promise<string> {
    const rows = await query<Array<{ language: string | null }>>`
      SELECT account.language
      FROM public.users AS account
      WHERE account.user_id = COALESCE(
        (
          SELECT identity.user_id
          FROM public.user_identities AS identity
          WHERE identity.provider = 'telegram'
            AND identity.external_id = ${sourceUserId}::text
          LIMIT 1
        ),
        (
          SELECT state.user_id
          FROM public.chat_state AS state
          WHERE state.chat_id = ${chatId}::bigint
          LIMIT 1
        )
      )
      LIMIT 1
    `;

    return rows[0]?.language?.trim() || "ru";
  }
