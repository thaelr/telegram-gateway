import { activateVideoPass, activateFullSubscription } from '../access/videoEntitlements.js';
import { sql } from '../../db.js';
import type { JSONValue } from 'postgres';
import type { QueryClient } from '../../mediaCommerceRepository/shared.js';
import type { MediaPaymentOption } from '../../mediaCommerceTypes.js';

export interface VideoContextInput {
  chat_id: number; scene_session_id: string | null; character_i?: number | null;
  media_signature?: string | null; panel_message_id?: number | null;
  requested_photo_uuid?: string | null;
}
export interface VideoContext {
  video: { video_id: string; bucket_name: string; storage_path: string;
    requested_photo_uuid: string; source_photo_uuid: string;
    source_photo_bucket_name: string; source_photo_storage_path: string } | null;
  full_active: boolean; video_pass_active: boolean; subscription_sku: string | null;
  subscription_until: string | null; panel_delivered: boolean; scene_active: boolean;
  current_reply_markup?: unknown; panel_media_signature?: string | null; panel_photo_uuid?: string | null;
  character_i?: number | null;
  video_control_tokens?: string[]; video_payment_urls?: string[];
  delivery?: VideoDelivery | null;
}
export interface VideoDeliveryRequest {
  request_key: string; chat_id: number; scene_session_id: string | null; video_id: string;
  photo_message_id: number | null; telegram_chat_id: number | null; source: 'telegram' | 'web';
  requested_photo_uuid?: string | null;
  panel_caption?: string | null; panel_caption_entities?: unknown[] | null;
  payment_token?: string | null;
}
export interface VideoDelivery {
  scene_session_id?: string;
  telegram_message_id?: number | null;
  delivery_id: string; status: string; eligible_at: string; video_id: string;
  photo_message_id: number | null; telegram_chat_id: number | null; source: 'telegram' | 'web';
  bucket_name: string; storage_path: string; current_reply_markup?: unknown;
  video_control_tokens?: string[]; video_payment_urls?: string[]; chat_id?: number;
  payment_token?: string | null;
  delivered_at?: string | null;
  requested_photo_uuid?: string | null; source_photo_uuid?: string | null;
  source_photo_bucket_name?: string | null; source_photo_storage_path?: string | null;
  panel_insert_after_uuid?: string | null; source_photo_reveal_at?: string | null;
  panel_caption?: string | null; panel_caption_entities?: unknown[] | null;
  same_photo?: boolean | null;
}
export interface VideoPassOfferContext {
  scene_session_id: string | null;
  user_id: string | null;
  available: boolean;
  scene_access_active: boolean;
  paid_scene_unlock_token: string | null;
  media_signature?: string | null;
  matching_video?: boolean;
  scene_access_payment_token?: string | null;
  video_pass_payment_token?: string | null;
  scene_access_valid_until?: string | null;
  video_pass_valid_until?: string | null;
  subscription_active: boolean;
  full_active: boolean;
  video_pass_active: boolean;
}
export interface VideoUi {
  pass_button_text?: string;
  pass_offer_text?: string;
  pass_menu?: boolean;
  available: boolean; consumed: boolean; animate_callback_data?: string | null;
  chat_offer_callback_data?: string | null;
  unlock_payment_options?: MediaPaymentOption[]; pass_reveal_callback_data?: string | null;
  pass_price_rub?: number | null; pass_payment_options?: MediaPaymentOption[];
  full_active?: boolean; video_pass_active?: boolean;
}

/** Commerce adjunct. Payment attempts and their snapshots remain interaction_tokens. */
export class VideoCommerceRepository {
  readonly activateVideoPass: (token: string, chatId: number) => Promise<number>;
  readonly activateFullSubscription: (token: string, chatId: number, sku: string, days: number, change: string) => Promise<number>;

  constructor(private readonly query: QueryClient = sql) {
    this.activateVideoPass = activateVideoPass.bind(null, query);
    this.activateFullSubscription = activateFullSubscription.bind(null, query);
  }
  async context(input: VideoContextInput): Promise<VideoContext> {
    const rows = await this.query<{ value: VideoContext }[]>`SELECT public.media_video_context(
      ${input.chat_id}::bigint, ${input.scene_session_id}::text, ${input.character_i ?? null}::integer,
      ${input.media_signature ?? null}::text, ${input.panel_message_id ?? null}::bigint,
      ${input.requested_photo_uuid ?? null}::text) AS value`;
    if (!rows[0]?.value) throw new Error('Video context missing');
    return {...rows[0].value,delivery:normalizeDelivery(rows[0].value.delivery ?? null)};
  }
  async passOfferContext(chatId: number, scene: string | null, channel: 'telegram' | 'web'): Promise<VideoPassOfferContext> {
    const rows = await this.query<{value: VideoPassOfferContext}[]>`SELECT public.media_video_pass_offer_context(
      ${chatId}::bigint, ${scene}::text, ${channel}::text) AS value`;
    if (!rows[0]?.value) throw new Error('VideoPass offer context missing');
    return rows[0].value;
  }
  async prepareDelivery(input: VideoDeliveryRequest): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_prepare_video_delivery(${this.query.json(input as unknown as JSONValue)}::jsonb) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
  }
  async claimDelivery(id: string, claimToken: string): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_claim_video_delivery(${id}::uuid,${claimToken}::uuid) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
  }
  async getDelivery(id: string): Promise<VideoDelivery | null> {
    const rows=await this.query<{value:VideoDelivery|null}[]>`SELECT app_private.video_delivery_json(d) AS value
      FROM app_private.video_deliveries d JOIN public.chat_state c ON c.chat_id=d.chat_id AND c.user_id=d.user_id
      WHERE d.delivery_id=${id}::uuid`;
    return normalizeDelivery(rows[0]?.value??null);
  }
  async completeDelivery(id: string, claimToken: string, messageId: number | null): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_complete_video_delivery(${id}::uuid,${claimToken}::uuid,${messageId}::bigint) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
  }
  async failDelivery(id: string, claimToken: string, error: string, retryable: boolean): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_fail_video_delivery(${id}::uuid,${claimToken}::uuid,${error.slice(0,500)}::text,${retryable}::boolean) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
  }
  async storePanel(chatId: number, panelId: number, markup: unknown, signature: string | null, photoUuid: string | null): Promise<unknown> {
    const rows = await this.query<{ value: unknown }[]>`SELECT public.media_store_video_panel(${chatId}::bigint,${panelId}::bigint,${this.query.json((markup ?? {}) as JSONValue)}::jsonb,${signature}::text,${photoUuid}::text) AS value`;
    return rows[0]?.value ?? null;
  }
}

function normalizeDelivery(value: VideoDelivery | null): VideoDelivery | null {
  if (!value) return null;
  const id=(raw:unknown):number|null=>raw == null ? null : Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  return {...value,chat_id:id(value.chat_id) ?? undefined,photo_message_id:id(value.photo_message_id),
    telegram_message_id:id(value.telegram_message_id),telegram_chat_id:id(value.telegram_chat_id)};
}
