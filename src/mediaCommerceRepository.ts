import { sql } from "./db.js";
import { config } from "./config.js";
import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  MediaContext,
  MediaFinalizeResult,
  MediaOfferStats,
  PaidInvoiceToken,
  StoredInvoiceToken,
} from "./mediaCommerceTypes.js";

type QueryClient = typeof sql;

type CatalogRow = {
  uuid: string | null;
  bucket_name: string | null;
  storage_path: string | null;
  sort_order: number | null;
  first_unlocked_at?: string | null;
};

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

type UpsertInvoiceTokenInput = {
  token: string;
  kind: string;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  payload_json: Record<string, unknown>;
  action_kind: string;
  sku: string;
  amount_xtr: number;
  telegram_invoice_payload: string;
  expires_at: string;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
};

type StorePanelInput = {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  panel_message_id: number | null;
  price_xtr: number;
  invoice_token: string | null;
  invoice_link: string | null;
  panel_text: string | null;
  panel_entities_json: unknown[];
};

type LoadMediaContextInput = {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  current_uuid: string | null;
  target_message_id: number | null;
  base_price_xtr: number;
  action_kind: string | null;
  requested_action: string | null;
  invoice_token: string | null;
  force_deliver_after_payment: boolean;
  paid_access_mode: string | null;
  callback_valid: boolean;
  panel_text: string | null;
  panel_entities_json: unknown[];
  storageBaseUrl: string;
};

type StorePrecheckoutResultInput = {
  token: string;
  pre_checkout_query_id: string | null;
  ok: boolean;
  error_message: string | null;
};

type MarkInvoicePaidInput = {
  token: string;
  chat_id: number;
  expected_kind: string;
  expected_action_kind: string;
  telegram_payment_charge_id: string | null;
  provider_payment_charge_id: string | null;
  payment_currency: string | null;
  payment_total_amount: number | null;
};

type ActivateSubscriptionInput = {
  payment_token: string;
  chat_id: number;
  subscription_sku: string | null;
  subscription_days: number;
};

type StorePhotoEventInput = {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  event_type: string | null;
  media_signature: string | null;
  uuid: string | null;
  panel_message_id: number | null;
  price_xtr: number;
  access_mode: string | null;
  action_kind: string | null;
  fulfillment_invoice_token: string | null;
  next_invoice_token: string | null;
  next_invoice_link: string | null;
  price_required: number;
};

export class MediaCommerceRepository {
  constructor(private readonly query: QueryClient = sql) {}

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

  private buildEmptyOfferStats(input: {
    chat_id: number;
    scene_session_id: string | null;
    turn_no: number | null;
    media_signature: string | null;
    scene_turn_no: number | null;
    base_price_xtr: number;
    should_offer: boolean;
  }): MediaOfferStats {
    return {
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      base_price_xtr: input.base_price_xtr,
      should_offer: input.should_offer,
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 0,
      unseen_available: 0,
      existing_panel_message_id: null,
    };
  }

  private buildEmptyMediaContext(input: LoadMediaContextInput): MediaContext {
    return {
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      current_uuid: input.current_uuid,
      target_message_id: input.target_message_id,
      base_price_xtr: input.base_price_xtr,
      action_kind: input.action_kind,
      requested_action: input.requested_action,
      invoice_token: input.invoice_token,
      force_deliver_after_payment: input.force_deliver_after_payment,
      paid_access_mode: input.paid_access_mode,
      callback_valid: input.callback_valid,
      panel_text: input.panel_text,
      panel_entities_json: input.panel_entities_json,
      subscription_active: false,
      subscription_sku: null,
      subscription_until: null,
      delivered_in_scene: 0,
      total_available: 0,
      unseen_available: 0,
      unlocked_items_json: [],
      next_unseen_json: null,
    };
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

  async loadOfferStats(input: {
    chat_id: number;
    scene_session_id: string | null;
    turn_no: number | null;
    media_signature: string | null;
    scene_turn_no: number | null;
    base_price_xtr: number;
    should_offer: boolean;
    storageBaseUrl: string;
  }): Promise<MediaOfferStats | null> {
    const catalogRelation = await this.resolveCatalogRelationForSceneSession(
      input.scene_session_id,
    );
    if (!catalogRelation) {
      return this.buildEmptyOfferStats(input);
    }

    const rows = await this.query.unsafe<MediaOfferStats[]>(
      `
        WITH input AS (
          SELECT
            $1::bigint AS chat_id,
            NULLIF(BTRIM($2::text), '') AS scene_session_id,
            $3::bigint AS turn_no,
            NULLIF(BTRIM($4::text), '') AS media_signature,
            $5::integer AS scene_turn_no,
            $6::integer AS base_price_xtr,
            COALESCE($7::boolean, FALSE) AS should_offer
        ),
        state AS (
          SELECT
            cs.subscription_sku,
            cs.subscription_until,
            (cs.subscription_until IS NOT NULL AND cs.subscription_until > now()) AS subscription_active
          FROM public.chat_state cs
          JOIN input i ON cs.chat_id = i.chat_id
          LIMIT 1
        ),
        catalog AS (
          SELECT
            mc.uuid::text AS uuid,
            ROW_NUMBER() OVER (ORDER BY md5(i.chat_id::text || ':' || mc.uuid::text)) AS sort_order
          FROM ${catalogRelation} mc
          JOIN input i ON TRUE
          WHERE NULLIF(BTRIM(mc.scene_hint), '') = i.media_signature
            AND mc.uuid IS NOT NULL
        ),
        seen_media AS (
          SELECT DISTINCT NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '') AS uuid
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
            AND cm.payload_json ->> 'media_signature' = i.media_signature
            AND NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '') IS NOT NULL
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
          CASE
            WHEN st.subscription_until IS NULL THEN NULL
            ELSE to_char(st.subscription_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS subscription_until,
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

  async upsertCallbackTokens(tokenRows: InteractionTokenRow[]): Promise<number> {
    const rows = await this.query<Array<{ inserted_count: number }>>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(tokenRows)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT
          NULLIF(BTRIM(item ->> 'token'), '') AS token,
          COALESCE(NULLIF(BTRIM(item ->> 'kind'), ''), 'button_callback') AS kind,
          NULLIF(item ->> 'chat_id', '')::bigint AS chat_id,
          NULLIF(BTRIM(item ->> 'scene_session_id'), '') AS scene_session_id,
          NULLIF(item ->> 'turn_no', '')::bigint AS turn_no,
          COALESCE(item -> 'payload_json', '{}'::jsonb) AS payload_json,
          COALESCE(NULLIF(BTRIM(item ->> 'status'), ''), 'active') AS status,
          NULLIF(BTRIM(item ->> 'action_kind'), '') AS action_kind,
          CASE
            WHEN item ? 'expires_at' AND NULLIF(BTRIM(item ->> 'expires_at'), '') IS NOT NULL
              THEN (item ->> 'expires_at')::timestamptz
            ELSE NULL
          END AS expires_at
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements(p.items) AS item
      ),
      ins AS (
        INSERT INTO public.interaction_tokens AS t (
          token,
          kind,
          chat_id,
          scene_session_id,
          turn_no,
          payload_json,
          status,
          action_kind,
          expires_at
        )
        SELECT
          token,
          kind,
          chat_id,
          scene_session_id,
          turn_no,
          payload_json,
          status,
          action_kind,
          expires_at
        FROM rows
        WHERE token IS NOT NULL
        ON CONFLICT (token) DO NOTHING
        RETURNING 1
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS inserted_count
      FROM ins
    `;

    return rows[0]?.inserted_count ?? 0;
  }

  async upsertInvoiceToken(
    input: UpsertInvoiceTokenInput,
  ): Promise<StoredInvoiceToken | null> {
    const rows = await this.query<StoredInvoiceToken[]>`
      WITH input AS (
        SELECT
          ${input.token}::text AS token,
          ${input.kind}::text AS kind,
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.scene_session_id}), '') AS scene_session_id,
          ${input.turn_no}::bigint AS turn_no,
          ${input.scene_turn_no}::smallint AS scene_turn_no,
          COALESCE(${JSON.stringify(input.payload_json)}::jsonb, '{}'::jsonb) AS payload_json,
          ${input.action_kind}::text AS action_kind,
          ${input.sku}::text AS sku,
          ${input.amount_xtr}::integer AS amount_xtr,
          ${input.telegram_invoice_payload}::text AS telegram_invoice_payload,
          ${input.expires_at}::timestamptz AS expires_at,
          ${input.invoice_title}::text AS invoice_title,
          ${input.invoice_description}::text AS invoice_description,
          ${input.invoice_label}::text AS invoice_label,
          ${input.invoice_button_text}::text AS invoice_button_text
      )
      INSERT INTO public.interaction_tokens AS t (
        token,
        kind,
        chat_id,
        scene_session_id,
        turn_no,
        payload_json,
        status,
        action_kind,
        sku,
        amount_xtr,
        telegram_invoice_payload,
        expires_at,
        invoiced_at
      )
      SELECT
        i.token,
        i.kind,
        i.chat_id,
        i.scene_session_id,
        i.turn_no,
        i.payload_json,
        'invoice_sent',
        i.action_kind,
        i.sku,
        i.amount_xtr,
        i.telegram_invoice_payload,
        i.expires_at,
        COALESCE(t.invoiced_at, now())
      FROM input i
      LEFT JOIN public.interaction_tokens t ON t.token = i.token
      ON CONFLICT (token) DO UPDATE
      SET token = EXCLUDED.token
      RETURNING
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        (SELECT scene_turn_no FROM input) AS scene_turn_no,
        COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
        t.sku,
        t.amount_xtr,
        t.telegram_invoice_payload,
        CASE
          WHEN t.expires_at IS NULL THEN NULL
          ELSE to_char(t.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        t.telegram_invoice_message_id,
        NULLIF(BTRIM(t.payload_json ->> 'invoice_link'), '') AS invoice_link,
        (t.xmax = 0) AS stored,
        (SELECT invoice_title FROM input) AS invoice_title,
        (SELECT invoice_description FROM input) AS invoice_description,
        (SELECT invoice_label FROM input) AS invoice_label,
        (SELECT invoice_button_text FROM input) AS invoice_button_text
    `;

    return rows[0] ?? null;
  }

  async loadCallbackToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedCallbackToken | null> {
    const rows = await this.query<LoadedCallbackToken[]>`
      WITH input AS (
        SELECT
          NULLIF(BTRIM(${token}), '') AS requested_token,
          ${chatId}::bigint AS requested_chat_id
      )
      SELECT
        i.requested_token,
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
        t.status,
        t.action_kind,
        CASE
          WHEN t.expires_at IS NULL THEN NULL
          ELSE to_char(t.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        (t.token IS NOT NULL) AS found
      FROM input i
      LEFT JOIN public.interaction_tokens t
        ON t.token = i.requested_token
       AND t.chat_id = i.requested_chat_id
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  async loadMediaContext(input: LoadMediaContextInput): Promise<MediaContext | null> {
    const catalogRelation = await this.resolveCatalogRelationForSceneSession(
      input.scene_session_id,
    );
    if (!catalogRelation) {
      return this.buildEmptyMediaContext(input);
    }

    const rows = await this.query.unsafe<MediaContext[]>(
      `
        WITH input AS (
          SELECT
            $1::bigint AS chat_id,
            NULLIF(BTRIM($2::text), '') AS scene_session_id,
            $3::integer AS turn_no,
            $4::integer AS scene_turn_no,
            NULLIF(BTRIM($5::text), '') AS media_signature,
            NULLIF(BTRIM($6::text), '') AS current_uuid,
            NULLIF($7::bigint, 0) AS target_message_id,
            $8::integer AS base_price_xtr,
            NULLIF(BTRIM($9::text), '') AS action_kind,
            NULLIF(BTRIM($10::text), '') AS requested_action,
            NULLIF(BTRIM($11::text), '') AS invoice_token,
            COALESCE($12::boolean, FALSE) AS force_deliver_after_payment,
            NULLIF(BTRIM($13::text), '') AS paid_access_mode,
            COALESCE($14::boolean, TRUE) AS callback_valid,
            NULLIF($15::text, '') AS panel_text,
            COALESCE($16::jsonb, '[]'::jsonb) AS panel_entities_json
        ),
        state AS (
          SELECT
            cs.subscription_sku,
            cs.subscription_until,
            (cs.subscription_until IS NOT NULL AND cs.subscription_until > now()) AS subscription_active
          FROM public.chat_state cs
          JOIN input i ON cs.chat_id = i.chat_id
          LIMIT 1
        ),
        catalog AS (
          SELECT DISTINCT
            mc.uuid::text AS uuid,
            NULLIF(BTRIM(mc.bucket_name), '') AS bucket_name,
            NULLIF(BTRIM(mc.storage_path), '') AS storage_path,
            ROW_NUMBER() OVER (ORDER BY md5(i.chat_id::text || ':' || mc.uuid::text)) AS sort_order
          FROM ${catalogRelation} mc
          JOIN input i ON TRUE
          WHERE NULLIF(BTRIM(mc.scene_hint), '') = i.media_signature
            AND mc.uuid IS NOT NULL
        ),
        unlocked_events AS (
          SELECT
            NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '') AS uuid,
            MIN(cm.created_at) AS first_unlocked_at
          FROM public.chat_messages cm
          JOIN input i ON cm.chat_id = i.chat_id
          WHERE cm.event_type IN ('media.photo.unlocked.free', 'media.photo.unlocked.paid', 'media.photo.unlocked.subscription')
            AND cm.payload_json ->> 'media_signature' = i.media_signature
            AND NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '') IS NOT NULL
          GROUP BY NULLIF(BTRIM(cm.payload_json ->> 'uuid'), '')
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
          CASE
            WHEN st.subscription_until IS NULL THEN NULL
            ELSE to_char(st.subscription_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS subscription_until,
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
      .map((entry) => parseJsonObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
      .map((entry) =>
        this.hydrateCatalogRow({
          uuid: typeof entry.uuid === "string" ? entry.uuid : null,
          bucket_name: typeof entry.bucket_name === "string" ? entry.bucket_name : null,
          storage_path: typeof entry.storage_path === "string" ? entry.storage_path : null,
          sort_order: Number(entry.sort_order ?? 0),
          first_unlocked_at:
            typeof entry.first_unlocked_at === "string"
              ? entry.first_unlocked_at
              : null,
        }));
    const nextUnseenRaw = parseJsonObject(row.next_unseen_json);
    const nextUnseen = nextUnseenRaw
      ? this.hydrateCatalogRow({
        uuid: typeof nextUnseenRaw.uuid === "string" ? nextUnseenRaw.uuid : null,
        bucket_name:
          typeof nextUnseenRaw.bucket_name === "string"
            ? nextUnseenRaw.bucket_name
            : null,
        storage_path:
          typeof nextUnseenRaw.storage_path === "string"
            ? nextUnseenRaw.storage_path
            : null,
        sort_order: Number(nextUnseenRaw.sort_order ?? 0),
      })
      : null;

    return {
      ...row,
      unlocked_items_json: unlockedItems,
      next_unseen_json: nextUnseen,
    };
  }

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

    return (
      rows[0] ?? {
        chat_id: input.chat_id,
        n: input.turn_no,
        scene_session_id: input.scene_session_id,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        price_required: input.price_xtr,
        panel_message_id: input.panel_message_id,
        stored_count: 0,
        invoice_rows_updated: 0,
      }
    );
  }

  async loadInvoiceToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedInvoiceToken | null> {
    const rows = await this.query<LoadedInvoiceToken[]>`
      WITH input AS (
        SELECT
          NULLIF(BTRIM(${token}), '') AS requested_token,
          ${chatId}::bigint AS requested_chat_id
      )
      SELECT
        i.requested_token,
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
        t.status,
        t.action_kind,
        t.sku,
        t.amount_xtr,
        CASE
          WHEN t.expires_at IS NULL THEN NULL
          ELSE to_char(t.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        t.telegram_invoice_message_id,
        (t.token IS NOT NULL) AS found
      FROM input i
      LEFT JOIN public.interaction_tokens t
        ON t.token = i.requested_token
       AND t.chat_id = i.requested_chat_id
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  async storePrecheckoutResult(input: StorePrecheckoutResultInput): Promise<void> {
    await this.query`
      UPDATE public.interaction_tokens AS t
      SET
        telegram_pre_checkout_query_id = ${input.pre_checkout_query_id}::text,
        failure_reason = CASE
          WHEN ${input.ok}::boolean THEN t.failure_reason
          WHEN t.status = 'invoice_sent' THEN ${input.error_message}::text
          ELSE t.failure_reason
        END,
        status = CASE
          WHEN ${input.ok}::boolean THEN t.status
          WHEN t.status = 'invoice_sent' THEN 'failed'
          ELSE t.status
        END
      WHERE t.token = ${input.token}::text
    `;
  }

  async markInvoicePaid(input: MarkInvoicePaidInput): Promise<PaidInvoiceToken | null> {
    const rows = await this.query<PaidInvoiceToken[]>`
      WITH input AS (
        SELECT
          ${input.token}::text AS token,
          ${input.chat_id}::bigint AS chat_id,
          ${input.expected_kind}::text AS expected_kind,
          ${input.expected_action_kind}::text AS expected_action_kind,
          NULLIF(BTRIM(${input.telegram_payment_charge_id}), '') AS payment_charge_id,
          NULLIF(BTRIM(${input.provider_payment_charge_id}), '') AS provider_payment_charge_id,
          NULLIF(BTRIM(${input.payment_currency}), '') AS currency,
          ${input.payment_total_amount}::integer AS total_amount
      ),
      updated AS (
        UPDATE public.interaction_tokens t
        SET
          status = 'paid',
          paid_at = COALESCE(t.paid_at, now()),
          telegram_payment_charge_id = i.payment_charge_id,
          telegram_provider_payment_charge_id = i.provider_payment_charge_id,
          payload_json = COALESCE(t.payload_json, '{}'::jsonb)
            || jsonb_build_object('currency', i.currency, 'total_amount', i.total_amount)
        FROM input i
        WHERE t.token = i.token
          AND t.chat_id = i.chat_id
          AND t.kind = i.expected_kind
          AND t.action_kind = i.expected_action_kind
          AND t.status = 'invoice_sent'
        RETURNING
          t.token,
          t.kind,
          t.chat_id,
          t.scene_session_id,
          t.turn_no,
          COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
          t.status,
          t.action_kind,
          t.sku,
          t.amount_xtr,
          t.telegram_invoice_message_id
      ),
      updated_state AS (
        UPDATE public.chat_state cs
        SET last_paid_at = now()
        FROM updated u
        WHERE cs.chat_id = u.chat_id
        RETURNING cs.chat_id
      )
      SELECT * FROM updated
    `;

    return rows[0] ?? null;
  }

  async activateSubscription(
    input: ActivateSubscriptionInput,
  ): Promise<number> {
    const rows = await this.query<Array<{ activated_count: number }>>`
      WITH input AS (
        SELECT
          ${input.payment_token}::text AS token,
          ${input.chat_id}::bigint AS chat_id,
          NULLIF(BTRIM(${input.subscription_sku}), '') AS sku,
          GREATEST(COALESCE(${input.subscription_days}::integer, 0), 0) AS subscription_days
      ),
      claimed_token AS (
        SELECT t.token, t.chat_id, t.sku
        FROM public.interaction_tokens t
        JOIN input i
          ON t.token = i.token
         AND t.chat_id = i.chat_id
         AND t.sku IS NOT DISTINCT FROM i.sku
         AND t.action_kind = 'subscription_payment'
        WHERE t.status = 'paid'
          AND i.subscription_days > 0
          AND i.sku IS NOT NULL
          AND i.sku LIKE 'media_sub_%'
        FOR UPDATE
      ),
      upd_state AS (
        UPDATE public.chat_state cs
        SET
          subscription_sku = i.sku,
          subscription_until = (
            CASE
              WHEN cs.subscription_until IS NOT NULL AND cs.subscription_until > now() THEN cs.subscription_until
              ELSE now()
            END + make_interval(days => i.subscription_days)
          ),
          last_paid_at = now()
        FROM input i
        JOIN claimed_token ct
          ON ct.chat_id = i.chat_id
        WHERE cs.chat_id = i.chat_id
        RETURNING ct.token, ct.chat_id, ct.sku
      ),
      upd_token AS (
        UPDATE public.interaction_tokens t
        SET
          status = 'fulfilled',
          fulfilled_at = COALESCE(t.fulfilled_at, now()),
          consumed_at = COALESCE(t.consumed_at, now())
        FROM upd_state us
        WHERE t.token = us.token
          AND t.chat_id = us.chat_id
          AND t.sku IS NOT DISTINCT FROM us.sku
          AND t.status = 'paid'
        RETURNING t.token
      )
      SELECT COALESCE((SELECT COUNT(*)::integer FROM upd_token), 0) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
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

    return (
      rows[0] ?? {
        chat_id: input.chat_id,
        n: input.turn_no,
        scene_session_id: input.scene_session_id,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        price_required: input.price_required,
        panel_message_id: input.panel_message_id,
        stored_count: 0,
        invoice_rows_updated: 0,
      }
    );
  }

  async storeInvoiceLinks(
    items: Array<{ token: string; chat_id: number; invoice_link: string }>,
  ): Promise<number> {
    const rows = await this.query<Array<{ updated_count: number }>>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(items)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT
          NULLIF(BTRIM(item ->> 'token'), '') AS token,
          NULLIF(item ->> 'chat_id', '')::bigint AS chat_id,
          NULLIF(BTRIM(item ->> 'invoice_link'), '') AS invoice_link
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements(p.items) AS item
      ),
      upd AS (
        UPDATE public.interaction_tokens t
        SET payload_json = COALESCE(t.payload_json, '{}'::jsonb)
          || jsonb_build_object('invoice_link', r.invoice_link)
        FROM rows r
        WHERE t.token = r.token
          AND t.chat_id = r.chat_id
          AND r.invoice_link IS NOT NULL
        RETURNING t.token
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS updated_count
      FROM upd
    `;

    return rows[0]?.updated_count ?? 0;
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    if (tokens.length === 0) {
      return [];
    }

    return this.query<StoredInvoiceToken[]>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(tokens)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT NULLIF(BTRIM(value), '') AS token
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.items) AS value
      )
      SELECT
        t.token,
        t.kind,
        t.chat_id,
        t.scene_session_id,
        t.turn_no,
        NULL::smallint AS scene_turn_no,
        COALESCE(t.payload_json, '{}'::jsonb) AS payload_json,
        t.sku,
        t.amount_xtr,
        t.telegram_invoice_payload,
        CASE
          WHEN t.expires_at IS NULL THEN NULL
          ELSE to_char(t.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        t.telegram_invoice_message_id,
        NULLIF(BTRIM(t.payload_json ->> 'invoice_link'), '') AS invoice_link,
        FALSE AS stored,
        '' AS invoice_title,
        '' AS invoice_description,
        '' AS invoice_label,
        '' AS invoice_button_text
      FROM public.interaction_tokens t
      JOIN rows r ON r.token = t.token
    `;
  }

  async storeSubscriptionOfferMessageId(
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ): Promise<number> {
    if (tokens.length === 0) {
      return 0;
    }

    const rows = await this.query<Array<{ updated_count: number }>>`
      WITH payload AS (
        SELECT COALESCE(${JSON.stringify(tokens)}::jsonb, '[]'::jsonb) AS items
      ),
      rows AS (
        SELECT NULLIF(BTRIM(value), '') AS token
        FROM payload p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.items) AS value
      ),
      upd AS (
        UPDATE public.interaction_tokens t
        SET telegram_invoice_message_id = ${offerMessageId}::bigint
        FROM rows r
        WHERE t.token = r.token
          AND t.chat_id = ${chatId}::bigint
        RETURNING t.token
      )
      SELECT COALESCE(COUNT(*)::integer, 0) AS updated_count
      FROM upd
    `;

    return rows[0]?.updated_count ?? 0;
  }
}
