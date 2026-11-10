import { sql } from '../../db.js';
import { asJsonValue } from '../../mediaCommerceRepository/shared.js';
import type { QueryClient, RecordAbTestDeliveredInput } from '../../mediaCommerceRepository/shared.js';

export async function recordAbTestDelivered(query: QueryClient, input: RecordAbTestDeliveredInput,
  ): Promise<number> {
    const sourceEventId = [
      "ab_delivered",
      input.ab_test.key,
      input.ab_test.starts_at,
      input.ab_test.version,
      input.ab_test.variant,
    ].join(":");
    const rows = await query<Array<{ inserted_count: number }>>`
      WITH input AS (
        SELECT
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.scene_session_id}::text), '') AS scene_session_id,
          COALESCE(${input.turn_no}::integer, -1) AS turn_no,
          ${input.scene_turn_no}::integer AS scene_turn_no,
          ${sourceEventId}::text AS source_event_id,
          ${sql.json(asJsonValue(input.ab_test))} AS payload_json
      ),
      next_seq AS (
        SELECT COALESCE(MAX(cm.seq_in_turn), 0)::integer + 1 AS seq_in_turn
        FROM public.chat_messages cm
        JOIN input i
          ON cm.chat_id = i.chat_id
         AND cm.turn_no = i.turn_no
      ),
      inserted AS (
        INSERT INTO public.chat_messages (
          chat_id,
          scene_session_id,
          turn_no,
          scene_turn_no,
          seq_in_turn,
          sender_type,
          direction,
          source,
          event_type,
          message_type,
          payload_json,
          source_event_id,
          processing_status,
          batched_at
        )
        SELECT
          i.chat_id,
          i.scene_session_id,
          i.turn_no,
          i.scene_turn_no,
          ns.seq_in_turn::smallint,
          'system',
          'internal',
          'telegram-gateway',
          'ab_delivered',
          'event',
          i.payload_json,
          i.source_event_id,
          'processed',
          now()
        FROM input i
        CROSS JOIN next_seq ns
        ON CONFLICT (source, chat_id, source_event_id)
          WHERE source_event_id IS NOT NULL
          DO NOTHING
        RETURNING id
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS inserted_count
      FROM inserted
    `;

    return rows[0]?.inserted_count ?? 0;
  }
