import { MediaCommerceDecisionService } from '../application/mediaCommerceDecision.js';
import {PaymentProviderRegistry} from '../payments/providers.js';
import {buildWebQuote,recoverPending,notification,purchase,status,type PurchaseInput} from '../modules/commerce/webPurchases.js';
export type {PurchaseInput} from '../modules/commerce/webPurchases.js';
import {eligibleWebUpgrade} from '../modules/access/webUpgradeEligibility.js';
import {requestVideo} from '../modules/media/webMediaActions.js';
import {publicPurchase} from './commercePresentation.js';
import { WebCommerceRepository, type WebCommerceQuote, type WebPurchase } from '../modules/commerce/webPurchaseRepository.js';
import type { WebRepositoryContract } from './types.js';
import { WebError } from './types.js';
import { config } from '../config.js';
import type { WebProductPlan } from './commerceTypes.js';
import type { LocalizationService } from '../localization.js';
import type {WebPhotoPanelAction} from '../modules/media/webPhotoPanels.js';

export class WebCommerceService {
 private timer:ReturnType<typeof setTimeout>|null=null;
 private recovering:Promise<void>|null=null;
 private stopped=true;
  private readonly quote: (userId:string,input:{chat_code?:string;sku:string;media_id?:string;subscription_change?:'upgrade'|'renew'})=>ReturnType<typeof buildWebQuote>;
 readonly recoverPending: ()=>ReturnType<typeof recoverPending>;
 readonly notification: (providerId:string,raw:string,signature:string|undefined)=>ReturnType<typeof notification>;
 readonly purchase: (userId:string,input:PurchaseInput)=>ReturnType<typeof purchase>;
 readonly status: (userId:string,id:string)=>ReturnType<typeof status>;
 readonly requestVideo: (userId:string,code:string,mediaId:string,clientId:string)=>ReturnType<typeof requestVideo>;
 readonly publicPurchase=publicPurchase;
 constructor(readonly repository:WebCommerceRepository, readonly providers:PaymentProviderRegistry, readonly decisions:MediaCommerceDecisionService, readonly accounts:WebRepositoryContract, readonly localization:(Pick<LocalizationService,'getNamespace'|'getTelegramCopy'|'getPaymentMethods'>&Partial<Pick<LocalizationService,'getExactNamespace'>>)|null=null) {
  this.quote=buildWebQuote.bind(null,repository,this.plans.bind(this));
  this.recoverPending=recoverPending.bind(null,repository);
  this.notification=notification.bind(null,repository,providers);
  this.purchase=purchase.bind(null,repository,providers,this.consent.bind(this),this.plans.bind(this),this.allowedProviders.bind(this),publicPurchase);
  this.status=status.bind(null,repository,providers,publicPurchase);
  this.requestVideo=requestVideo.bind(null,repository,this.consent.bind(this));
 }
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
   const copy=plan.feature_key==='video_pass'||plan.feature_key==='scene_unlock' ? object(semantic) : {...object(semantic),...object(specific)};
   const localized=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?value.replaceAll('{days}',String(plan.duration_days??plan.subscription_days??'')):fallback;
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
   const upgrade=p.subscription_tier==='full'?eligibleWebUpgrade(p,rights):null;
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
 async videoAccess(userId:string,id:string){
  await this.consent(userId);
  return this.repository.videos.access(userId,id);
 }
 start(){if(!this.stopped)return;this.stopped=false;const loop=()=>{if(this.stopped)return;this.recovering=this.recoverPending().catch(()=>undefined).finally(()=>{this.recovering=null;if(!this.stopped){this.timer=setTimeout(loop,5000);this.timer.unref();}});};loop();}
 async stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.recovering;}
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
