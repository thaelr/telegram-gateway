import { createHash, randomUUID } from 'node:crypto';
import { sql } from '../db.js';
import { MediaCommerceRepository } from '../mediaCommerceRepository.js';
import { calculateMediaPriceRequired } from '../mediaCommerce/mediaAction.js';
import { compareDecimals, normalizeDecimal, type ProviderCheckout, type ProviderPayment } from '../payments/providers.js';
import { WebError, type SceneMode } from './types.js';

export type WebCommerceContext = {
 chat_id:number; chat_code:string; character_i:number; scene_session_id:string|null;
 turn_no:number; scene_turn_no:number|null; scene_mode:SceneMode|null; debounce_revision?:number;
};
export type WebCommerceQuote = WebCommerceContext & {
 sku:string; title:string; description:string; kind:'subscription'|'photo'|'feature';
 amount:string; currency:string; amount_xtr:number|null; subscription_days?:number;
 feature_key?:string; media_id?:string; media_signature?:string; panel_id?:number;
 price_required?:number; payload?:Record<string,unknown>;
};
export type WebPurchase = {
 purchase_id:string; user_id:string; chat_id:number; client_id:string; fingerprint:string;
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
type DB = Pick<typeof sql,'unsafe'>;
type Row = Record<string,any>;
const r = async (db:DB,text:string,params:any[]=[]):Promise<Row[]> => db.unsafe(text,params);
const iso = (value:unknown) => value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const asPurchase = (row:Row):WebPurchase => ({
 ...row,chat_id:Number(row.chat_id),created_at:iso(row.created_at)!,updated_at:iso(row.updated_at)!,
 expires_at:iso(row.expires_at),external_id:row.external_kind==='invoice'?row.external_invoice_id:row.external_payment_id,
} as WebPurchase);
const contextQuery="SELECT c.chat_id,c.chat_code,c.character_i,c.active_scene_session_id AS scene_session_id,c.current_turn_no AS turn_no,c.scene_turn_no,c.debounce_revision,s.scene_mode FROM public.chat_state c LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id WHERE c.user_id=$1 AND c.chat_code=$2 AND c.character_i IS NOT NULL AND c.is_active";
const photoEvents=['media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass'];

export class WebCommerceRepository {
 constructor(private readonly query:typeof sql=sql){}
 private async lockPurchaseChat(db:DB,id:string){await r(db,"SELECT c.chat_id FROM public.chat_state c JOIN app_private.web_purchases p ON p.chat_id=c.chat_id WHERE p.purchase_id=$1::uuid FOR UPDATE OF c",[id]);}
 private async recoverCreationLeases(){
  const expired=await r(this.query,"SELECT purchase_id FROM app_private.web_purchases WHERE status='creating' AND creation_started_at<clock_timestamp()-interval '2 minutes' ORDER BY chat_id,purchase_id LIMIT 100");
  for(const p of expired)await this.query.begin(async tx=>{await this.lockPurchaseChat(tx,p.purchase_id);await r(tx,"UPDATE app_private.web_purchases SET status='creation_uncertain',error_code='creation_lease_expired',updated_at=clock_timestamp() WHERE purchase_id=$1::uuid AND status='creating' AND creation_started_at<clock_timestamp()-interval '2 minutes'",[p.purchase_id]);});
 }
 private async context(db:DB,userId:string,code:string,lock=false):Promise<WebCommerceContext>{
  const row=(await r(db,contextQuery+(lock?' FOR UPDATE OF c':''),[userId,code]))[0];
  if(!row)throw new WebError(404,'chat_not_found');
  return {...row,chat_id:Number(row.chat_id),character_i:Number(row.character_i),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no)} as WebCommerceContext;
 }
 async getContext(userId:string,code:string){return this.context(this.query,userId,code);}
 async getOwned(userId:string,id:string):Promise<WebPurchase>{await this.recoverCreationLeases();const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND purchase_id=$2::uuid",[userId,id]))[0];if(!row)throw new WebError(404,'purchase_not_found');return asPurchase(row);}
 async getById(id:string):Promise<WebPurchase|null>{const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE purchase_id=$1::uuid",[id]))[0];return row?asPurchase(row):null;}
 async pendingFulfillments(limit=50):Promise<WebPurchase[]>{await this.recoverCreationLeases();return (await r(this.query,"SELECT * FROM app_private.web_purchases WHERE status IN ('paid','fulfillment_pending') ORDER BY updated_at LIMIT $1",[Math.min(100,Math.max(1,limit))])).map(asPurchase);}
 async findByClient(userId:string,clientId:string):Promise<WebPurchase|null>{await this.recoverCreationLeases();const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND client_id=$2",[userId,clientId]))[0];return row?asPurchase(row):null;}
 async getByProviderExternal(provider:string,id:string):Promise<WebPurchase|null>{const row=(await r(this.query,"SELECT * FROM app_private.web_purchases WHERE provider=$1 AND (external_payment_id=$2 OR external_invoice_id=$2)",[provider,id]))[0];return row?asPurchase(row):null;}
 async getEntitlements(userId:string){const row=(await r(this.query,"SELECT subscription_sku,subscription_until,entitlements_jsonb AS balances FROM public.users WHERE user_id=$1",[userId]))[0];if(!row)throw new WebError(401,'account_not_found');return {...row,subscription_until:iso(row.subscription_until)};}

 async createOrGet(userId:string,clientId:string,fingerprint:string,quote:WebCommerceQuote,provider:string):Promise<{purchase:WebPurchase;created:boolean}>{
  return this.query.begin(async tx=>{
   await r(tx,"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['web-purchase:'+userId+':'+clientId]);
   const old=(await r(tx,"SELECT * FROM app_private.web_purchases WHERE user_id=$1 AND client_id=$2",[userId,clientId]))[0];
   if(old){if(old.fingerprint!==fingerprint||old.provider!==provider)throw new WebError(409,'idempotency_conflict');return {purchase:asPurchase(old),created:false};}
   const current=await this.context(tx,userId,quote.chat_code,true);
   if(current.chat_id!==quote.chat_id||((quote.kind!=='subscription')&&current.scene_session_id!==quote.scene_session_id))throw new WebError(409,'stale_scene');
   const [account]=await r(tx,"SELECT age_confirmed_at,terms_accepted_at FROM public.users WHERE user_id=$1",[userId]);
   if(!account?.age_confirmed_at||!account?.terms_accepted_at)throw new WebError(403,'consent_required');
   if(quote.kind==='feature'){
    const common=new MediaCommerceRepository(tx as unknown as typeof sql);
    const state=await common.loadSceneAccessStatus({chat_id:current.chat_id,scene_session_id:current.scene_session_id});
    const credits=await common.loadFreeCredits(current.chat_id);
    if(quote.feature_key==='scene_unlock'&&(state?.subscription_active||state?.scene_access_active))throw new WebError(409,'feature_already_available');
    if((quote.feature_key==='scene_unlock'&&(credits?.free_scene_unlocks??0)>0)||(quote.feature_key==='fast_scene_skip'&&(credits?.free_fast_scene_skips??0)>0))throw new WebError(409,'free_feature_available');
    if(quote.feature_key==='fast_scene_skip'&&current.scene_mode!=='fast')throw new WebError(409,'feature_not_available');
   }
   if(quote.kind==='photo'&&quote.media_id&&await this.isUnlocked(tx,userId,quote.media_id))throw new WebError(409,'media_already_unlocked');
   const amount=normalizeDecimal(quote.amount);
   if(amount.includes('.')||Number(amount)>2147483647||compareDecimals(amount,'0')<=0)throw new WebError(400,'invalid_order_amount');
   const id=randomUUID(),token='web_inv_'+randomUUID();
   const action=quote.kind==='subscription'?'subscription_payment':quote.kind==='photo'?'photo_payment':'feature_payment';
   const payload={...(quote.payload??{}),source:'web',idempotency_key:id,chat_id:quote.chat_id,scene_session_id:quote.scene_session_id,turn_no:quote.turn_no,scene_turn_no:quote.scene_turn_no,character_i:quote.character_i,scene_mode:quote.scene_mode,subscription_days:quote.subscription_days??null,subscription_sku:quote.kind==='subscription'?quote.sku:null,feature_key:quote.feature_key??null,media_signature:quote.media_signature??null,target_message_id:quote.panel_id??null,photo_uuid:quote.media_id??null,photo_sku:quote.kind==='photo'?quote.sku:null};
   await r(tx,"SELECT * FROM public.media_upsert_invoice_token($1,'invoice_payload',$2,$3,$4,$5::smallint,$6::text::jsonb,$7,$8,$9,$10::integer,$11,$12::integer,NULL,NULL,NULL,NULL,$13,$14,$13,$13)",[token,quote.chat_id,quote.scene_session_id,quote.turn_no,quote.scene_turn_no,JSON.stringify(payload),action,quote.sku,provider,amount,quote.currency.toUpperCase(),quote.amount_xtr,quote.title,quote.description]);
   const row=(await r(tx,"INSERT INTO app_private.web_purchases(purchase_id,user_id,chat_id,client_id,fingerprint,provider,payment_token,quote) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::text::jsonb) RETURNING *",[id,userId,quote.chat_id,clientId,fingerprint,provider,token,JSON.stringify({...quote,amount,currency:quote.currency.toUpperCase()})]))[0]!;
   return {purchase:asPurchase(row),created:true};
  });
 }
 async redeemFreeFeature(userId:string,quote:WebCommerceQuote,clientId:string):Promise<{available:boolean;fulfilled:boolean;feature_key:string;operation_id?:string;reason?:string}>{
  if(quote.kind!=='feature'||!quote.feature_key)return {available:false,fulfilled:false,feature_key:quote.feature_key??''};
  return this.query.begin(async tx=>{
   const c=await this.context(tx,userId,quote.chat_code,true);
   const common=new MediaCommerceRepository(tx as unknown as typeof sql);
   const feature=quote.feature_key!;
   if(!['scene_unlock','fast_scene_skip'].includes(feature))return {available:false,fulfilled:false,feature_key:feature};
   const action=feature==='scene_unlock'?'free_scene_unlock':'free_fast_scene_skip';
   const token='web_free_feature_'+createHash('sha256').update(userId+':'+clientId).digest('hex').slice(0,32);
   const fingerprint=createHash('sha256').update(JSON.stringify({chat_code:quote.chat_code,sku:quote.sku,feature_key:feature})).digest('hex');
   let stored=(await r(tx,"SELECT * FROM public.interaction_tokens WHERE token=$1 FOR UPDATE",[token]))[0];
   if(stored&&stored.payload_json.request_fingerprint!==fingerprint)throw new WebError(409,'idempotency_conflict');
   if(stored?.status==='fulfilled')return {available:true,fulfilled:true,feature_key:feature,operation_id:stored.payload_json.web_event_id as string};
   if(!stored){
    if(c.scene_session_id!==quote.scene_session_id||!c.scene_session_id)throw new WebError(409,'stale_scene');
    if(feature==='fast_scene_skip'&&c.scene_mode!=='fast')throw new WebError(409,'feature_not_available');
    const state=await common.loadSceneAccessStatus({chat_id:c.chat_id,scene_session_id:c.scene_session_id});
    if(feature==='scene_unlock'&&(state?.subscription_active||state?.scene_access_active))return {available:true,fulfilled:true,feature_key:feature,reason:'already_entitled'};
    const credits=await common.loadFreeCredits(c.chat_id);
    const balance=feature==='scene_unlock'?credits?.free_scene_unlocks:credits?.free_fast_scene_skips;
    if(!balance||balance<=0)return {available:false,fulfilled:false,feature_key:feature};
    const eventId=randomUUID();
    const payload={source:'web',feature_key:feature,request_fingerprint:fingerprint,web_event_id:eventId,web_quote:quote};
    stored=(await r(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,turn_no,action_kind,payload_json) VALUES($1,'button_callback',$2,$3,$4,$5,$6::text::jsonb) RETURNING *",[token,c.chat_id,c.scene_session_id,c.turn_no,action,JSON.stringify(payload)]))[0]!;
   }
   const snapshot=stored.payload_json.web_quote as WebCommerceQuote;
   const result=feature==='scene_unlock'?await common.redeemFreeSceneUnlock(token,c.chat_id):await common.redeemFreeFastSceneSkip(token,c.chat_id);
   if(!result?.redeemed&&!result?.already_consumed&&!result?.already_fulfilled)throw new WebError(409,result?.reason??'free_feature_unavailable');
   const eventId=stored.payload_json.web_event_id as string;
   if(feature==='fast_scene_skip'&&!result.already_fulfilled){
    const envelope={event_id:eventId,user_id:userId,chat_id:c.chat_id,character_i:snapshot.character_i,scene_mode:'fast',source:'web',action:'reset',data:{client_message_id:'free-feature:'+clientId,entry_mode:'fast_scene_skip',payment_token:token,feature_key:feature}};
    await r(tx,"INSERT INTO app_private.web_operations(event_id,user_id,chat_id,client_message_id,action,fingerprint,envelope) VALUES($1::uuid,$2,$3,$4,'reset',$5,$6::text::jsonb) ON CONFLICT(chat_id,client_message_id) DO NOTHING",[eventId,userId,c.chat_id,'free-feature:'+clientId,fingerprint,JSON.stringify(envelope)]);
   }else if(result.redeemed){
    await r(tx,"SELECT app_private.web_publish($1,'operation_status',$2::text::jsonb)",[c.chat_id,JSON.stringify({operation_id:eventId,action:feature,status:'completed'})]);
   }
   return {available:true,fulfilled:feature==='scene_unlock'||result.already_fulfilled===true,feature_key:feature,operation_id:eventId};
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
    await r(tx,"SELECT * FROM public.media_mark_invoice_paid($1,$2,'invoice_payload',$3,$4,NULL,NULL,$5,$6,$7::integer,NULL)",[p.payment_token,p.chat_id,action,p.provider,payment.external_payment_id,quote.currency,quote.amount]);
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
   const common=new MediaCommerceRepository(tx as unknown as typeof sql);
   await r(tx,"SELECT 1 FROM public.chat_state WHERE chat_id=$1 AND user_id=$2 FOR UPDATE",[p.chat_id,p.user_id]);
   await r(tx,"SELECT set_config('app_private.media_source','web',true)");
   if(q.kind==='subscription'){
    if(!q.subscription_days||q.subscription_days<=0)throw new WebError(409,'invalid_subscription_snapshot');
    await common.activateSubscription({payment_token:p.payment_token,chat_id:Number(p.chat_id),subscription_sku:q.sku,subscription_days:q.subscription_days});
   }else if(q.kind==='feature'&&q.feature_key==='scene_unlock'){
    if(!q.scene_session_id)throw new WebError(409,'missing_scene');
    await common.activateSceneAccess({payment_token:p.payment_token,chat_id:Number(p.chat_id),scene_session_id:q.scene_session_id,scene_access_sku:q.sku});
   }else if(q.kind==='photo'){
    if(!q.media_id||!q.media_signature||!q.panel_id)throw new WebError(409,'missing_media_snapshot');
    await common.storePhotoEvent({chat_id:Number(p.chat_id),scene_session_id:q.scene_session_id,turn_no:q.turn_no,scene_turn_no:q.scene_turn_no,event_type:'media.photo.unlocked.paid',media_signature:q.media_signature,uuid:q.media_id,panel_message_id:q.panel_id,price_xtr:q.amount_xtr??0,access_mode:'paid',action_kind:'photo_request',fulfillment_invoice_token:p.payment_token,next_invoice_token:null,next_invoice_link:null,price_required:0});
   }else if(q.kind==='feature'&&q.feature_key==='fast_scene_skip'){
    const eventId=p.purchase_id;
    const data={client_message_id:'commerce:'+id,entry_mode:'fast_scene_skip',payment_token:p.payment_token,feature_key:'fast_scene_skip'};
    const envelope={event_id:eventId,user_id:p.user_id,chat_id:Number(p.chat_id),character_i:q.character_i,scene_mode:q.scene_mode??'fast',source:'web',action:'reset',data};
    await r(tx,"INSERT INTO app_private.web_operations(event_id,user_id,chat_id,client_message_id,action,fingerprint,envelope) VALUES($1::uuid,$2,$3,$4,'reset',$5,$6::text::jsonb) ON CONFLICT(chat_id,client_message_id) DO NOTHING",[eventId,p.user_id,p.chat_id,'commerce:'+id,createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),JSON.stringify(envelope)]);
   }else throw new WebError(409,'unsupported_fulfillment');
   const token=(await r(tx,"SELECT status FROM public.interaction_tokens WHERE token=$1",[p.payment_token]))[0];
   const status=token?.status==='fulfilled'?'fulfilled':'fulfillment_pending';
   return asPurchase((await r(tx,"UPDATE app_private.web_purchases SET status=$2,updated_at=clock_timestamp() WHERE purchase_id=$1::uuid RETURNING *",[id,status]))[0]!);
  });
 }

 async recordOffer(userId:string,code:string,offer:{media_id:string;sku:string;media_signature:string;panel_id?:number;scene_session_id?:string|null;turn_no?:number;scene_turn_no?:number|null;price?:{amount:string;currency:string}|null;price_required?:number;debounce_revision?:number}):Promise<WebMediaOffer>{
  return this.query.begin(async tx=>{
   const context=await this.context(tx,userId,code,true);
   if(!context.scene_session_id||(offer.scene_session_id&&offer.scene_session_id!==context.scene_session_id))throw new WebError(409,'stale_scene');
   if(offer.debounce_revision!==undefined&&offer.debounce_revision!==Number(context.debounce_revision))throw new WebError(409,'stale_revision');
   const media=(await r(tx,"SELECT uuid FROM public.media_catalog WHERE uuid=$1::text AND character_i=$2 AND scene_hint=$3 AND status='ready'",[offer.media_id,context.character_i,offer.media_signature]))[0];
   if(!media)throw new WebError(404,'media_not_found');
   const conditions={price:offer.price??null,price_required:offer.price_required??null};
   const row=(await r(tx,"INSERT INTO app_private.web_media_offers(user_id,chat_id,scene_session_id,media_id,sku,media_signature,panel_id,turn_no,scene_turn_no,conditions) VALUES($1,$2,$3,$4::uuid,$5,$6,COALESCE($7::bigint,nextval('app_private.web_panel_id_seq')),$8,$9,$10::text::jsonb) ON CONFLICT(chat_id,scene_session_id,media_id) DO UPDATE SET sku=EXCLUDED.sku,media_signature=EXCLUDED.media_signature,conditions=EXCLUDED.conditions RETURNING *",[userId,context.chat_id,context.scene_session_id,offer.media_id,offer.sku,offer.media_signature,offer.panel_id??null,offer.turn_no??context.turn_no,offer.scene_turn_no??context.scene_turn_no,JSON.stringify(conditions)]))[0]!;
   await r(tx,"SELECT app_private.web_publish($1,'media_offer',$2::text::jsonb)",[context.chat_id,JSON.stringify({media_id:offer.media_id,media_kind:'photo',sku:offer.sku,scene_session_id:context.scene_session_id,...conditions})]);
   return {...context,...row,chat_id:Number(row.chat_id),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no),panel_id:Number(row.panel_id),media_kind:'photo'} as WebMediaOffer;
  });
 }
 async getOffer(userId:string,code:string,mediaId:string):Promise<WebMediaOffer|null>{
  const context=await this.context(this.query,userId,code);
  const row=(await r(this.query,"SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 AND media_id=$4::uuid",[userId,context.chat_id,context.scene_session_id,mediaId]))[0];
  return row?{...context,...row,chat_id:Number(row.chat_id),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no),panel_id:Number(row.panel_id),media_kind:'photo'} as WebMediaOffer:null;
 }
 private async isUnlocked(db:DB,userId:string,mediaId:string):Promise<boolean>{
  return (await r(db,"SELECT 1 FROM public.chat_messages m JOIN public.chat_state c USING(chat_id) WHERE c.user_id=$1 AND m.event_type=ANY($2::text[]) AND m.payload_json->>'uuid'=$3 LIMIT 1",[userId,photoEvents,mediaId])).length>0;
 }
 async unlockFree(userId:string,code:string,mediaId:string,quote:WebCommerceQuote):Promise<{unlocked:boolean;media_id:string;media_kind:'photo';photo_url?:string|null;reason?:string}>{
  return this.query.begin(async tx=>{
   const c=await this.context(tx,userId,code,true);
   const common=new MediaCommerceRepository(tx as unknown as typeof sql);
   if(await this.isUnlocked(tx,userId,mediaId)){const media=await common.loadPhotoByUuid(mediaId);return {unlocked:true,media_id:mediaId,media_kind:'photo' as const,photo_url:media?.photo_url};}
   const offer=(await r(tx,"SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 AND media_id=$4::uuid",[userId,c.chat_id,c.scene_session_id,mediaId]))[0];
   if(!offer||quote.chat_id!==c.chat_id||quote.scene_session_id!==c.scene_session_id||quote.media_id!==mediaId)throw new WebError(409,'stale_media_offer');
   const input={chat_id:c.chat_id,scene_session_id:c.scene_session_id,turn_no:Number(offer.turn_no),scene_turn_no:offer.scene_turn_no==null?null:Number(offer.scene_turn_no),media_signature:offer.media_signature,base_price_xtr:quote.amount_xtr??1,current_uuid:null,target_message_id:Number(offer.panel_id),action_kind:'photo_request',requested_action:'photo_request',invoice_token:null,force_deliver_after_payment:false,paid_access_mode:null,callback_valid:true,panel_text:null,panel_entities_json:[]};
   const ctx=await common.loadMediaContext(input);
   const next=ctx.next_unseen_json as Record<string,unknown>|null;
   if(!next||next.uuid!==mediaId)throw new WebError(409,'media_context_stale');
   const required=calculateMediaPriceRequired({subscription_active:ctx.subscription_active===true,scene_access_active:ctx.scene_access_active===true,delivered_in_scene:ctx.delivered_in_scene,base_price_xtr:quote.amount_xtr??1});
   await r(tx,"SELECT set_config('app_private.media_source','web',true)");
   if(required===0){
    const mode=ctx.subscription_active?'subscription':ctx.scene_access_active?'scene_pass':'free';
    await common.storePhotoEvent({...input,event_type:'media.photo.unlocked.'+mode,uuid:mediaId,panel_message_id:Number(offer.panel_id),price_xtr:0,access_mode:mode,action_kind:'photo_request',fulfillment_invoice_token:null,next_invoice_token:null,next_invoice_link:null,price_required:0});
   }else{
    const token='web_free_'+createHash('sha256').update(userId+':'+c.chat_id+':'+c.scene_session_id+':'+mediaId).digest('hex').slice(0,32);
    const payload={source:'web',media_signature:offer.media_signature,target_message_id:Number(offer.panel_id),base_price_xtr:quote.amount_xtr??1,scene_turn_no:input.scene_turn_no,requested_action:'photo_request'};
    await r(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,turn_no,action_kind,payload_json) VALUES($1,'button_callback',$2,$3,$4,'free_photo_unlock',$5::text::jsonb) ON CONFLICT(token) DO NOTHING",[token,c.chat_id,c.scene_session_id,input.turn_no,JSON.stringify(payload)]);
    const redeemed=await common.redeemFreePhotoUnlock(token,c.chat_id);
    if(!redeemed?.redeemed&&!redeemed?.already_consumed&&!redeemed?.already_fulfilled)return {unlocked:false,media_id:mediaId,media_kind:'photo' as const,reason:redeemed?.reason??'payment_required'};
    const selected=redeemed.payload_json?.free_photo_uuid;
    if(selected!==mediaId)throw new WebError(409,'media_context_stale');
    await common.finalizeFreePhotoUnlock({chat_id:c.chat_id,scene_session_id:c.scene_session_id,turn_no:input.turn_no,scene_turn_no:input.scene_turn_no,token,media_signature:offer.media_signature,uuid:mediaId,panel_message_id:Number(offer.panel_id)});
   }
   const media=await common.loadPhotoByUuid(mediaId);
   return {unlocked:true,media_id:mediaId,media_kind:'photo' as const,photo_url:media?.photo_url};
  });
 }
 async gallery(userId:string,code:string){
  const c=await this.context(this.query,userId,code);
  const owned=await r(this.query,"SELECT DISTINCT m.payload_json->>'uuid' AS media_id FROM public.chat_messages m JOIN public.chat_state s USING(chat_id) JOIN public.media_catalog mc ON mc.uuid::text=m.payload_json->>'uuid' WHERE s.user_id=$1 AND mc.character_i=$2 AND m.event_type=ANY($3::text[])",[userId,c.character_i,photoEvents]);
  const common=new MediaCommerceRepository(this.query);
  const unlocked=await Promise.all(owned.map(async item=>({media_id:item.media_id,media_kind:'photo',unlocked:true,photo_url:(await common.loadPhotoByUuid(item.media_id))?.photo_url??null})));
  const offers=await r(this.query,"SELECT media_id::text,sku,scene_session_id,conditions FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 ORDER BY created_at",[userId,c.chat_id,c.scene_session_id]);
  const ownedIds=new Set(owned.map(item=>item.media_id));
  return {media:[...unlocked,...offers.filter(item=>!ownedIds.has(item.media_id)).map(item=>({...item,media_kind:'photo',unlocked:false}))]};
 }
}
