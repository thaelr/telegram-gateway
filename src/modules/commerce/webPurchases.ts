import {createHash} from 'node:crypto';
import {config} from '../../config.js';
import {WebError} from '../../web/types.js';
import type {WebCommerceRepository} from './webPurchaseRepository.js';
import type {WebProductPlan,WebPurchase,WebCommerceQuote} from '../../web/commerceTypes.js';
import {PaymentProviderRegistry,ProviderError,type ProviderCreateInput,type ProviderPayment} from '../../payments/providers.js';
import {eligibleWebUpgrade} from '../access/webUpgradeEligibility.js';
import type {PublicPurchase} from '../../web/commercePresentation.js';
export type PurchaseInput = {client_message_id:string;chat_code?:string;sku:string;provider?:string;media_id?:string;subscription_change?:'upgrade'|'renew'};

export async function buildWebQuote(repository:WebCommerceRepository,plans:(userId:string,chatId:number|null)=>Promise<WebProductPlan[]>,userId:string,input:{chat_code?:string;sku:string;media_id?:string;subscription_change?:'upgrade'|'renew'}):Promise<WebCommerceQuote>{
  const context=input.chat_code?await repository.getContext(userId,input.chat_code):{chat_id:null,chat_code:null,character_i:null,scene_session_id:null,turn_no:0,scene_turn_no:null,scene_mode:null};
  if (!input.chat_code && config.MEDIA_ACTION_PLANS_JSON.some(item=>item.sku===input.sku && item.feature_key==='video_pass')) throw new WebError(400,'chat_required');
  const plan=(await plans(userId,context.chat_id)).find(x=>x.sku===input.sku);
  if(!plan)throw new WebError(404,'product_not_found');
  if(plan.kind!=='subscription'&&!input.chat_code)throw new WebError(400,'chat_required');
  if(plan.kind==='feature'&&!['scene_unlock','fast_scene_skip','video_unlock','video_pass'].includes(plan.feature_key??''))throw new WebError(409,'unsupported_feature');
  const videoFeature=plan.feature_key==='video_unlock'||plan.feature_key==='video_pass';
  if((videoFeature||plan.subscription_tier==='full')&&!config.MEDIA_VIDEO_ENABLED)throw new WebError(409,'video_disabled');
  if(plan.amount_rub==null&&plan.kind==='subscription')throw new WebError(409,'web_price_unavailable');
  const quote:WebCommerceQuote={...context,sku:plan.sku,kind:plan.kind,title:plan.title,description:plan.description,amount:plan.amount_rub==null?'0':String(plan.amount_rub),currency:'RUB',amount_xtr:plan.amount_xtr,subscription_days:plan.subscription_days,feature_key:plan.feature_key,payload:{promo_key:plan.promo_key,original_amount_rub:plan.original_amount_rub,web_price_available:plan.amount_rub!=null}};
  if(plan.feature_key==='video_pass'||plan.feature_key==='scene_unlock') quote.payload={...quote.payload,duration_days:config.SCENE_ACCESS_DAYS,grant_cycle:plan.grant_cycle??null};
  if(plan.kind==='subscription'){
   quote.payload={...quote.payload,account_subscription:true,subscription_tier:plan.subscription_tier??'base',subscription_change:input.subscription_change??'renew'};
   if(input.subscription_change==='upgrade'){
    const upgrade=eligibleWebUpgrade(plan,await repository.getEntitlements(userId));
    if(!upgrade)throw new WebError(409,'upgrade_unavailable');
    if(upgrade.amount_rub==null||upgrade.amount_rub<=0)throw new WebError(409,'upgrade_price_unavailable');
    quote.amount=String(upgrade.amount_rub);quote.amount_xtr=upgrade.amount_xtr;
    quote.payload={...quote.payload,base_sku:upgrade.base_sku,upgrade_base_sku:upgrade.base_sku,upgrade_discount_percent:config.MEDIA_UPGRADE_DISCOUNT_PERCENT,full_discount_percent:config.MEDIA_FULL_DISCOUNT_PERCENT};
   }
  }else if(input.subscription_change)throw new WebError(400,'unexpected_subscription_change');
  if(plan.kind!=='subscription'&&!context.scene_session_id)throw new WebError(409,'scene_required');
  if(plan.kind==='photo'){
   if(!input.media_id)throw new WebError(400,'media_id_required');
   const offer=await repository.getOffer(userId,input.chat_code!,input.media_id);
   if(!offer||offer.sku!==plan.sku||offer.scene_session_id!==context.scene_session_id)throw new WebError(404,'media_offer_not_found');
   Object.assign(quote,{media_id:offer.media_id,media_signature:offer.media_signature,panel_id:offer.panel_id,turn_no:offer.turn_no,scene_turn_no:offer.scene_turn_no});
  } else if(videoFeature){
   if (plan.feature_key==='video_pass') {
    quote.payload={...quote.payload,user_id:userId,purchase_variant:plan.purchase_variant,paid_scene_unlock_token:plan.paid_scene_unlock_token ?? null,
      original_amount:plan.original_amount_rub,discount_percent:plan.discount_percent ?? 0,
      final_amount:plan.amount_rub,currency:'RUB',pass_only:!input.media_id};
   }
   if(plan.feature_key==='video_unlock'&&!input.media_id)throw new WebError(400,'media_id_required');
   if(input.media_id){
    const offer=await repository.getOffer(userId,input.chat_code!,input.media_id);
    if(!offer)throw new WebError(404,'media_offer_not_found');
    const access=await repository.videos.context(offer);
    if(!access.video||access.panel_delivered||access.delivery||!access.scene_active)throw new WebError(409,'video_unavailable');
    if(access.full_active||access.video_pass_active)throw new WebError(409,'video_already_available');
    Object.assign(quote,{video_id:access.video.video_id,media_id:offer.media_id,requested_photo_uuid:access.video.requested_photo_uuid,
     source_photo_uuid:access.video.source_photo_uuid,media_signature:offer.media_signature,panel_id:offer.panel_id,turn_no:offer.turn_no,scene_turn_no:offer.scene_turn_no});
   }
  } else if(input.media_id) throw new WebError(400,'unexpected_media_id');
  return quote;
 }

export function purchaseFingerprint(input:PurchaseInput,quote?:WebCommerceQuote){return createHash('sha256').update(JSON.stringify({chat_code:input.chat_code,sku:input.sku,provider:input.provider,media_id:input.media_id??null,
  ...(quote?.payload?.purchase_variant ? {purchase_variant:quote.payload.purchase_variant,scene_session_id:quote.scene_session_id} : {}),
  ...(quote?.payload?.grant_cycle ? {grant_cycle:quote.payload.grant_cycle,scene_session_id:quote.scene_session_id} : {}),
  ...(input.subscription_change==='upgrade'?{subscription_change:'upgrade'}:{})})).digest('hex');}

export function providerInput(p:WebPurchase):ProviderCreateInput{return {order_id:p.purchase_id,attempt_id:p.payment_token,amount:p.quote.amount,currency:p.quote.currency,description:p.quote.description,...(p.chat_id==null?{user_id:p.user_id}:{chat_id:p.chat_id})};}

export async function createCheckout(repository:WebCommerceRepository,providers:PaymentProviderRegistry,p:WebPurchase):Promise<void>{
  if(!await repository.claimCreation(p.purchase_id))return;
  try{const checkout=await providers.get(p.provider,'web').create(providerInput(p));await repository.bindCheckout(p.purchase_id,checkout);}
  catch(error){await repository.markCreationFailure(p.purchase_id,!(error instanceof ProviderError)||error.outcome==='ambiguous',error instanceof ProviderError?error.code:'provider_creation_uncertain');}
 }

export async function recover(repository:WebCommerceRepository,p:WebPurchase):Promise<WebPurchase>{
  if(p.error_code==='duplicate_payment_requires_review'||p.error_code==='paid_scene_requires_review')return p;
  if(p.status==='paid'||p.status==='fulfillment_pending')return repository.fulfill(p.purchase_id);
  return p;
 }

export async function recoverPending(repository:WebCommerceRepository):Promise<void>{
  for(const p of await repository.pendingFulfillments()){
   try{await recover(repository,p);}catch{/* Paid state remains durable; the next pass retries the same token. */}
  }
 }

export async function notification(repository:WebCommerceRepository,providers:PaymentProviderRegistry,providerId:string,raw:string,signature:string|undefined){
  const provider=providers.get(providerId,'web');
  if(!provider.verifyNotification)throw new WebError(404,'notification_not_supported');
  const payment:ProviderPayment=provider.verifyNotification(raw,signature);
  let p:WebPurchase|null=null;
  if(payment.order_id){try{p=await repository.getById(payment.order_id);}catch{throw new WebError(404,'purchase_not_found');}}
  if(!p)p=await repository.getByProviderExternal(providerId,payment.external_payment_id);
  if(!p)throw new WebError(404,'purchase_not_found');
  // The repository revalidates immutable order, provider, IDs, currency and amount under lock.
  p=await repository.confirmVerified(p.purchase_id,payment);
  p=await recover(repository,p);
  return {accepted:true,purchase_id:p.purchase_id,status:p.status};
 }

export async function purchase(repository:WebCommerceRepository,providers:PaymentProviderRegistry,consent:(userId:string)=>Promise<void>,plans:(userId:string,chatId:number|null)=>Promise<WebProductPlan[]>,allowedProviders:(userId:string)=>Promise<string[]>,publicPurchase:(p:WebPurchase)=>PublicPurchase,userId:string,input:PurchaseInput){
  await consent(userId);
  const old=await repository.findByClient(userId,input.client_message_id);
  if(old){if(old.fingerprint!==purchaseFingerprint(input,old.quote))throw new WebError(409,'idempotency_conflict');if(old.status==='created')await createCheckout(repository,providers,old);return publicPurchase(await recover(repository,await repository.getOwned(userId,old.purchase_id)));}
  const quote=await buildWebQuote(repository,plans,userId,input);
  const fingerprint=purchaseFingerprint(input,quote);
  if(quote.kind==='photo'&&quote.media_id){const free=await repository.unlockFree(userId,input.chat_code!,quote.media_id,quote);if(free.unlocked)return free;}
  if(quote.kind==='feature'){const free=await repository.redeemFreeFeature(userId,quote,input.client_message_id);if(free.available)return free;}
  if(!input.provider)throw new WebError(402,'payment_required');
  if(quote.amount==='0')throw new WebError(409,'web_price_unavailable');
  if(!(await allowedProviders(userId)).includes(input.provider))throw new WebError(400,'payment_method_unavailable');
  const provider=providers.get(input.provider,'web');
  const result=await repository.createOrGet(userId,input.client_message_id,fingerprint,quote,provider.id);
  const p=result.purchase;
  await createCheckout(repository,providers,p);
  return publicPurchase(await repository.getOwned(userId,p.purchase_id));
 }

export async function status(repository:WebCommerceRepository,providers:PaymentProviderRegistry,publicPurchase:(p:WebPurchase)=>PublicPurchase,userId:string,id:string){
  let p=await repository.getOwned(userId,id);
  if(p.status==='pending'&&p.external_payment_id){
   const provider=providers.get(p.provider,'web');
   if(provider.getStatus){try{p=await repository.confirmVerified(p.purchase_id,await provider.getStatus(p.external_payment_id,providerInput(p)));}catch(error){if(!(error instanceof ProviderError))throw error;}}
  }
  return publicPurchase(await recover(repository,p));
 }
