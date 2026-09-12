import type { MediaFinalizeResult } from "../mediaCommerceTypes.js";
import { sql } from "../db.js";
import {
  asJsonValue,
  buildMediaFinalizeFallback,
  type FinalizeFreePhotoUnlockInput,
  type QueryClient,
  type RecordAbTestDeliveredInput,
  type StorePanelInput,
  type StorePhotoEventInput,
} from "./shared.js";

export class MediaEventRepository {
  constructor(private readonly query: QueryClient) {}

  async storePanel(input: StorePanelInput): Promise<MediaFinalizeResult> {
    const rows = await this.query<MediaFinalizeResult[]>`
      SELECT *
      FROM public.media_store_panel(
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::integer,
        ${input.scene_turn_no}::integer,
        ${input.media_signature}::text,
        ${input.panel_message_id}::bigint,
        ${input.price_xtr}::integer,
        ${input.invoice_token}::text,
        ${input.invoice_link}::text,
        ${input.panel_text}::text,
        ${sql.json(asJsonValue(input.panel_entities_json))}
      )
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
      SELECT *
      FROM public.media_store_photo_event(
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::integer,
        ${input.scene_turn_no}::integer,
        ${input.event_type}::text,
        ${input.media_signature}::text,
        ${input.uuid}::text,
        ${input.panel_message_id}::bigint,
        ${input.price_xtr}::integer,
        ${input.access_mode}::text,
        ${input.action_kind}::text,
        ${input.fulfillment_invoice_token}::text,
        ${input.next_invoice_token}::text,
        ${input.next_invoice_link}::text,
        ${input.price_required}::integer
      )
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

  async finalizeFreePhotoUnlock(
    input: FinalizeFreePhotoUnlockInput,
  ): Promise<MediaFinalizeResult> {
    const rows = await this.query<MediaFinalizeResult[]>`
      SELECT *
      FROM public.media_finalize_free_photo_unlock(
        ${input.token}::text,
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::integer,
        ${input.scene_turn_no}::integer,
        ${input.media_signature}::text,
        ${input.uuid}::text,
        ${input.panel_message_id}::bigint
      )
    `;

    return rows[0] ?? buildMediaFinalizeFallback({
      chat_id: input.chat_id,
      n: input.turn_no,
      scene_session_id: input.scene_session_id,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      price_required: 0,
      panel_message_id: input.panel_message_id,
    });
  }

  async recordAbTestDelivered(
    input: RecordAbTestDeliveredInput,
  ): Promise<number> {
    const sourceEventId = [
      "ab_delivered",
      input.ab_test.key,
      input.ab_test.starts_at,
      input.ab_test.version,
      input.ab_test.variant,
    ].join(":");
    const rows = await this.query<Array<{ inserted_count: number }>>`
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
}
