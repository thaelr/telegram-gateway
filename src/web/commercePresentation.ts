import type {WebPurchase} from './commerceTypes.js';
export function publicPurchase(p:WebPurchase){return {purchase_id:p.purchase_id,status:p.status,sku:p.quote.sku,kind:p.quote.kind,provider:p.provider,price:{amount:p.quote.amount,currency:p.quote.currency},...(p.quote.feature_key==='video_pass' && p.quote.payload?.purchase_variant ? {
  purchase_variant:p.quote.payload.purchase_variant,discount_percent:p.quote.payload.discount_percent,
  original_price:{amount:String(p.quote.payload.original_amount),currency:p.quote.currency}
 } : {}),checkout_url:p.checkout_url,media_id:p.quote.media_id??null,video_id:p.quote.video_id??null,video_delivery_id:p.quote.payload?.video_delivery_id??null,review_required:p.error_code==='duplicate_payment_requires_review'||p.error_code==='paid_scene_requires_review',subscription_tier:p.quote.payload?.subscription_tier,subscription_change:p.quote.payload?.subscription_change,created_at:p.created_at,updated_at:p.updated_at};}

export type PublicPurchase=ReturnType<typeof publicPurchase>;
