import { createHash } from 'node:crypto';
import { MediaCommerceDecisionService } from '../mediaCommerceDecisionService.js';
import { PaymentProviderRegistry, ProviderError, type ProviderCreateInput, type ProviderPayment } from '../payments/providers.js';
import { WebCommerceRepository, type WebCommerceQuote, type WebPurchase } from './commerceRepository.js';
import type { WebRepositoryContract } from './types.js';
import { WebError } from './types.js';
import { config } from '../config.js';
import { calculateFullUpgrade } from '../mediaCommerce/plans.js';
import type { WebProductPlan } from './commerceTypes.js';
import type { LocalizationService } from '../localization.js';
import type {WebPhotoPanelAction} from './photoPanels.js';

export type PurchaseInput = {client_message_id:string;chat_code?:string;sku:string;provider?:string;media_id?:string;subscription_change?:'upgrade'|'renew'};
export class WebCommerceService {
 private timer:ReturnType<typeof setTimeout>|null=null;
 private recovering:Promise<void>|null=null;
 private stopped=true;
 constructor(readonly repository:WebCommerceRepository, readonly providers:PaymentProviderRegistry, readonly decisions:MediaCommerceDecisionService, readonly accounts:WebRepositoryContract, readonly localization:(Pick<LocalizationService,'getNamespace'|'getTelegramCopy'|'getPaymentMethods'>&Partial<Pick<LocalizationService,'getExactNamespace'>>)|null=null) {}
 private async allowedProviders(userId:string):Promise<string[]> {
  if(!this.localization)return this.providers.list('web');
  const profile=await this.accounts.getMe(userId);
  const configured=await this.localization.getPaymentMethods(profile.language,'web');
  const available=new Set(this.providers.list('web'));
  return configured.filter(provider=>available.has(provider));
 }
 private async plans(userId:string,chatId:number|null){
  const plans=await this.decisions.webProductPlans(chatId);
  if(!this.localization)return plans;
  const profile=await this.accounts.getMe(userId);
  const dictionary=await this.localization.getNamespace(profile.language,'commerce');
  // Keep global/Telegram fallback unchanged, while an inherited Russian SKU
  // entry must not override a supplied English semantic product translation.
  const exact=this.localization.getExactNamespace?await this.localization.getExactNamespace(profile.language,'commerce'):dictionary;
  const products=exact?.products&&typeof exact.products==='object'&&!Array.isArray(exact.products)?exact.products as Record<string,unknown>:{};
  const productTypes=dictionary.product_types&&typeof dictionary.product_types==='object'&&!Array.isArray(dictionary.product_types)?dictionary.product_types as Record<string,unknown>:{};
  return plans.map(plan=>{
   const variant=plan.purchase_variant==='scene_unlock_upgrade';
   const semantic=variant ? productTypes.scene_unlock_upgrade : productTypes[plan.kind==='subscription'?(plan.subscription_tier??'base'):plan.kind==='photo'?'photo':plan.feature_key??''];
   const specific=products[plan.sku];
   const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
   const copy=plan.feature_key==='video_pass' ? object(semantic) : {...object(semantic),...object(specific)};
   const localized=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?value.replaceAll('{days}',String(plan.subscription_days??'')):fallback;
   return {...plan,title:localized(copy.title,plan.title),description:localized(copy.description,plan.description)};
  });
 }
 private async consent(userId:string){const p=await this.accounts.getMe(userId);if(!p.age_confirmed_at||!p.terms_accepted_at)throw new WebError(403,'consent_required');}
 async catalog(userId:string,code?:string){
  let chatId:number|null=null;
  if(code) chatId=(await this.repository.getContext(userId,code)).chat_id;
  const plans=await this.plans(userId,chatId);
  const rights=await this.repository.getEntitlements(userId);
  const providers=await this.allowedProviders(userId);
  return {products:plans.map(p=>{
   const upgrade=p.subscription_tier==='full'?this.upgrade(p,rights):null;
   return {sku:p.sku,kind:p.kind,title:p.title,description:p.description,price:p.amount_rub==null?null:{amount:String(p.amount_rub),currency:'RUB'},original_price:p.original_amount_rub==null?null:{amount:String(p.original_amount_rub),currency:'RUB'},promo_key:p.promo_key,subscription_days:p.subscription_days,subscription_tier:p.subscription_tier,feature_key:p.feature_key,purchase_variant:p.purchase_variant,scene_session_id:p.scene_session_id,discount_percent:p.discount_percent,requires_chat:p.kind!=='subscription',upgrade:upgrade&&upgrade.amount_rub!=null&&upgrade.amount_rub>0?{subscription_change:'upgrade',base_sku:upgrade.base_sku,price:{amount:String(upgrade.amount_rub),currency:'RUB'},days:30}:null,providers:p.amount_rub==null?[]:providers};
  }),providers,pricing_requires_chat:chatId==null};
 }
 entitlements(userId:string){return this.repository.getEntitlements(userId);}
 async photoPanel(userId:string,code:string,mediaId:string,current?:string){
  await this.consent(userId);const context=await this.repository.getContext(userId,code);
  return this.repository.photoPanels.get(userId,code,mediaId,current,await this.plans(userId,context.chat_id));
 }
 async photoPanelAction(userId:string,code:string,mediaId:string,input:{client_message_id:string;action:WebPhotoPanelAction;current_media_id?:string}){
  await this.consent(userId);const context=await this.repository.getContext(userId,code);
  return this.repository.photoPanels.act(userId,code,mediaId,input,await this.plans(userId,context.chat_id));
 }
 async gallery(userId:string,code:string){
  const result=await this.repository.gallery(userId,code);
  if(!config.MEDIA_VIDEO_ENABLED)return result;
  const offers=await this.repository.getOffers(userId,code,result.media.map(media=>media.media_id));
  const states=await this.repository.videos.contexts(offers);
  return {...result,media:result.media.map(media=>{
   const state=states.get(media.media_id);
   if(!state)return {...media,animation_available:false};
   const delivery=state.delivery?.source==='web'?state.delivery:null;
   return {...media,animation_available:Boolean(state.video&&state.scene_active&&!state.panel_delivered&&!state.delivery),video_access:state.full_active?'full':state.video_pass_active?'video_pass':null,...(delivery?{video_delivery_id:delivery.delivery_id,video_delivery_status:delivery.status,ready_at:this.repository.videos.publicDelivery(delivery).ready_at}:{})};
  })};
 }
 async videoAvailability(userId:string,code:string,mediaId:string){
  if(!config.MEDIA_VIDEO_ENABLED)throw new WebError(409,'video_disabled');
  const offer=await this.repository.getOffer(userId,code,mediaId);
  if(!offer)throw new WebError(404,'media_offer_not_found');
  const state=await this.repository.videos.context(offer);
  return {media_id:mediaId,animation_available:Boolean(state.video&&state.scene_active&&!state.panel_delivered&&!state.delivery),video_id:state.video?.video_id??null,full_active:state.full_active,video_pass_active:state.video_pass_active,panel_delivered:state.panel_delivered,scene_session_id:offer.scene_session_id,...(state.delivery?.source==='web'?{delivery:this.repository.videos.publicDelivery(state.delivery)}:{})};
 }
 async requestVideo(userId:string,code:string,mediaId:string,clientId:string){
  await this.consent(userId);
  if(!config.MEDIA_VIDEO_ENABLED)throw new WebError(409,'video_disabled');
  const key=this.repository.videos.requestKey(userId,code,mediaId,clientId);
  const existing=await this.repository.videos.byRequest(userId,key);
  if(existing)return this.repository.videos.publicDelivery(existing);
  const offer=await this.repository.getOffer(userId,code,mediaId);
  if(!offer)throw new WebError(404,'media_offer_not_found');
  const state=await this.repository.videos.context(offer);
  if(!state.video||!state.scene_active||state.panel_delivered)throw new WebError(409,'video_unavailable');
  if(!state.full_active&&!state.video_pass_active)throw new WebError(402,'video_payment_required');
  const delivery=await this.repository.videos.prepare({request_key:key,chat_id:offer.chat_id,scene_session_id:offer.scene_session_id,video_id:state.video.video_id,media_signature:offer.media_signature,requested_photo_uuid:offer.media_id,photo_message_id:offer.panel_id});
  return this.repository.videos.publicDelivery(delivery);
 }
 async videoAccess(userId:string,id:string){
  await this.consent(userId);
  return this.repository.videos.access(userId,id);
 }
 private upgrade(plan:WebProductPlan,rights:{subscription_sku?:string|null;subscription_until?:string|null;full_active?:boolean}){
  if(plan.subscription_tier!=='full'||rights.full_active||!rights.subscription_until||Date.parse(rights.subscription_until)<=Date.now())return null;
  const nominal=config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(p=>p.sku===rights.subscription_sku&&p.tier!=='full');
  if(!nominal)return null;
  return {...calculateFullUpgrade(plan,nominal,config.MEDIA_UPGRADE_DISCOUNT_PERCENT),base_sku:nominal.sku};
 }
 private async quote(userId:string,input:{chat_code?:string;sku:string;media_id?:string;subscription_change?:'upgrade'|'renew'}):Promise<WebCommerceQuote>{
  const context=input.chat_code?await this.repository.getContext(userId,input.chat_code):{chat_id:null,chat_code:null,character_i:null,scene_session_id:null,turn_no:0,scene_turn_no:null,scene_mode:null};
  if (!input.chat_code && config.MEDIA_ACTION_PLANS_JSON.some(item=>item.sku===input.sku && item.feature_key==='video_pass')) throw new WebError(400,'chat_required');
  const plan=(await this.plans(userId,context.chat_id)).find(x=>x.sku===input.sku);
  if(!plan)throw new WebError(404,'product_not_found');
  if(plan.kind!=='subscription'&&!input.chat_code)throw new WebError(400,'chat_required');
  if(plan.kind==='feature'&&!['scene_unlock','fast_scene_skip','video_unlock','video_pass'].includes(plan.feature_key??''))throw new WebError(409,'unsupported_feature');
  const videoFeature=plan.feature_key==='video_unlock'||plan.feature_key==='video_pass';
  if((videoFeature||plan.subscription_tier==='full')&&!config.MEDIA_VIDEO_ENABLED)throw new WebError(409,'video_disabled');
  if(plan.amount_rub==null&&plan.kind==='subscription')throw new WebError(409,'web_price_unavailable');
  const quote:WebCommerceQuote={...context,sku:plan.sku,kind:plan.kind,title:plan.title,description:plan.description,amount:plan.amount_rub==null?'0':String(plan.amount_rub),currency:'RUB',amount_xtr:plan.amount_xtr,subscription_days:plan.subscription_days,feature_key:plan.feature_key,payload:{promo_key:plan.promo_key,original_amount_rub:plan.original_amount_rub,web_price_available:plan.amount_rub!=null}};
  if(plan.kind==='subscription'){
   quote.payload={...quote.payload,account_subscription:true,subscription_tier:plan.subscription_tier??'base',subscription_change:input.subscription_change??'renew'};
   if(input.subscription_change==='upgrade'){
    const upgrade=this.upgrade(plan,await this.repository.getEntitlements(userId));
    if(!upgrade)throw new WebError(409,'upgrade_unavailable');
    if(upgrade.amount_rub==null||upgrade.amount_rub<=0)throw new WebError(409,'upgrade_price_unavailable');
    quote.amount=String(upgrade.amount_rub);quote.amount_xtr=upgrade.amount_xtr;
    quote.payload={...quote.payload,base_sku:upgrade.base_sku,upgrade_base_sku:upgrade.base_sku,upgrade_discount_percent:config.MEDIA_UPGRADE_DISCOUNT_PERCENT,full_discount_percent:config.MEDIA_FULL_DISCOUNT_PERCENT};
   }
  }else if(input.subscription_change)throw new WebError(400,'unexpected_subscription_change');
  if(plan.kind!=='subscription'&&!context.scene_session_id)throw new WebError(409,'scene_required');
  if(plan.kind==='photo'){
   if(!input.media_id)throw new WebError(400,'media_id_required');
   const offer=await this.repository.getOffer(userId,input.chat_code!,input.media_id);
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
    const offer=await this.repository.getOffer(userId,input.chat_code!,input.media_id);
    if(!offer)throw new WebError(404,'media_offer_not_found');
    const access=await this.repository.videos.context(offer);
    if(!access.video||access.panel_delivered||access.delivery||!access.scene_active)throw new WebError(409,'video_unavailable');
    if(access.full_active||access.video_pass_active)throw new WebError(409,'video_already_available');
    Object.assign(quote,{video_id:access.video.video_id,media_id:offer.media_id,requested_photo_uuid:access.video.requested_photo_uuid,
     source_photo_uuid:access.video.source_photo_uuid,media_signature:offer.media_signature,panel_id:offer.panel_id,turn_no:offer.turn_no,scene_turn_no:offer.scene_turn_no});
   }
  } else if(input.media_id) throw new WebError(400,'unexpected_media_id');
  return quote;
 }
 private fingerprint(input:PurchaseInput,quote?:WebCommerceQuote){return createHash('sha256').update(JSON.stringify({chat_code:input.chat_code,sku:input.sku,provider:input.provider,media_id:input.media_id??null,
  ...(quote?.payload?.purchase_variant ? {purchase_variant:quote.payload.purchase_variant,scene_session_id:quote.scene_session_id} : {}),
  ...(input.subscription_change==='upgrade'?{subscription_change:'upgrade'}:{})})).digest('hex');}
 private providerInput(p:WebPurchase):ProviderCreateInput{return {order_id:p.purchase_id,attempt_id:p.payment_token,amount:p.quote.amount,currency:p.quote.currency,description:p.quote.description,...(p.chat_id==null?{user_id:p.user_id}:{chat_id:p.chat_id})};}
 private async createCheckout(p:WebPurchase):Promise<void>{
  if(!await this.repository.claimCreation(p.purchase_id))return;
  try{const checkout=await this.providers.get(p.provider,'web').create(this.providerInput(p));await this.repository.bindCheckout(p.purchase_id,checkout);}
  catch(error){await this.repository.markCreationFailure(p.purchase_id,!(error instanceof ProviderError)||error.outcome==='ambiguous',error instanceof ProviderError?error.code:'provider_creation_uncertain');}
 }
 publicPurchase(p:WebPurchase){return {purchase_id:p.purchase_id,status:p.status,sku:p.quote.sku,kind:p.quote.kind,provider:p.provider,price:{amount:p.quote.amount,currency:p.quote.currency},...(p.quote.feature_key==='video_pass' && p.quote.payload?.purchase_variant ? {
  purchase_variant:p.quote.payload.purchase_variant,discount_percent:p.quote.payload.discount_percent,
  original_price:{amount:String(p.quote.payload.original_amount),currency:p.quote.currency}
 } : {}),checkout_url:p.checkout_url,media_id:p.quote.media_id??null,video_id:p.quote.video_id??null,video_delivery_id:p.quote.payload?.video_delivery_id??null,review_required:p.error_code==='duplicate_payment_requires_review',subscription_tier:p.quote.payload?.subscription_tier,subscription_change:p.quote.payload?.subscription_change,created_at:p.created_at,updated_at:p.updated_at};}
 async purchase(userId:string,input:PurchaseInput){
  await this.consent(userId);
  const old=await this.repository.findByClient(userId,input.client_message_id);
  if(old){if(old.fingerprint!==this.fingerprint(input,old.quote))throw new WebError(409,'idempotency_conflict');if(old.status==='created')await this.createCheckout(old);return this.publicPurchase(await this.recover(await this.repository.getOwned(userId,old.purchase_id)));}
  const quote=await this.quote(userId,input);
  const fingerprint=this.fingerprint(input,quote);
  if(quote.kind==='photo'&&quote.media_id){const free=await this.repository.unlockFree(userId,input.chat_code!,quote.media_id,quote);if(free.unlocked)return free;}
  if(quote.kind==='feature'){const free=await this.repository.redeemFreeFeature(userId,quote,input.client_message_id);if(free.available)return free;}
  if(!input.provider)throw new WebError(402,'payment_required');
  if(quote.amount==='0')throw new WebError(409,'web_price_unavailable');
  if(!(await this.allowedProviders(userId)).includes(input.provider))throw new WebError(400,'payment_method_unavailable');
  const provider=this.providers.get(input.provider,'web');
  const result=await this.repository.createOrGet(userId,input.client_message_id,fingerprint,quote,provider.id);
  const p=result.purchase;
  await this.createCheckout(p);
  return this.publicPurchase(await this.repository.getOwned(userId,p.purchase_id));
 }
 private async recover(p:WebPurchase):Promise<WebPurchase>{
  if(p.error_code==='duplicate_payment_requires_review')return p;
  if(p.status==='paid'||p.status==='fulfillment_pending')return this.repository.fulfill(p.purchase_id);
  return p;
 }
 async recoverPending():Promise<void>{
  for(const p of await this.repository.pendingFulfillments()){
   try{await this.recover(p);}catch{/* Paid state remains durable; the next pass retries the same token. */}
  }
 }
 start(){if(!this.stopped)return;this.stopped=false;const loop=()=>{if(this.stopped)return;this.recovering=this.recoverPending().catch(()=>undefined).finally(()=>{this.recovering=null;if(!this.stopped){this.timer=setTimeout(loop,5000);this.timer.unref();}});};loop();}
 async stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.recovering;}
 async status(userId:string,id:string){
  let p=await this.repository.getOwned(userId,id);
  if(p.status==='pending'&&p.external_payment_id){
   const provider=this.providers.get(p.provider,'web');
   if(provider.getStatus){try{p=await this.repository.confirmVerified(p.purchase_id,await provider.getStatus(p.external_payment_id,this.providerInput(p)));}catch(error){if(!(error instanceof ProviderError))throw error;}}
  }
  return this.publicPurchase(await this.recover(p));
 }
 async notification(providerId:string,raw:string,signature:string|undefined){
  const provider=this.providers.get(providerId,'web');
  if(!provider.verifyNotification)throw new WebError(404,'notification_not_supported');
  const payment:ProviderPayment=provider.verifyNotification(raw,signature);
  let p:WebPurchase|null=null;
  if(payment.order_id){try{p=await this.repository.getById(payment.order_id);}catch{throw new WebError(404,'purchase_not_found');}}
  if(!p)p=await this.repository.getByProviderExternal(providerId,payment.external_payment_id);
  if(!p)throw new WebError(404,'purchase_not_found');
  // The repository revalidates immutable order, provider, IDs, currency and amount under lock.
  p=await this.repository.confirmVerified(p.purchase_id,payment);
  p=await this.recover(p);
  return {accepted:true,purchase_id:p.purchase_id,status:p.status};
 }
 async unlock(userId:string,code:string,mediaId:string,input:{client_message_id:string;provider?:string}){
  await this.consent(userId);
  const offer=await this.repository.getOffer(userId,code,mediaId);
  if(!offer)throw new WebError(404,'media_offer_not_found');
  const quote=await this.quote(userId,{chat_code:code,sku:offer.sku,media_id:mediaId});
  const free=await this.repository.unlockFree(userId,code,mediaId,quote);
  if(free.unlocked)return free;
  if(!input.provider)throw new WebError(402,'payment_required');
  return this.purchase(userId,{client_message_id:input.client_message_id,chat_code:code,sku:offer.sku,media_id:mediaId,provider:input.provider});
 }
 /** Server-only producer. Existing Media Commerce decides eligibility and pricing first. */
 async prepareOffer(userId:string,code:string,input:{media_id:string;sku:string;media_signature:string;scene_session_id?:string;debounce_revision?:number}){
  const context=await this.repository.getContext(userId,code);
  const plan=(await this.plans(userId,context.chat_id)).find(x=>x.sku===input.sku&&x.kind==='photo');
  if(!plan)throw new WebError(404,'product_not_found');
  const decision=await this.decisions.evaluate({interaction_mode:'prepare_offer',source:'web',chat_id:context.chat_id,scene_session_id:context.scene_session_id,turn_no:Math.max(0,context.turn_no),scene_turn_no:Math.max(0,context.scene_turn_no??0),media_signature:input.media_signature,photo_sku:input.sku,base_price_xtr:plan.amount_xtr,should_offer:true});
  if(!decision.has_media_offer)return {offered:false};
  const offer=await this.repository.recordOffer(userId,code,{...input,scene_session_id:input.scene_session_id??context.scene_session_id,turn_no:context.turn_no,scene_turn_no:context.scene_turn_no,price:decision.price_required===0?{amount:'0',currency:'RUB'}:plan.amount_rub==null?null:{amount:String(plan.amount_rub),currency:'RUB'},price_required:decision.price_required??0});
  return {offered:true,media_id:offer.media_id,media_kind:'photo',price_required:decision.price_required};
 }
}
