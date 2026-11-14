import type {SceneMode} from './types.js';
import type {ProviderPayment} from '../payments/providers.js';
export type WebProductPlan = {
 sku: string;
 kind: 'subscription' | 'photo' | 'feature';
 title: string;
 description: string;
 amount_xtr: number;
 amount_rub: number | null;
 original_amount_rub: number | null;
 promo_key: string | null;
 subscription_days?: number;
 subscription_tier?: 'base' | 'full';
 subscription_change?: 'upgrade' | 'renew';
 upgrade_base_sku?: string;
 upgrade_full_amount_xtr?: number;
 upgrade_full_amount_rub?: number | null;
 feature_key?: string;
 scene_session_id?: string;
 purchase_variant?: import('../modules/products/plans.js').VideoPassVariant;
 discount_percent?: number;
 paid_scene_unlock_token?: string | null;
 grant_cycle?: string | null;
 duration_days?: number;
};

export type WebCommerceContext = {
 chat_id:number; chat_code:string; character_i:number; scene_session_id:string|null;
 turn_no:number; scene_turn_no:number|null; scene_mode:SceneMode|null; debounce_revision?:number;
};
export type WebCommerceQuote = Omit<WebCommerceContext,'chat_id'|'chat_code'|'character_i'> & {
 chat_id:number|null;chat_code:string|null;character_i:number|null;
 sku:string; title:string; description:string; kind:'subscription'|'photo'|'feature';
 amount:string; currency:string; amount_xtr:number|null; subscription_days?:number;
 feature_key?:string; media_id?:string; media_signature?:string; panel_id?:number; video_id?:string;
 requested_photo_uuid?:string;source_photo_uuid?:string;video_media_signature?:string;
 price_required?:number; payload?:Record<string,unknown>;
};
export type WebPurchase = {
 purchase_id:string; user_id:string; chat_id:number|null; client_id:string; fingerprint:string;
 provider:string; payment_token:string; quote:WebCommerceQuote; status:string;
 external_id:string|null; external_kind:'invoice'|'payment'|null;
 external_invoice_id:string|null; external_payment_id:string|null; checkout_url:string|null;
 expires_at:string|null; provider_data:ProviderPayment|null; error_code:string|null;
 created_at:string; updated_at:string;
};
export type Purchase = WebPurchase;
export type WebMediaOffer = WebCommerceContext & {
 media_id:string; sku:string; media_signature:string; panel_id:number; media_kind:'photo';
};
