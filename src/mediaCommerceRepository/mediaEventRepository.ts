import type { MediaFinalizeResult } from "../mediaCommerceTypes.js";
import {
  buildMediaFinalizeFallback,
  type QueryClient,
  type StorePanelInput,
  type StorePhotoEventInput,
} from "./shared.js";

export class MediaEventRepository {
  constructor(private readonly query: QueryClient) {}

  async storePanel(input: StorePanelInput): Promise<MediaFinalizeResult> {
    const rows = await this.query<MediaFinalizeResult[]>`
      WITH input AS (
        SELECT
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.scene_session_id}), '') AS scene_session_id,
          ${input.turn_no}::integer AS turn_no,
          ${input.scene_turn_no}::integer AS scene_turn_no,
          NULLIF(BTRIM(${input.media_signature}), '') AS media_signature,
          ${input.panel_message_id}::bigint AS panel_message_id,
          ${input.price_xtr}::integer AS price_xtr,
          NULLIF(BTRIM(${input.invoice_token}), '') AS invoice_token,
          NULLIF(BTRIM(${input.invoice_link}), '') AS invoice_link,
          NULLIF(${input.panel_text}, '') AS panel_text,
          COALESCE(${JSON.stringify(input.panel_entities_json)}::jsonb, '[]'::jsonb) AS panel_entities_json
      ),
      next_seq AS (
        SELECT COALESCE(MAX(cm.seq_in_turn), 0)::integer + 1 AS seq_in_turn
        FROM public.chat_messages cm
        JOIN input i
          ON cm.chat_id = i.chat_id
         AND cm.turn_no = i.turn_no
      ),
      existing_event AS (
        SELECT 1
        FROM public.chat_messages cm
        JOIN input i
          ON cm.chat_id = i.chat_id
         AND cm.turn_no = i.turn_no
        WHERE cm.event_type = 'media.panel.sent'
          AND NULLIF(BTRIM(cm.payload_json ->> 'media_signature'), '') IS NOT DISTINCT FROM i.media_signature
          AND NULLIF(cm.payload_json ->> 'panel_message_id', '')::bigint IS NOT DISTINCT FROM i.panel_message_id
        LIMIT 1
      ),
      ins AS (
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
          'outbound',
          'telegram',
          'media.panel.sent',
          'interactive',
          jsonb_build_object(
            'media_signature', i.media_signature,
            'panel_message_id', i.panel_message_id,
            'price_xtr', i.price_xtr
          ),
          'processed',
          now()
        FROM input i
        CROSS JOIN next_seq ns
        WHERE NOT EXISTS (SELECT 1 FROM existing_event)
        RETURNING id
      ),
      upd_state AS (
        UPDATE public.chat_state cs
        SET last_photo_message_id = i.panel_message_id
        FROM input i
        WHERE cs.chat_id = i.chat_id
        RETURNING cs.chat_id
      ),
      upd_invoice AS (
        UPDATE public.interaction_tokens t
        SET payload_json = COALESCE(t.payload_json, '{}'::jsonb)
          || jsonb_build_object(
            'target_message_id', i.panel_message_id,
            'panel_text', i.panel_text,
            'panel_entities_json', i.panel_entities_json
          )
          || CASE
            WHEN i.invoice_link IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('invoice_link', i.invoice_link)
          END
        FROM input i
        WHERE i.invoice_token IS NOT NULL
          AND t.token = i.invoice_token
        RETURNING t.token
      )
      SELECT
        (SELECT chat_id FROM input) AS chat_id,
        (SELECT turn_no FROM input) AS n,
        (SELECT scene_session_id FROM input) AS scene_session_id,
        (SELECT scene_turn_no FROM input) AS scene_turn_no,
        (SELECT media_signature FROM input) AS media_signature,
        (SELECT price_xtr FROM input) AS price_required,
        (SELECT panel_message_id FROM input) AS panel_message_id,
        COALESCE((SELECT COUNT(*)::integer FROM ins), 0) AS stored_count,
        COALESCE((SELECT COUNT(*)::integer FROM upd_invoice), 0) AS invoice_rows_updated
    `;

    return rows[0] ?? buildMediaFinalizeFallback({
      chat_id: input.chat_id,
      n: input.turn_no,
      scene_session_id: input.scene_session_id,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      price_required: input.price_xtr,
      panel_message_id: input.panel_message_id,
    });
  }

  async storePhotoEvent(input: StorePhotoEventInput): Promise<MediaFinalizeResult> {
    const rows = await this.query<MediaFinalizeResult[]>`
      WITH input AS (
        SELECT
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.scene_session_id}), '') AS scene_session_id,
          ${input.turn_no}::integer AS turn_no,
          ${input.scene_turn_no}::integer AS scene_turn_no,
          NULLIF(BTRIM(${input.event_type}), '') AS event_type,
          NULLIF(BTRIM(${input.media_signature}), '') AS media_signature,
          NULLIF(BTRIM(${input.uuid}), '') AS uuid,
          ${input.panel_message_id}::bigint AS panel_message_id,
          ${input.price_xtr}::integer AS price_xtr,
          NULLIF(BTRIM(${input.access_mode}), '') AS access_mode,
          NULLIF(BTRIM(${input.action_kind}), '') AS action_kind,
          NULLIF(BTRIM(${input.fulfillment_invoice_token}), '') AS fulfillment_invoice_token,
          NULLIF(BTRIM(${input.next_invoice_token}), '') AS next_invoice_token,
          NULLIF(BTRIM(${input.next_invoice_link}), '') AS next_invoice_link,
          ${input.price_required}::integer AS price_required
      ),
      lock_event AS (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            CONCAT_WS(
              ':',
              COALESCE((SELECT chat_id::text FROM input), ''),
              COALESCE((SELECT scene_session_id FROM input), ''),
              COALESCE((SELECT turn_no::text FROM input), ''),
              COALESCE((SELECT event_type FROM input), ''),
              COALESCE((SELECT media_signature FROM input), ''),
              COALESCE((SELECT uuid FROM input), ''),
              COALESCE((SELECT panel_message_id::text FROM input), '')
            ),
            0
          )
        ) AS locked
      ),
      next_seq AS (
        SELECT COALESCE(MAX(cm.seq_in_turn), 0)::integer + 1 AS seq_in_turn
        FROM public.chat_messages cm
        JOIN input i
          ON cm.chat_id = i.chat_id
         AND cm.turn_no = i.turn_no
        CROSS JOIN lock_event
      ),
      existing_event AS (
        SELECT 1
        FROM public.chat_messages cm
        JOIN input i
          ON cm.chat_id = i.chat_id
         AND cm.turn_no = i.turn_no
        CROSS JOIN lock_event
        WHERE cm.event_type = i.event_type
          AND NULLIF(BTRIM(cm.payload_json ->> 'media_signature'), '') IS NOT DISTINCT FROM i.media_signature
          AND NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '') IS NOT DISTINCT FROM i.uuid
          AND NULLIF(cm.payload_json ->> 'panel_message_id', '')::bigint IS NOT DISTINCT FROM i.panel_message_id
        LIMIT 1
      ),
      claimed_fulfillment_invoice AS (
        SELECT t.token
        FROM public.interaction_tokens t
        JOIN input i
          ON i.fulfillment_invoice_token IS NOT NULL
         AND t.token = i.fulfillment_invoice_token
         AND t.chat_id = i.chat_id
         AND t.kind = 'invoice_payload'
         AND t.action_kind = 'photo_payment'
        WHERE t.status = 'paid'
        FOR UPDATE
      ),
      ins AS (
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
          'outbound',
          'telegram',
          i.event_type,
          'photo',
          jsonb_build_object(
            'media_signature', i.media_signature,
            'uuid', i.uuid,
            'panel_message_id', i.panel_message_id,
            'price_xtr', i.price_xtr,
            'access_mode', i.access_mode,
            'action_kind', i.action_kind
          ),
          'processed',
          now()
        FROM input i
        CROSS JOIN next_seq ns
        WHERE i.chat_id IS NOT NULL
          AND i.chat_id <> 0
          AND i.turn_no IS NOT NULL
          AND i.panel_message_id IS NOT NULL
          AND i.event_type IS NOT NULL
          AND i.media_signature IS NOT NULL
          AND i.uuid IS NOT NULL
          AND (
            i.fulfillment_invoice_token IS NULL
            OR (
              i.event_type = 'media.photo.unlocked.paid'
              AND EXISTS (SELECT 1 FROM claimed_fulfillment_invoice)
            )
          )
          AND NOT EXISTS (SELECT 1 FROM existing_event)
        RETURNING id
      ),
      upd_state AS (
        UPDATE public.chat_state cs
        SET
          last_photo_sent_at = now(),
          last_photo_message_id = i.panel_message_id
        FROM input i
        WHERE EXISTS (SELECT 1 FROM ins)
          AND cs.chat_id = i.chat_id
          AND i.chat_id IS NOT NULL
          AND i.chat_id <> 0
          AND i.panel_message_id IS NOT NULL
        RETURNING cs.chat_id
      ),
      upd_next_invoice AS (
        UPDATE public.interaction_tokens t
        SET payload_json = COALESCE(t.payload_json, '{}'::jsonb)
          || jsonb_build_object('invoice_link', i.next_invoice_link)
        FROM input i
        WHERE EXISTS (SELECT 1 FROM ins)
          AND i.next_invoice_token IS NOT NULL
          AND i.next_invoice_link IS NOT NULL
          AND t.token = i.next_invoice_token
        RETURNING t.token
      ),
      upd_fulfillment_invoice AS (
        UPDATE public.interaction_tokens t
        SET
          status = 'fulfilled',
          fulfilled_at = COALESCE(t.fulfilled_at, now()),
          consumed_at = COALESCE(t.consumed_at, now())
        FROM claimed_fulfillment_invoice cfi
        WHERE EXISTS (SELECT 1 FROM ins)
          AND t.token = cfi.token
          AND t.status = 'paid'
        RETURNING t.token
      )
      SELECT
        COALESCE((SELECT COUNT(*)::integer FROM ins), 0) AS stored_count,
        (SELECT chat_id FROM input) AS chat_id,
        (SELECT scene_session_id FROM input) AS scene_session_id,
        (SELECT turn_no FROM input) AS n,
        (SELECT scene_turn_no FROM input) AS scene_turn_no,
        (SELECT media_signature FROM input) AS media_signature,
        (SELECT panel_message_id FROM input) AS panel_message_id,
        (SELECT price_required FROM input) AS price_required,
        COALESCE((SELECT COUNT(*)::integer FROM upd_next_invoice), 0)
          + COALESCE((SELECT COUNT(*)::integer FROM upd_fulfillment_invoice), 0) AS invoice_rows_updated
    `;

    return rows[0] ?? buildMediaFinalizeFallback({
      chat_id: input.chat_id,
      n: input.turn_no,
      scene_session_id: input.scene_session_id,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      price_required: input.price_required,
      panel_message_id: input.panel_message_id,
    });
  }
}
