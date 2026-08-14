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
        ${JSON.stringify(input.panel_entities_json)}::jsonb
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
}
