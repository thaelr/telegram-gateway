import type { MediaFinalizeResult } from '../../mediaCommerceTypes.js';
import { sql } from '../../db.js';
import { config } from '../../config.js';
import { asJsonValue } from '../../mediaCommerceRepository/shared.js';
import type { FinalizeFreePhotoUnlockInput, QueryClient, StorePanelInput, StorePhotoEventInput } from '../../mediaCommerceRepository/shared.js';
import { MediaRepositoryContractError } from '../../mediaCommerceRepository/errors.js';

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

    const row = rows[0];
    if (!row) throw new MediaRepositoryContractError("media_store_panel");
    return row;
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
        ${input.price_required}::integer,
        ${config.DAILY_FREE_LIMITS_JSON.photos}::integer
      )
    `;

    const row = rows[0];
    if (!row) throw new MediaRepositoryContractError("media_store_photo_event");
    return row;
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

    const row = rows[0];
    if (!row) {
      throw new MediaRepositoryContractError("media_finalize_free_photo_unlock");
    }
    return row;
  }
}
