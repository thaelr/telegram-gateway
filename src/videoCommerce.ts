import { sql } from './db.js';
import type { JSONValue } from 'postgres';
import type { QueryClient } from './mediaCommerceRepository/shared.js';
import type { MediaPaymentOption } from './mediaCommerceTypes.js';

export interface VideoContextInput {
  chat_id: number; scene_session_id: string | null; character_i?: number | null;
  media_signature?: string | null; panel_message_id?: number | null;
}
export interface VideoContext {
  video: { video_id: string; bucket_name: string; storage_path: string } | null;
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
  payment_token?: string | null;
}
export interface VideoDelivery {
  delivery_id: string; status: string; eligible_at: string; video_id: string;
  photo_message_id: number | null; telegram_chat_id: number | null; source: 'telegram' | 'web';
  bucket_name: string; storage_path: string; current_reply_markup?: unknown;
  video_control_tokens?: string[]; video_payment_urls?: string[]; chat_id?: number;
  delivered_at?: string | null;
}
export interface VideoUi {
  available: boolean; consumed: boolean; animate_callback_data?: string | null;
  chat_offer_callback_data?: string | null;
  unlock_payment_options?: MediaPaymentOption[]; pass_reveal_callback_data?: string | null;
  pass_price_rub?: number | null; pass_payment_options?: MediaPaymentOption[];
  full_active?: boolean; video_pass_active?: boolean;
}

/** Commerce adjunct. Payment attempts and their snapshots remain interaction_tokens. */
export class VideoCommerceRepository {
  constructor(private readonly query: QueryClient = sql) {}
  async context(input: VideoContextInput): Promise<VideoContext> {
    const rows = await this.query<{ value: VideoContext }[]>`SELECT public.media_video_context(
      ${input.chat_id}::bigint, ${input.scene_session_id}::text, ${input.character_i ?? null}::integer,
      ${input.media_signature ?? null}::text, ${input.panel_message_id ?? null}::bigint) AS value`;
    if (!rows[0]?.value) throw new Error('Video context missing');
    return {...rows[0].value,delivery:normalizeDelivery(rows[0].value.delivery ?? null)};
  }
  async prepareDelivery(input: VideoDeliveryRequest): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_prepare_video_delivery(${this.query.json(input as unknown as JSONValue)}::jsonb) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
  }
  async claimDelivery(id: string, claimToken: string): Promise<VideoDelivery | null> {
    const rows = await this.query<{ value: VideoDelivery | null }[]>`SELECT public.media_claim_video_delivery(${id}::uuid,${claimToken}::uuid) AS value`;
    return normalizeDelivery(rows[0]?.value ?? null);
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
  async activateVideoPass(paymentToken: string, chatId: number): Promise<number> {
    const rows = await this.query<{ value: number }[]>`SELECT public.media_activate_video_pass(${paymentToken}::text,${chatId}::bigint) AS value`;
    return Number(rows[0]?.value ?? 0);
  }
  async activateFullSubscription(paymentToken: string, chatId: number, sku: string, days: number, change: string): Promise<number> {
    const rows = await this.query<{ value: number }[]>`SELECT public.media_activate_full_subscription(${paymentToken}::text,${chatId}::bigint,${sku}::text,${days}::integer,${change}::text) AS value`;
    return Number(rows[0]?.value ?? 0);
  }
}

function normalizeDelivery(value: VideoDelivery | null): VideoDelivery | null {
  if (!value) return null;
  const id=(raw:unknown):number|null=>raw == null ? null : Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  return {...value,chat_id:id(value.chat_id) ?? undefined,photo_message_id:id(value.photo_message_id),telegram_chat_id:id(value.telegram_chat_id)};
}
