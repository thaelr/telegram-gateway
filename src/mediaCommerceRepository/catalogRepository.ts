import { config } from "../config.js";
import { sql } from "../db.js";
import type { MediaContext, MediaOfferStats } from "../mediaCommerceTypes.js";
import {
  buildEmptyMediaContext,
  buildEmptyOfferStats,
  type CatalogRow,
  type LoadMediaContextInput,
  type LoadOfferStatsInput,
  parseJsonArray,
  parseJsonObject,
  type QueryClient,
} from "./shared.js";

export class MediaCatalogRepository {
  constructor(private readonly query: QueryClient) {}

  private buildCatalogRow(
    value: unknown,
  ): (CatalogRow & { photo_url: string | null }) | null {
    const entry = parseJsonObject(value);
    if (!entry) {
      return null;
    }

    return this.hydrateCatalogRow({
      uuid: typeof entry.uuid === "string" ? entry.uuid : null,
      bucket_name: typeof entry.bucket_name === "string" ? entry.bucket_name : null,
      storage_path: typeof entry.storage_path === "string" ? entry.storage_path : null,
      sort_order: Number(entry.sort_order ?? 0),
      first_unlocked_at:
        typeof entry.first_unlocked_at === "string"
          ? entry.first_unlocked_at
          : null,
    });
  }

  private resolveBucketName(bucketName: string | null): string {
    const normalized = bucketName?.trim().toLowerCase() ?? "";
    if (!normalized) {
      return config.MEDIA_DEFAULT_BUCKET_NAME;
    }

    return config.MEDIA_BUCKET_ALIAS_MAP_JSON[normalized]
      ?? bucketName?.trim()
      ?? config.MEDIA_DEFAULT_BUCKET_NAME;
  }

  private buildMediaAssetUrl(
    bucketName: string | null,
    storagePath: string | null,
  ): string | null {
    const path = storagePath?.trim().replace(/^\/+/u, "") ?? "";
    if (!path) {
      return null;
    }

    return `${config.MEDIA_STORAGE_BASE_URL.replace(/\/+$/u, "")}/storage/v1/object/public/${this.resolveBucketName(bucketName)}/${path}`;
  }

  private hydrateCatalogRow<T extends CatalogRow>(row: T): T & { photo_url: string | null } {
    return {
      ...row,
      photo_url: this.buildMediaAssetUrl(row.bucket_name, row.storage_path),
    };
  }

  async loadOfferStats(input: LoadOfferStatsInput): Promise<MediaOfferStats | null> {
    const rows = await this.query<MediaOfferStats[]>`
      SELECT *
      FROM public.media_load_offer_stats(
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::integer,
        ${input.media_signature}::text,
        ${input.scene_turn_no}::integer,
        ${input.base_price_xtr}::integer,
        ${input.should_offer}::boolean
      )
    `;

    return rows[0] ?? buildEmptyOfferStats(input);
  }

  async loadMediaContext(input: LoadMediaContextInput): Promise<MediaContext | null> {
    const rows = await this.query<MediaContext[]>`
      SELECT *
      FROM public.media_load_media_context(
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.turn_no}::integer,
        ${input.scene_turn_no}::integer,
        ${input.media_signature}::text,
        ${input.current_uuid}::text,
        ${input.target_message_id}::bigint,
        ${input.base_price_xtr}::integer,
        ${input.action_kind}::text,
        ${input.requested_action}::text,
        ${input.invoice_token}::text,
        ${input.force_deliver_after_payment}::boolean,
        ${input.paid_access_mode}::text,
        ${input.callback_valid}::boolean,
        ${input.panel_text}::text,
        ${sql.json(input.panel_entities_json ?? [])}
      )
    `;

    const row = rows[0];
    if (!row) {
      return buildEmptyMediaContext(input);
    }

    const unlockedItems = parseJsonArray(row.unlocked_items_json)
      .map((entry) => this.buildCatalogRow(entry))
      .filter((entry): entry is CatalogRow & { photo_url: string | null } => entry != null);
    const nextUnseen = this.buildCatalogRow(row.next_unseen_json);

    return {
      ...row,
      unlocked_items_json: unlockedItems,
      next_unseen_json: nextUnseen,
    };
  }
}
