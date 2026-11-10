import { sql, queryRows as r, toIsoTimestamp as iso } from '../../db.js';
import { WebError } from '../../web/types.js';
import type {WebCommerceContext,WebCommerceQuote,WebMediaOffer} from '../../web/commerceTypes.js';
import {loadWebCommerceContext} from '../chats/webCommerceContext.js';
import {createHash,randomUUID} from 'node:crypto';
import {MediaCatalogRepository} from '../media/catalogRepository.js';
import {MediaEventRepository} from '../media/mediaEventRepository.js';
import {loadSceneAccessStatus,loadFreeCredits,redeemFreeSceneUnlock,redeemFreeFastSceneSkip,redeemFreePhotoUnlock} from './accessRepository.js';
import {calculateMediaPriceRequired} from './actionEligibility.js';
import {config} from '../../config.js';
type DB=Pick<typeof sql,'unsafe'>;
export const photoEvents=['media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass'];
export async function getEntitlements(query:typeof sql,userId:string){const columns=config.MEDIA_VIDEO_ENABLED?',subscription_tier,subscription_tier_sku':'';const row=(await r(query,"SELECT subscription_sku,subscription_until,entitlements_jsonb AS balances"+columns+" FROM public.users WHERE user_id=$1",[userId]))[0];if(!row)throw new WebError(401,'account_not_found');const active=Boolean(row.subscription_until&&new Date(row.subscription_until).getTime()>Date.now());const full=active&&row.subscription_tier==='full'&&row.subscription_tier_sku===row.subscription_sku;return {subscription_sku:row.subscription_sku,subscription_until:iso(row.subscription_until),balances:row.balances,subscription_active:active,subscription_tier:full?'full':'base',full_active:full};}

export async function redeemFreeFeature(query:typeof sql,userId:string,quote:WebCommerceQuote,clientId:string):Promise<{available:boolean;fulfilled:boolean;feature_key:string;operation_id?:string;reason?:string}>{
  if(quote.kind!=='feature'||!quote.feature_key||!quote.chat_code)return {available:false,fulfilled:false,feature_key:quote.feature_key??''};
  return query.begin(async tx=>{
   const c=await loadWebCommerceContext(tx,userId,quote.chat_code!,true);
   
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
    const state=await loadSceneAccessStatus(tx as unknown as typeof sql,{chat_id:c.chat_id,scene_session_id:c.scene_session_id});
    if(feature==='scene_unlock'&&(state?.subscription_active||state?.scene_access_active))return {available:true,fulfilled:true,feature_key:feature,reason:'already_entitled'};
    const credits=await loadFreeCredits(tx as unknown as typeof sql,c.chat_id);
    const balance=feature==='scene_unlock'?credits?.free_scene_unlocks:credits?.free_fast_scene_skips;
    if(!balance||balance<=0)return {available:false,fulfilled:false,feature_key:feature};
    const eventId=randomUUID();
    const payload={source:'web',feature_key:feature,...(feature==='scene_unlock'?{duration_days:config.SCENE_ACCESS_DAYS}:{}),request_fingerprint:fingerprint,web_event_id:eventId,web_quote:quote};
    stored=(await r(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,turn_no,action_kind,payload_json) VALUES($1,'button_callback',$2,$3,$4,$5,$6::text::jsonb) RETURNING *",[token,c.chat_id,c.scene_session_id,c.turn_no,action,JSON.stringify(payload)]))[0]!;
   }
   const snapshot=stored.payload_json.web_quote as WebCommerceQuote;
   const result=feature==='scene_unlock'?await redeemFreeSceneUnlock(tx as unknown as typeof sql,token,c.chat_id):await redeemFreeFastSceneSkip(tx as unknown as typeof sql,token,c.chat_id);
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

export async function isUnlocked(db:DB,userId:string,mediaId:string):Promise<boolean>{
  return (await r(db,"SELECT 1 FROM public.chat_messages m JOIN public.chat_state c USING(chat_id) WHERE c.user_id=$1 AND m.event_type=ANY($2::text[]) AND m.payload_json->>'uuid'=$3 LIMIT 1",[userId,photoEvents,mediaId])).length>0;
 }

export async function unlockFree(query:typeof sql,userId:string,code:string,mediaId:string,quote:WebCommerceQuote):Promise<{unlocked:boolean;media_id:string;media_kind:'photo';photo_url?:string|null;reason?:string}>{
  return query.begin(async tx=>{
   const c=await loadWebCommerceContext(tx,userId,code,true);
   const catalog=new MediaCatalogRepository(tx as unknown as typeof sql);
   const events=new MediaEventRepository(tx as unknown as typeof sql);
   if(await isUnlocked(tx,userId,mediaId)){const media=await catalog.loadPhotoByUuid(mediaId);return {unlocked:true,media_id:mediaId,media_kind:'photo' as const,photo_url:media?.photo_url};}
   const offer=(await r(tx,"SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 AND media_id=$4::uuid",[userId,c.chat_id,c.scene_session_id,mediaId]))[0];
   if(!offer||quote.chat_id!==c.chat_id||quote.scene_session_id!==c.scene_session_id||quote.media_id!==mediaId)throw new WebError(409,'stale_media_offer');
   const input={chat_id:c.chat_id,scene_session_id:c.scene_session_id,turn_no:Number(offer.turn_no),scene_turn_no:offer.scene_turn_no==null?null:Number(offer.scene_turn_no),media_signature:offer.media_signature,base_price_xtr:quote.amount_xtr??1,current_uuid:null,target_message_id:Number(offer.panel_id),action_kind:'photo_request',requested_action:'photo_request',invoice_token:null,force_deliver_after_payment:false,paid_access_mode:null,callback_valid:true,panel_text:null,panel_entities_json:[]};
   const ctx=await catalog.loadMediaContext(input);
   const next=ctx.next_unseen_json as Record<string,unknown>|null;
   if(!next||next.uuid!==mediaId)throw new WebError(409,'media_context_stale');
   const required=calculateMediaPriceRequired({subscription_active:ctx.subscription_active===true,scene_access_active:ctx.scene_access_active===true,free_photos_today:(ctx.free_photos_today??0)+(ctx.pending_free_photos??0),base_price_xtr:quote.amount_xtr??1});
   await r(tx,"SELECT set_config('app_private.media_source','web',true)");
   if(required===0){
    const mode=ctx.subscription_active?'subscription':ctx.scene_access_active?'scene_pass':'free';
    await events.storePhotoEvent({...input,event_type:'media.photo.unlocked.'+mode,uuid:mediaId,panel_message_id:Number(offer.panel_id),price_xtr:0,access_mode:mode,action_kind:'photo_request',fulfillment_invoice_token:null,next_invoice_token:null,next_invoice_link:null,price_required:0});
   }else{
    const token='web_free_'+createHash('sha256').update(userId+':'+c.chat_id+':'+c.scene_session_id+':'+mediaId).digest('hex').slice(0,32);
    const payload={source:'web',media_signature:offer.media_signature,target_message_id:Number(offer.panel_id),base_price_xtr:quote.amount_xtr??1,scene_turn_no:input.scene_turn_no,requested_action:'photo_request'};
    await r(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,turn_no,action_kind,payload_json) VALUES($1,'button_callback',$2,$3,$4,'free_photo_unlock',$5::text::jsonb) ON CONFLICT(token) DO NOTHING",[token,c.chat_id,c.scene_session_id,input.turn_no,JSON.stringify(payload)]);
    const redeemed=await redeemFreePhotoUnlock(tx as unknown as typeof sql,token,c.chat_id);
    if(!redeemed?.redeemed&&!redeemed?.already_consumed&&!redeemed?.already_fulfilled)return {unlocked:false,media_id:mediaId,media_kind:'photo' as const,reason:redeemed?.reason??'payment_required'};
    const selected=redeemed.payload_json?.free_photo_uuid;
    if(selected!==mediaId)throw new WebError(409,'media_context_stale');
    await events.finalizeFreePhotoUnlock({chat_id:c.chat_id,scene_session_id:c.scene_session_id,turn_no:input.turn_no,scene_turn_no:input.scene_turn_no,token,media_signature:offer.media_signature,uuid:mediaId,panel_message_id:Number(offer.panel_id)});
   }
   const media=await catalog.loadPhotoByUuid(mediaId);
   return {unlocked:true,media_id:mediaId,media_kind:'photo' as const,photo_url:media?.photo_url};
  });
 }
