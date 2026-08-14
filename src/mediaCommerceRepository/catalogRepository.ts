import { config } from "../config.js";
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
  sqlTrimmedJsonText,
  sqlTrimmedText,
  sqlUtcTimestamp,
} from "./shared.js";

export class MediaCatalogRepository {
  constructor(private readonly query: QueryClient) {}

  private buildStateCte(): string {
    return `
        state AS (
          SELECT
            cs.subscription_sku,
            cs.subscription_until,
            (cs.subscription_until IS NOT NULL AND cs.subscription_until > now()) AS subscription_active
          FROM public.chat_state cs
          JOIN input i ON cs.chat_id = i.chat_id
          LIMIT 1
        )
      `;
  }

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

  private get catalogRelationsByCharacter(): Record<string, string> {
    return config.MEDIA_CHARACTER_CATALOG_RELATIONS_JSON;
  }

  private resolveCatalogRelationForCharacter(
    characterI: number | null,
  ): string | null {
    if (!Number.isInteger(characterI) || !characterI || characterI < 1) {
      return null;
    }

    return this.catalogRelationsByCharacter[String(characterI)] ?? null;
  }

  private async loadSceneCharacterI(
    sceneSessionId: string | null,
  ): Promise<number | null> {
    const normalizedSceneSessionId = sceneSessionId?.trim() ?? "";
    if (!normalizedSceneSessionId) {
      return null;
    }

    const rows = await this.query.unsafe<Array<{ character_i: number | null }>>(
      `
        SELECT css.character_i
        FROM public.chat_scene_sessions css
        WHERE css.scene_session_id = $1::text
        LIMIT 1
      `,
      [normalizedSceneSessionId],
    );

    const characterI = Number(rows[0]?.character_i ?? 0);
    return Number.isInteger(characterI) && characterI > 0 ? characterI : null;
  }

  private async resolveCatalogRelationForSceneSession(
    sceneSessionId: string | null,
  ): Promise<string | null> {
    const characterI = await this.loadSceneCharacterI(sceneSessionId);
    return this.resolveCatalogRelationForCharacter(characterI);
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
    const catalogRelation = await this.resolveCatalogRelationForSceneSession(
      input.scene_session_id,
    );
    if (!catalogRelation) {
      return buildEmptyOfferStats(input);
    }

    const rows = await this.query.unsafe<MediaOfferStats[]>(
      `
        WITH input AS (
          SELECT
            $1::bigint AS chat_id,
            ${sqlTrimmedText("$2::text")} AS scene_session_id,
            $3::bigint AS turn_no,
            ${sqlTrimmedText("$4::text")} AS media_signature,
            $5::integer AS scene_turn_no,
            $6::integer AS base_price_xtr,
            COALESCE($7::boolean, FALSE) AS should_offer
        ),
        ${this.buildStateCte()},
        catalog AS (
          SELECT
            mc.uuid::text AS uuid,
            ROW_NUMBER() OVER (ORDER BY md5(i.chat_id::text || ':' || mc.uuid::text)) AS sort_order
          FROM ${catalogRelation} mc
          JOIN input i ON TRUE
          WHERE ${sqlTrimmedText("mc.scene_hint")} = i.media_signature
            AND mc.uuid IS NOT NULL
        ),
        seen_media AS (
          SELECT DISTINCT ${sqlTrimmedJsonText("cm.payload_json", "uuid")} AS uuid
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
            AND cm.payload_json ->> 'media_signature' = i.media_signature
            AND ${sqlTrimmedJsonText("cm.payload_json", "uuid")} IS NOT NULL
        ),
        scene_usage AS (
          SELECT COUNT(*)::integer AS delivered_in_scene
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.scene_session_id = i.scene_session_id
            AND cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
        ),
        existing_panel AS (
          SELECT NULLIF(cm.payload_json ->> 'panel_message_id', '')::bigint AS panel_message_id
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.turn_no = i.turn_no
            AND cm.event_type = 'media.panel.sent'
            AND cm.payload_json ->> 'media_signature' = i.media_signature
          ORDER BY cm.id DESC
          LIMIT 1
        ),
        unseen_catalog AS (
          SELECT c.uuid, c.sort_order
          FROM catalog c
          WHERE NOT EXISTS (
            SELECT 1
            FROM seen_media sm
            WHERE sm.uuid = c.uuid
          )
        )
        SELECT
          i.chat_id,
          i.scene_session_id,
          i.turn_no,
          i.scene_turn_no,
          i.media_signature,
          i.base_price_xtr,
          i.should_offer,
          COALESCE(st.subscription_active, FALSE) AS subscription_active,
          st.subscription_sku,
          ${sqlUtcTimestamp("st.subscription_until", "subscription_until")},
          COALESCE((SELECT delivered_in_scene FROM scene_usage), 0) AS delivered_in_scene,
          (SELECT COUNT(*)::integer FROM catalog) AS total_available,
          COALESCE((SELECT COUNT(*)::integer FROM unseen_catalog), 0) AS unseen_available,
          (SELECT panel_message_id FROM existing_panel) AS existing_panel_message_id
        FROM input i
        LEFT JOIN state st ON TRUE
      `,
      [
        input.chat_id,
        input.scene_session_id,
        input.turn_no,
        input.media_signature,
        input.scene_turn_no,
        input.base_price_xtr,
        input.should_offer,
      ],
    );

    return rows[0] ?? null;
  }

  async loadMediaContext(input: LoadMediaContextInput): Promise<MediaContext | null> {
    const catalogRelation = await this.resolveCatalogRelationForSceneSession(
      input.scene_session_id,
    );
    if (!catalogRelation) {
      return buildEmptyMediaContext(input);
    }

    const rows = await this.query.unsafe<MediaContext[]>(
      `
        WITH input AS (
          SELECT
            $1::bigint AS chat_id,
            ${sqlTrimmedText("$2::text")} AS scene_session_id,
            $3::integer AS turn_no,
            $4::integer AS scene_turn_no,
            ${sqlTrimmedText("$5::text")} AS media_signature,
            ${sqlTrimmedText("$6::text")} AS current_uuid,
            NULLIF($7::bigint, 0) AS target_message_id,
            $8::integer AS base_price_xtr,
            ${sqlTrimmedText("$9::text")} AS action_kind,
            ${sqlTrimmedText("$10::text")} AS requested_action,
            ${sqlTrimmedText("$11::text")} AS invoice_token,
            COALESCE($12::boolean, FALSE) AS force_deliver_after_payment,
            ${sqlTrimmedText("$13::text")} AS paid_access_mode,
            COALESCE($14::boolean, TRUE) AS callback_valid,
            NULLIF($15::text, '') AS panel_text,
            COALESCE($16::jsonb, '[]'::jsonb) AS panel_entities_json
        ),
        ${this.buildStateCte()},
        catalog AS (
          SELECT DISTINCT
            mc.uuid::text AS uuid,
            ${sqlTrimmedText("mc.bucket_name")} AS bucket_name,
            ${sqlTrimmedText("mc.storage_path")} AS storage_path,
            ROW_NUMBER() OVER (ORDER BY md5(i.chat_id::text || ':' || mc.uuid::text)) AS sort_order
          FROM ${catalogRelation} mc
          JOIN input i ON TRUE
          WHERE ${sqlTrimmedText("mc.scene_hint")} = i.media_signature
            AND mc.uuid IS NOT NULL
        ),
        unlocked_events AS (
          SELECT
            ${sqlTrimmedJsonText("cm.payload_json", "uuid")} AS uuid,
            MIN(cm.created_at) AS first_unlocked_at
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
            AND cm.payload_json ->> 'media_signature' = i.media_signature
            AND ${sqlTrimmedJsonText("cm.payload_json", "uuid")} IS NOT NULL
          GROUP BY ${sqlTrimmedJsonText("cm.payload_json", "uuid")}
        ),
        unlocked_items AS (
          SELECT
            c.uuid,
            c.bucket_name,
            c.storage_path,
            c.sort_order,
            ue.first_unlocked_at
          FROM unlocked_events ue
          JOIN catalog c ON c.uuid = ue.uuid
        ),
        scene_usage AS (
          SELECT COUNT(*)::integer AS delivered_in_scene
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.scene_session_id = i.scene_session_id
            AND cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
        ),
        unseen_stats AS (
          SELECT COUNT(*)::integer AS unseen_available
          FROM catalog c
          WHERE NOT EXISTS (
            SELECT 1
            FROM unlocked_events ue
            WHERE ue.uuid = c.uuid
          )
        ),
        next_unseen AS (
          SELECT c.uuid, c.bucket_name, c.storage_path, c.sort_order
          FROM catalog c
          WHERE NOT EXISTS (
            SELECT 1
            FROM unlocked_events ue
            WHERE ue.uuid = c.uuid
          )
          ORDER BY c.sort_order
          LIMIT 1
        )
        SELECT
          i.chat_id,
          i.scene_session_id,
          i.turn_no,
          i.scene_turn_no,
          i.media_signature,
          i.current_uuid,
          i.target_message_id,
          i.base_price_xtr,
          i.action_kind,
          i.requested_action,
          i.invoice_token,
          i.force_deliver_after_payment,
          i.paid_access_mode,
          i.callback_valid,
          i.panel_text,
          i.panel_entities_json,
          COALESCE(st.subscription_active, FALSE) AS subscription_active,
          st.subscription_sku,
          ${sqlUtcTimestamp("st.subscription_until", "subscription_until")},
          COALESCE((SELECT delivered_in_scene FROM scene_usage), 0) AS delivered_in_scene,
          (SELECT COUNT(*)::integer FROM catalog) AS total_available,
          COALESCE((SELECT unseen_available FROM unseen_stats), 0) AS unseen_available,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'uuid', ui.uuid,
                'bucket_name', ui.bucket_name,
                'storage_path', ui.storage_path,
                'sort_order', ui.sort_order,
                'first_unlocked_at', ui.first_unlocked_at
              )
              ORDER BY ui.first_unlocked_at, ui.sort_order
            )
            FROM unlocked_items ui
          ), '[]'::jsonb) AS unlocked_items_json,
          (
            SELECT jsonb_build_object(
              'uuid', nu.uuid,
              'bucket_name', nu.bucket_name,
              'storage_path', nu.storage_path,
              'sort_order', nu.sort_order
            )
            FROM next_unseen nu
          ) AS next_unseen_json
        FROM input i
        LEFT JOIN state st ON TRUE
      `,
      [
        input.chat_id,
        input.scene_session_id,
        input.turn_no,
        input.scene_turn_no,
        input.media_signature,
        input.current_uuid,
        input.target_message_id,
        input.base_price_xtr,
        input.action_kind,
        input.requested_action,
        input.invoice_token,
        input.force_deliver_after_payment,
        input.paid_access_mode,
        input.callback_valid,
        input.panel_text,
        JSON.stringify(input.panel_entities_json),
      ],
    );

    const row = rows[0];
    if (!row) {
      return null;
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
