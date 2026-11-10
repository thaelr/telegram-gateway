import type { AbTestAssignment } from '../../mediaCommerceTypes.js';
import { sql } from '../../db.js';
import { asJsonValue } from '../../mediaCommerceRepository/shared.js';
import type { QueryClient, LoadAbTestAssignmentResult } from '../../mediaCommerceRepository/shared.js';

export async function loadAbTestAssignment(query: QueryClient, chatId: number,
    assignmentKey: string,
  ): Promise<AbTestAssignment | null> {
    const rows = await query<LoadAbTestAssignmentResult[]>`
      SELECT
        CASE
          WHEN jsonb_typeof(account.ab_tests_json -> ${assignmentKey}::text) = 'object'
            THEN account.ab_tests_json -> ${assignmentKey}::text
          ELSE NULL
        END AS assignment
      FROM public.chat_state cs
      JOIN public.users account
        ON account.user_id = cs.user_id
      WHERE cs.chat_id = ${chatId}::bigint
      LIMIT 1
    `;

    return rows[0]?.assignment ?? null;
  }

export async function storeAbTestAssignment(query: QueryClient, chatId: number,
    assignmentKey: string,
    assignment: AbTestAssignment,
  ): Promise<AbTestAssignment | null> {
    const rows = await query<LoadAbTestAssignmentResult[]>`
      WITH owner AS (
        SELECT cs.user_id
        FROM public.chat_state cs
        WHERE cs.chat_id = ${chatId}::bigint
          AND cs.user_id IS NOT NULL
      ), updated AS (
        UPDATE public.users account
        SET ab_tests_json = jsonb_set(
          COALESCE(account.ab_tests_json, '{}'::jsonb),
          ARRAY[${assignmentKey}::text],
          ${sql.json(asJsonValue(assignment))},
          TRUE
        )
        FROM owner
        WHERE account.user_id = owner.user_id
          AND NOT (
            COALESCE(account.ab_tests_json, '{}'::jsonb) ? ${assignmentKey}::text
          )
        RETURNING account.ab_tests_json -> ${assignmentKey}::text AS assignment
      )
      SELECT assignment FROM updated
      UNION ALL
      SELECT account.ab_tests_json -> ${assignmentKey}::text AS assignment
      FROM public.chat_state cs
      JOIN public.users account
        ON account.user_id = cs.user_id
      WHERE cs.chat_id = ${chatId}::bigint
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1
    `;

    return rows[0]?.assignment ?? null;
  }
