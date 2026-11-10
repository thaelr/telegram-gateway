import { sql, queryRows as r, toIsoTimestamp as iso } from '../../db.js';
import { WebError } from '../../web/types.js';
import type {WebCommerceContext,WebCommerceQuote,WebMediaOffer} from '../../web/commerceTypes.js';
import {loadWebCommerceContext} from '../chats/webCommerceContext.js';
import {MediaCatalogRepository} from './catalogRepository.js';
import type {WebVideoAccess} from './webVideoAccess.js';
import {photoEvents} from '../access/webEntitlements.js';
type Row=Record<string,any>;
export async function recordOffer(query:typeof sql,userId:string,code:string,offer:{media_id:string;sku:string;media_signature:string;panel_id?:number;scene_session_id?:string|null;turn_no?:number;scene_turn_no?:number|null;price?:{amount:string;currency:string}|null;price_required?:number;debounce_revision?:number}):Promise<WebMediaOffer>{
  return query.begin(async tx=>{
   const context=await loadWebCommerceContext(tx,userId,code,true);
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

export async function getOffer(query:typeof sql,userId:string,code:string,mediaId:string):Promise<WebMediaOffer|null>{
  const context=await loadWebCommerceContext(query,userId,code);
  const row=(await r(query,"SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 AND media_id=$4::uuid",[userId,context.chat_id,context.scene_session_id,mediaId]))[0];
  return row?{...context,...row,chat_id:Number(row.chat_id),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no),panel_id:Number(row.panel_id),media_kind:'photo'} as WebMediaOffer:null;
 }

export async function getOffers(query:typeof sql,userId:string,code:string,mediaIds:string[]):Promise<WebMediaOffer[]>{
  if(!mediaIds.length)return [];
  const context=await loadWebCommerceContext(query,userId,code);
  const result=await query.unsafe<Row[]>("SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND scene_session_id=$3 AND media_id=ANY($4::uuid[])",[userId,context.chat_id,context.scene_session_id,mediaIds]);
  return result.map(row=>({...context,...row,chat_id:Number(row.chat_id),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no),panel_id:Number(row.panel_id),media_kind:'photo'}) as WebMediaOffer);
 }

export async function gallery(query:typeof sql,videos:WebVideoAccess,userId:string,code:string){
  const c=await loadWebCommerceContext(query,userId,code);
  const owned=await r(query,"SELECT DISTINCT ON (m.payload_json->>'uuid') m.payload_json->>'uuid' AS media_id,m.created_at::text,m.scene_session_id FROM public.chat_messages m JOIN public.chat_state s USING(chat_id) JOIN public.media_catalog mc ON mc.uuid::text=m.payload_json->>'uuid' WHERE s.user_id=$1 AND mc.character_i=$2 AND m.event_type=ANY($3::text[]) ORDER BY m.payload_json->>'uuid',m.created_at,m.id",[userId,c.character_i,photoEvents]);
  const mediaById=await new MediaCatalogRepository(query).loadPhotosByUuid(owned.map(item=>String(item.media_id)));
  const panelOffers=await r(query,`SELECT media_id::text,sku,scene_session_id,created_at::text,conditions,panel_id::text,
   first_value(media_id::text) OVER (PARTITION BY scene_session_id,panel_id ORDER BY created_at,media_id) AS panel_media_id
   FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 ORDER BY created_at,media_id`,[userId,c.chat_id]);
  const bySceneAndPhoto=new Map(panelOffers.map(row=>[JSON.stringify([row.scene_session_id,row.media_id]),row]));
  const unlocked=owned.map(item=>{
   const panel=bySceneAndPhoto.get(JSON.stringify([item.scene_session_id,item.media_id]));
   return {media_id:item.media_id,...(panel?{panel_id:panel.panel_id,panel_media_id:panel.panel_media_id}:{}),media_kind:'photo',unlocked:true,created_at:iso(item.created_at),scene_session_id:item.scene_session_id,photo_url:mediaById.get(item.media_id)?.photo_url??null};
  });
  const offers=panelOffers.filter(row=>row.scene_session_id===c.scene_session_id);
  const ownedIds=new Set(owned.map(item=>item.media_id));
  // In-flight deliveries must survive leaving a scene and closing the browser.
  // Reading their IDs does not claim or re-send them; the existing access route
  // performs that operation with the original delivery's claim token.
  const deliveries=await r(query,"SELECT * FROM app_private.video_deliveries WHERE user_id=$1 AND chat_id=$2 AND source='web' AND (requested_photo_uuid IS NOT NULL OR status<>'delivered') ORDER BY created_at,delivery_id",[userId,c.chat_id]);
  return {media:[...unlocked,...offers.filter(item=>!ownedIds.has(item.media_id)).map(item=>({...item,media_id:String(item.media_id),media_kind:'photo',unlocked:false}))],video_deliveries:deliveries.map(row=>videos.publicDelivery(row))};
 }
