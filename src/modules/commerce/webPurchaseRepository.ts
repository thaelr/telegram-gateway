import { createHash, randomUUID } from 'node:crypto';
import {sql,queryRows as r,toIsoTimestamp as iso} from '../../db.js';
import {loadSceneAccessStatus,loadFreeCredits,activateSubscription,activateSceneAccess} from '../access/accessRepository.js';
import {MediaEventRepository} from '../media/mediaEventRepository.js';
import { compareDecimals, normalizeDecimal, type ProviderCheckout, type ProviderPayment } from '../../payments/providers.js';
import {WebError} from '../../web/types.js';
import type {WebCommerceContext,WebCommerceQuote,WebPurchase,WebMediaOffer} from '../../web/commerceTypes.js';
export type {WebCommerceContext,WebCommerceQuote,WebPurchase,WebMediaOffer,Purchase} from '../../web/commerceTypes.js';
import {loadWebCommerceContext} from '../chats/webCommerceContext.js';
import {getEntitlements,redeemFreeFeature,unlockFree,isUnlocked} from '../access/webEntitlements.js';
import {recordOffer,getOffer,getOffers,gallery} from '../media/webMediaRepository.js';
type DB=Pick<typeof sql,'unsafe'>;
import { WebVideoAccess } from '../media/webVideoAccess.js';
import { VideoCommerceRepository } from '../media/videoRepository.js';
import { resolveVideoPassPlan } from '../products/plans.js';
import { config } from '../../config.js';
import {WebPhotoPanels} from '../media/webPhotoPanels.js';

type Row = Record<string,any>;
const asPurchase = (row:Row):WebPurchase => ({
 ...row,chat_id:row.chat_id==null?null:Number(row.chat_id),created_at:iso(row.created_at)!,updated_at:iso(row.updated_at)!,
 expires_at:iso(row.expires_at),external_id:row.external_kind==='invoice'?row.external_invoice_id:row.external_payment_id,
} as WebPurchase);

export class WebCommerceRepository {
 readonly videos: WebVideoAccess;
 readonly photoPanels:WebPhotoPanels;
  readonly getEntitlements: (userId:string)=>ReturnType<typeof getEntitlements>;
 readonly redeemFreeFeature: (userId:string,quote:WebCommerceQuote,clientId:string)=>ReturnType<typeof redeemFreeFeature>;
 readonly unlockFree: (userId:string,code:string,mediaId:string,quote:WebCommerceQuote)=>ReturnType<typeof unlockFree>;
 readonly recordOffer: (userId:string,code:string,offer:{media_id:string;sku:string;media_signature:string;panel_id?:number;scene_session_id?:string|null;turn_no?:number;scene_turn_no?:number|null;price?:{amount:string;currency:string}|null;price_required?:number;debounce_revision?:number})=>ReturnType<typeof recordOffer>;
 readonly getOffer: (userId:string,code:string,mediaId:string)=>ReturnType<typeof getOffer>;
 readonly getOffers: (userId:string,code:string,mediaIds:string[])=>ReturnType<typeof getOffers>;
 readonly gallery: (userId:string,code:string)=>ReturnType<typeof gallery>;
 constructor(private readonly query:typeof sql=sql,videos?:WebVideoAccess){this.videos=videos??new WebVideoAccess(query);this.photoPanels=new WebPhotoPanels(query);
  this.getEntitlements=getEntitlements.bind(null,query);
  this.redeemFreeFeature=redeemFreeFeature.bind(null,query);
  this.unlockFree=unlockFree.bind(null,query);
  this.recordOffer=recordOffer.bind(null,query);
  this.getOffer=getOffer.bind(null,query);
  this.getOffers=getOffers.bind(null,query);
  this.gallery=gallery.bind(null,query,this.videos);
 }
 private async lockPurchaseChat(db:DB,id:string){
  // Telegram's existing shared ledger locks chat first. Account-only invoices
  // have no chat row; both paths serialize entitlement updates on their owner.
  await r(db,"SELECT c.chat_id FROM public.chat_state c JOIN app_private.web_purchases p ON p.chat_id=c.chat_id WHERE p.purchase_id=$1::uuid FOR UPDATE OF c",[id]);
  await r(db,"SELECT u.user_id FROM public.users u JOIN app_private.web_purchases p ON p.user_id=u.user_id WHERE p.purchase_id=$1::uuid FOR UPDATE OF u",[id]);
 }
 private async recoverCreationLeases(userId?:string,id?:string){
  const expired=await r(this.query,"SELECT purchase_id FROM app_private.web_purchases WHERE status='creating' AND creation_started_at<clock_timestamp()-interval '2 minutes' AND ($1::text IS NULL OR user_id=$1) AND ($2::uuid IS NULL OR purchase_id=$2::uuid) ORDER BY chat_id,purchase_id LIMIT 100",[userId??null,id??null]);
  for(const p of expired)await this.query.begin(async tx=>{await this.lockPurchaseChat(tx,p.purchase_id);await r(tx,"UPDATE app_private.web_purchases SET status='creation_uncertain',error_code='creation_lease_expired',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid AND status='creating' AND creation_started_at<clock_timestamp()-interval '2 minutes'",[p.purchase_id]);});
 }
 async getContext(userId:string,code:string){return loadWebCommerceContext(this.query,userId,code);}
 async getOwned(userId:string,id:string):Promise<WebPurchase>{await this.recoverCreationLeases(userId,id);const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND purchase_id=$2::uuid",[userId,id]))[0];if(!row)throw new WebError(404,'purchase_not_found');return asPurchase(row);}
 async getById(id:string):Promise<WebPurchase|null>{const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid",[id]))[0];return row?asPurchase(row):null;}
 async pendingFulfillments(limit=50):Promise<WebPurchase[]>{await this.recoverCreationLeases();return (await r(this.query,"SELECT * FROM app_private.web_purchases WHERE status IN ('paid','fulfillment_pending') AND COALESCE(error_code,'') NOT IN ('duplicate_payment_requires_review','paid_scene_requires_review') ORDER BY updated_at LIMIT $1",[Math.min(100,Math.max(1,limit))])).map(asPurchase);}
 async findByClient(userId:string,clientId:string):Promise<WebPurchase|null>{const row=(await r(this.query,"SELECT p.* FROM app_private.web_purchases p JOIN public.interaction_tokens t ON t.token=p.payment_token WHERE p.user_id=$1 AND (p.client_id=$2 OR t.payload_json->'web_client_ids' ? $2)",[userId,clientId]))[0];return row?(row.status==='creating'?this.getOwned(userId,row.purchase_id):asPurchase(row)):null;}
 async getByProviderExternal(provider:string,id:string):Promise<WebPurchase|null>{const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE provider=$1 AND (external_payment_id=$2 OR external_invoice_id=$2)",[provider,id]))[0];return row?asPurchase(row):null;}

 async createOrGet(userId:string,clientId:string,fingerprint:string,quote:WebCommerceQuote,provider:string):Promise<{purchase:WebPurchase;created:boolean}>{
  return this.query.begin(async tx=>{
   await r(tx,"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['web-purchase:'+userId+':'+clientId]);
   const old=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND client_id=$2",[userId,clientId]))[0];
   if(old){if(old.fingerprint!==fingerprint||old.provider!==provider)throw new WebError(409,'idempotency_conflict');return {purchase:asPurchase(old),created:false};}
   const current=quote.chat_code?await loadWebCommerceContext(tx,userId,quote.chat_code,true):null;
   await r(tx,"SELECT user_id FROM public.users WHERE user_id=$1 FOR UPDATE",[userId]);
   if(!(await r(tx,"SELECT 1 FROM public.user_identities WHERE user_id=$1 AND provider='supabase'",[userId])).length)throw new WebError(401,'account_not_found');
   // Recheck durable aliases after the owner lock: another tab may have
   // attached this client ID and fulfilled the checkout while this call waited.
   const alias=(await r(tx,"SELECT p.* FROM app_private.web_purchases p JOIN public.interaction_tokens t ON t.token=p.payment_token WHERE p.user_id=$1 AND (p.client_id=$2 OR t.payload_json->'web_client_ids' ? $2)",[userId,clientId]))[0];
   if(alias){if(alias.fingerprint!==fingerprint||alias.provider!==provider)throw new WebError(409,'idempotency_conflict');return {purchase:asPurchase(alias),created:false};}
   // Another tab may have created the same checkout while this one waited.
   const same=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND fingerprint=$2 AND provider=$3 AND status IN ('created','creating','creation_uncertain','pending','paid','fulfillment_pending') ORDER BY created_at LIMIT 1 FOR UPDATE",[userId,fingerprint,provider]))[0];
   if(same){
    await r(tx,"UPDATE public.interaction_tokens SET payload_json=jsonb_set(payload_json,'{web_client_ids}',COALESCE(payload_json->'web_client_ids',jsonb_build_array($2::text))||jsonb_build_array($3::text),true) WHERE token=$1 AND NOT COALESCE(payload_json->'web_client_ids' ? $3,false)",[same.payment_token,same.client_id,clientId]);
    return {purchase:asPurchase(same),created:false};
   }
   if(quote.kind!=='subscription'&&!current)throw new WebError(400,'chat_required');
   if(current&&(current.chat_id!==quote.chat_id||(quote.kind!=='subscription'&&current.scene_session_id!==quote.scene_session_id)))throw new WebError(409,'stale_scene');
   const [account]=await r(tx,"SELECT age_confirmed_at,terms_accepted_at FROM public.users WHERE user_id=$1",[userId]);
   if(!account?.age_confirmed_at||!account?.terms_accepted_at)throw new WebError(403,'consent_required');
   if(quote.kind==='feature'&&current){
    
    const state=await loadSceneAccessStatus(tx as unknown as typeof sql,{chat_id:current.chat_id,scene_session_id:current.scene_session_id});
    const credits=await loadFreeCredits(tx as unknown as typeof sql,current.chat_id);
    if(quote.feature_key==='scene_unlock'&&(state?.subscription_active||state?.scene_access_active))throw new WebError(409,'feature_already_available');
    if((quote.feature_key==='scene_unlock'&&(credits?.free_scene_unlocks??0)>0)||(quote.feature_key==='fast_scene_skip'&&(credits?.free_fast_scene_skips??0)>0))throw new WebError(409,'free_feature_available');
    if(quote.feature_key==='fast_scene_skip'&&current.scene_mode!=='fast')throw new WebError(409,'feature_not_available');
    if(quote.feature_key==='video_unlock'||quote.feature_key==='video_pass'){
     const ctx=await this.videos.context({...current,media_signature:quote.media_signature??'',panel_id:quote.panel_id??0,media_id:quote.requested_photo_uuid??quote.media_id??''},tx);
     if(!ctx.scene_active)throw new WebError(409,'stale_scene');
     if(ctx.full_active||ctx.video_pass_active)throw new WebError(409,'video_already_available');
     if(quote.video_id&&(!ctx.video||ctx.video.video_id!==quote.video_id||ctx.panel_delivered||ctx.delivery))throw new WebError(409,'stale_video_offer');
     if(quote.feature_key==='video_pass'){
      const offer=await new VideoCommerceRepository(tx as unknown as typeof sql).passOfferContext(current.chat_id,current.scene_session_id,'web');
      if(offer.user_id!==userId || offer.scene_session_id!==quote.scene_session_id || (!quote.video_id&&!offer.available) ||
        offer.video_pass_active || offer.full_active)throw new WebError(409,'stale_video_offer');
      const prices=resolveVideoPassPlan(offer.paid_scene_unlock_token);
      if(!prices || prices.purchase_variant!==quote.payload?.purchase_variant || prices.paid_scene_unlock_token!==quote.payload?.paid_scene_unlock_token ||
        prices.amount_rub!==Number(quote.amount) || prices.amount_xtr!==quote.amount_xtr ||
        prices.original_amount_rub!==quote.payload?.original_amount || prices.discount_percent!==quote.payload?.discount_percent)throw new WebError(409,'stale_video_offer');
     }
    }
   }
   if(quote.kind==='photo'&&quote.media_id&&await isUnlocked(tx,userId,quote.media_id))throw new WebError(409,'media_already_unlocked');
   const amount=normalizeDecimal(quote.amount);
   if(amount.includes('.')||Number(amount)>2147483647||compareDecimals(amount,'0')<=0)throw new WebError(400,'invalid_order_amount');
   const id=randomUUID(),token='web_inv_'+randomUUID();
   const action=quote.kind==='subscription'?'subscription_payment':quote.kind==='photo'?'photo_payment':'feature_payment';
   const payload={...(quote.payload??{}),source:'web',user_id:userId,purchase_id:id,web_client_ids:[clientId],idempotency_key:id,chat_id:quote.chat_id,scene_session_id:quote.scene_session_id,turn_no:quote.turn_no,scene_turn_no:quote.scene_turn_no,character_i:quote.character_i,scene_mode:quote.scene_mode,subscription_days:quote.subscription_days??null,subscription_sku:quote.kind==='subscription'?quote.sku:null,feature_key:quote.feature_key??null,media_signature:quote.media_signature??null,target_message_id:quote.panel_id??null,photo_message_id:quote.panel_id??null,photo_uuid:quote.media_id??null,requested_photo_uuid:quote.requested_photo_uuid??null,source_photo_uuid:quote.source_photo_uuid??null,video_id:quote.video_id??null,photo_sku:quote.kind==='photo'?quote.sku:null};
   if(quote.chat_id==null){
    if(quote.kind!=='subscription')throw new WebError(400,'chat_required');
    await r(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,payload_json,action_kind,sku,payment_source,amount,currency,amount_xtr,invoice_title,invoice_description,invoice_label,invoice_button_text) VALUES($1,'invoice_payload',NULL,$2::text::jsonb,'subscription_payment',$3,$4,$5::integer,$6,$7::integer,$8,$9,$8,$8)",[token,JSON.stringify(payload),quote.sku,provider,amount,quote.currency.toUpperCase(),quote.amount_xtr,quote.title,quote.description]);
   }else await r(tx,"SELECT * FROM public.media_upsert_invoice_token($1,'invoice_payload',$2,$3,$4,$5::smallint,$6::text::jsonb,$7,$8,$9,$10::integer,$11,$12::integer,NULL,NULL,NULL,NULL,$13,$14,$13,$13)",[token,quote.chat_id,quote.scene_session_id,quote.turn_no,quote.scene_turn_no,JSON.stringify(payload),action,quote.sku,provider,amount,quote.currency.toUpperCase(),quote.amount_xtr,quote.title,quote.description]);
   const row=(await r(tx,"INSERT INTO app_private.web_purchases(purchase_id,user_id,chat_id,client_id,fingerprint,provider,payment_token,quote) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::text::jsonb) RETURNING *",[id,userId,quote.chat_id,clientId,fingerprint,provider,token,JSON.stringify({...quote,amount,currency:quote.currency.toUpperCase()})]))[0]!;
   return {purchase:asPurchase(row),created:true};
  });
 }

 async claimCreation(id:string):Promise<boolean>{
  return this.query.begin(async tx=>{
   await this.lockPurchaseChat(tx,id);
   await r(tx,"UPDATE app_private.web_purchases SET status='creation_uncertain',error_code='creation_lease_expired',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid AND status='creating' AND creation_started_at<clock_timestamp()-interval '2 minutes'",[id]);
   return (await r(tx,"UPDATE app_private.web_purchases SET status='creating',creation_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE purchase_id=$1::uuid AND status='created' RETURNING purchase_id",[id])).length===1;
  });
 }
 async bindCheckout(id:string,checkout:ProviderCheckout):Promise<void>{
  await this.query.begin(async tx=>{
   await this.lockPurchaseChat(tx,id);
   const p=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid FOR UPDATE",[id]))[0];if(!p)throw new WebError(404,'purchase_not_found');
   const existing=checkout.external_kind==='invoice'?p.external_invoice_id:p.external_payment_id;
   if(existing&&existing!==checkout.external_id)throw new WebError(409,'provider_binding_conflict');
   await r(tx,"UPDATE app_private.web_purchases SET external_kind=$2,external_invoice_id=CASE WHEN $2='invoice' THEN $3 ELSE external_invoice_id END,external_payment_id=CASE WHEN $2='payment' THEN $3 ELSE external_payment_id END,checkout_url=$4,expires_at=$5::timestamptz,status=CASE WHEN status IN ('created','creating','creation_uncertain') THEN 'pending' ELSE status END,error_code=NULL,updated_at=clock_timestamp() WHERE purchase_id=$1::uuid",[id,checkout.external_kind,checkout.external_id,checkout.checkout_url,checkout.expires_at]);
   await r(tx,"UPDATE public.interaction_tokens SET checkout_url=$2,external_payment_id=CASE WHEN $3='payment' THEN $4 ELSE external_payment_id END,expires_at=$5::timestamptz WHERE token=$1",[p.payment_token,checkout.checkout_url,checkout.external_kind,checkout.external_id,checkout.expires_at]);
  });
 }
 async markCreationFailure(id:string,ambiguous:boolean,code:string):Promise<void>{await this.query.begin(async tx=>{await this.lockPurchaseChat(tx,id);await r(tx,"UPDATE app_private.web_purchases SET status=$2,error_code=$3,updated_at=clock_timestamp() WHERE purchase_id=$1::uuid AND status='creating'",[id,ambiguous?'creation_uncertain':'failed',code]);});}

 async confirmVerified(id:string,payment:ProviderPayment):Promise<WebPurchase>{
  return this.query.begin(async tx=>{
   await this.lockPurchaseChat(tx,id);
   const p=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid FOR UPDATE",[id]))[0];if(!p)throw new WebError(404,'purchase_not_found');
   const quote=p.quote as WebCommerceQuote;
   if(payment.provider!==p.provider||payment.order_id!==id||payment.price_currency.toUpperCase()!==quote.currency.toUpperCase()||compareDecimals(payment.price_amount,quote.amount)!==0)throw new WebError(409,'provider_order_mismatch');
   if(!payment.external_payment_id||(p.external_payment_id&&p.external_payment_id!==payment.external_payment_id)||(p.external_invoice_id&&p.external_invoice_id!==payment.external_invoice_id))throw new WebError(409,'provider_binding_conflict');
   if(payment.status==='paid'&&(payment.pay_amount==null||payment.paid_amount==null||compareDecimals(payment.pay_amount,'0')<=0||compareDecimals(payment.paid_amount,payment.pay_amount)<0))throw new WebError(409,'insufficient_provider_payment');
   await r(tx,"UPDATE app_private.web_purchases SET external_payment_id=$2,external_invoice_id=COALESCE(external_invoice_id,$3),external_kind=COALESCE(external_kind,CASE WHEN $3::text IS NULL THEN 'payment' ELSE 'invoice' END),provider_data=$4::text::jsonb,updated_at=clock_timestamp() WHERE purchase_id=$1::uuid",[id,payment.external_payment_id,payment.external_invoice_id,JSON.stringify(payment)]);
   await r(tx,"UPDATE public.interaction_tokens SET external_payment_id=$2 WHERE token=$1 AND (external_payment_id IS NULL OR external_payment_id=$2)",[p.payment_token,payment.external_payment_id]);
   if(payment.status==='paid'){
    const action=quote.kind==='subscription'?'subscription_payment':quote.kind==='photo'?'photo_payment':'feature_payment';
    if(p.chat_id==null){
     if(quote.kind!=='subscription')throw new WebError(409,'invalid_subscription_snapshot');
     await r(tx,"UPDATE public.interaction_tokens SET status=CASE WHEN status='fulfilled' THEN status ELSE 'paid' END WHERE token=$1 AND kind='invoice_payload' AND action_kind='subscription_payment' AND payload_json->>'user_id'=$2 AND payload_json->>'purchase_id'=$3 AND payment_source=$4 AND amount=$5::integer AND currency=$6",[p.payment_token,p.user_id,id,p.provider,quote.amount,quote.currency]);
    }else await r(tx,"SELECT * FROM public.media_mark_invoice_paid($1,$2,'invoice_payload',$3,$4,NULL,NULL,$5,$6,$7::integer,NULL)",[p.payment_token,p.chat_id,action,p.provider,payment.external_payment_id,quote.currency,quote.amount]);
    const token=(await r(tx,"SELECT status FROM public.interaction_tokens WHERE token=$1",[p.payment_token]))[0];
    if(!token||!['paid','fulfilled'].includes(token.status))throw new WebError(409,'payment_confirmation_conflict');
    await r(tx,"UPDATE app_private.web_purchases SET status=CASE WHEN status='fulfilled' THEN status ELSE 'paid' END,error_code=NULL WHERE purchase_id=$1::uuid",[id]);
   }else{
    const status=payment.status==='expired'?'expired':['failed','refunded'].includes(payment.status)?'failed':'pending';
    await r(tx,"UPDATE app_private.web_purchases SET status=CASE WHEN status IN ('paid','fulfillment_pending','fulfilled') THEN status ELSE $2 END,error_code=CASE WHEN $3='refunded' THEN 'provider_refunded' ELSE error_code END WHERE purchase_id=$1::uuid",[id,status,payment.status]);
   }
   return asPurchase((await r(tx,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid",[id]))[0]!);
  });
 }

 async fulfill(id:string):Promise<WebPurchase>{
  return this.query.begin(async tx=>{
   await this.lockPurchaseChat(tx,id);
   const p=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid FOR UPDATE",[id]))[0];if(!p)throw new WebError(404,'purchase_not_found');
   if(p.status==='fulfilled'||!['paid','fulfillment_pending'].includes(p.status))return asPurchase(p);
   const q=p.quote as WebCommerceQuote;
   
   await r(tx,"SELECT 1 FROM public.chat_state WHERE chat_id=$1 AND user_id=$2 FOR UPDATE",[p.chat_id,p.user_id]);
   await r(tx,"SELECT set_config('app_private.media_source','web',true)");
   if(q.kind==='subscription'){
    if(!q.subscription_days||q.subscription_days<=0)throw new WebError(409,'invalid_subscription_snapshot');
    if(q.payload?.account_subscription===true||p.chat_id==null){await r(tx,'SELECT app_private.web_activate_account_subscription($1::uuid)',[id]);}
    else if(q.payload?.subscription_tier==='full')await r(tx,'SELECT public.media_activate_full_subscription($1,$2,$3,$4::integer,$5)',[p.payment_token,p.chat_id,q.sku,q.subscription_days,q.payload.subscription_change??'renew']);
    else await activateSubscription(tx as unknown as typeof sql,{payment_token:p.payment_token,chat_id:Number(p.chat_id),subscription_sku:q.sku,subscription_days:q.subscription_days});
   }else if(q.kind==='feature'&&(q.feature_key==='video_unlock'||q.feature_key==='video_pass')){
    if(q.feature_key==='video_pass'){
     const [grant]=await r(tx,'SELECT public.media_activate_video_pass($1,$2) AS activated',[p.payment_token,p.chat_id]);
     if(!Number(grant?.activated))return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status='fulfillment_pending',error_code='paid_scene_requires_review',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id]))[0]!);
    }
    if(q.video_id){
     const prepare=(db:DB)=>this.videos.prepare({request_key:'paid:'+p.payment_token,payment_token:p.payment_token,chat_id:Number(p.chat_id)},db);
     // Keep a paid scene open when preparing the optional video fails. Recovery
     // retries this immutable snapshot and the existing delivery request key.
     const delivery=q.feature_key==='video_pass'
       ? await tx.savepoint(nested=>prepare(nested)).catch(()=>null)
       : await prepare(tx);
     if(!delivery)return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status='fulfillment_pending',error_code='video_delivery_pending',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id]))[0]!);
     if(delivery.status==='duplicate_payment_requires_review'){
      return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status='fulfillment_pending',error_code='duplicate_payment_requires_review',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id]))[0]!);
     }
     q.payload={...(q.payload??{}),video_delivery_id:delivery.delivery_id};
     await r(tx,'UPDATE app_private.web_purchases SET quote=$2::text::jsonb WHERE purchase_id=$1::uuid',[id,JSON.stringify(q)]);
    }else if(q.feature_key==='video_unlock')throw new WebError(409,'missing_video_snapshot');
   }else if(q.kind==='feature'&&q.feature_key==='scene_unlock'){
    if(!q.scene_session_id)throw new WebError(409,'missing_scene');
    const grant=await activateSceneAccess(tx as unknown as typeof sql,{payment_token:p.payment_token,chat_id:Number(p.chat_id),scene_session_id:q.scene_session_id,scene_access_sku:q.sku});
    if(!grant)return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status='fulfillment_pending',error_code='paid_scene_requires_review',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id]))[0]!);
   }else if(q.kind==='photo'){
    if(!q.media_id||!q.media_signature||!q.panel_id)throw new WebError(409,'missing_media_snapshot');
    await new MediaEventRepository(tx as unknown as typeof sql).storePhotoEvent({chat_id:Number(p.chat_id),scene_session_id:q.scene_session_id,turn_no:q.turn_no,scene_turn_no:q.scene_turn_no,event_type:'media.photo.unlocked.paid',media_signature:q.media_signature,uuid:q.media_id,panel_message_id:q.panel_id,price_xtr:q.amount_xtr??0,access_mode:'paid',action_kind:'photo_request',fulfillment_invoice_token:p.payment_token,next_invoice_token:null,next_invoice_link:null,price_required:0});
   }else if(q.kind==='feature'&&q.feature_key==='fast_scene_skip'){
    const eventId=p.purchase_id;
    const data={client_message_id:'commerce:'+id,entry_mode:'fast_scene_skip',payment_token:p.payment_token,feature_key:'fast_scene_skip'};
    const envelope={event_id:eventId,user_id:p.user_id,chat_id:Number(p.chat_id),character_i:q.character_i,scene_mode:q.scene_mode??'fast',source:'web',action:'reset',data};
    await r(tx,"INSERT INTO app_private.web_operations(event_id,user_id,chat_id,client_message_id,action,fingerprint,envelope) VALUES($1::uuid,$2,$3,$4,'reset',$5,$6::text::jsonb) ON CONFLICT(chat_id,client_message_id) DO NOTHING",[eventId,p.user_id,p.chat_id,'commerce:'+id,createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),JSON.stringify(envelope)]);
   }else throw new WebError(409,'unsupported_fulfillment');
   const token=(await r(tx,"SELECT status FROM public.interaction_tokens WHERE token=$1",[p.payment_token]))[0];
   const status=token?.status==='fulfilled'?'fulfilled':'fulfillment_pending';
   return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status=$2,error_code=CASE WHEN error_code='video_delivery_pending' THEN NULL ELSE error_code END,updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id,status]))[0]!);
  });
 }
}
