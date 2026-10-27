import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { config } from '../config.js';
import { isInternalApiAuthorized } from '../internalApiAuth.js';
import { MediaCommerceRepository } from '../mediaCommerceRepository.js';
import type { WebCommerceService } from './commerce.js';
import { WebError } from './types.js';

type Row=Record<string,any>;
export interface WebEngineContext {
 chat_id:number;chat_code:string;user_id:string;character_i:number;scene_session_id:string|null;
 turn_no:number;scene_turn_no:number;debounce_revision:number;scene_mode:'fast'|'roleplay'|null;telegram_chat_id:number|null;
}
export class WebEngineBridge {
 constructor(private readonly commerce:WebCommerceService,private readonly query:typeof sql=sql){}
 async context(chatId:number):Promise<WebEngineContext>{
  const r=(await this.query<Row[]>`SELECT c.chat_id,c.chat_code,c.user_id,c.character_i,c.active_scene_session_id AS scene_session_id,c.current_turn_no AS turn_no,c.scene_turn_no,c.debounce_revision,s.scene_mode,(SELECT external_id FROM public.user_identities WHERE user_id=c.user_id AND provider='telegram' LIMIT 1) AS telegram_chat_id FROM public.chat_state c LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id WHERE c.chat_id=${chatId} AND c.is_active AND c.character_i IS NOT NULL`)[0];
  if(!r)throw new WebError(404,'chat_not_found');
  return {chat_id:Number(r.chat_id),chat_code:r.chat_code,user_id:r.user_id,character_i:Number(r.character_i),scene_session_id:r.scene_session_id,turn_no:Number(r.turn_no),scene_turn_no:Number(r.scene_turn_no),debounce_revision:Number(r.debounce_revision),scene_mode:r.scene_mode,telegram_chat_id:r.telegram_chat_id==null?null:Number(r.telegram_chat_id)};
 }
 async mediaOffer(input:{chat_id:number;sku:string;media_signature:string;media_id?:string;scene_session_id?:string;debounce_revision?:number}){
  const c=await this.context(input.chat_id);
  if((input.scene_session_id!==undefined&&input.scene_session_id!==c.scene_session_id)||(input.debounce_revision!==undefined&&input.debounce_revision!==Number(c.debounce_revision)))throw new WebError(409,'stale_scene');
  let mediaId=input.media_id;
  if(!mediaId){
   const plan=(await this.commerce.decisions.webProductPlans(c.chat_id)).find(p=>p.sku===input.sku&&p.kind==='photo');if(!plan)throw new WebError(404,'product_not_found');
   const repo=new MediaCommerceRepository(this.query);
   const m=await repo.loadMediaContext({chat_id:c.chat_id,scene_session_id:c.scene_session_id,turn_no:c.turn_no,scene_turn_no:c.scene_turn_no,media_signature:input.media_signature,current_uuid:null,target_message_id:null,base_price_xtr:plan.amount_xtr,action_kind:'photo_request',requested_action:'photo_request',invoice_token:null,force_deliver_after_payment:false,paid_access_mode:null,callback_valid:true,panel_text:null,panel_entities_json:[]});
   const next=m.next_unseen_json as Record<string,unknown>|null;
   if(!next||typeof next.uuid!=='string')return {offered:false,has_media_offer:false};mediaId=next.uuid;
  }
  const result=await this.commerce.prepareOffer(c.user_id,c.chat_code,{media_id:mediaId,sku:input.sku,media_signature:input.media_signature,scene_session_id:input.scene_session_id,debounce_revision:input.debounce_revision});
  return {...result,has_media_offer:result.offered,media_signature:input.media_signature};
 }
 async continuation(input:{telegram_chat_id:number;source_user_id:number;character_i?:number;confirm?:boolean;acknowledge?:boolean;scene_session_id?:string;turn_no?:number}){
  const none={action:'none' as const,telegram_chat_id:input.telegram_chat_id};
  const identity=(await this.query<Row[]>`SELECT user_id FROM public.user_identities WHERE provider='telegram' AND external_id=${String(input.source_user_id)}`)[0];
  if(!identity)return none;
  const candidates=await this.query<Row[]>`SELECT c.chat_id,c.chat_code,c.character_i,c.active_scene_session_id AS scene_session_id,s.scene_mode,a.last_web_at::text,a.last_telegram_at::text,(a.last_telegram_at IS NULL OR a.last_web_at>a.last_telegram_at) AS web_is_newer FROM public.chat_state c JOIN app_private.web_activity a ON a.chat_id=c.chat_id LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id WHERE c.user_id=${identity.user_id} AND c.is_active AND c.character_i IS NOT NULL AND (${input.character_i??null}::smallint IS NULL OR c.character_i=${input.character_i??null}::smallint) AND a.last_web_at IS NOT NULL ORDER BY a.last_web_at DESC LIMIT 1`;
  const c=candidates[0];if(!c)return none;
  const reply=(await this.query<Row[]>`SELECT t.n,t.assistant_text,t.sent_at FROM public.chat_turns t WHERE t.chat_id=${c.chat_id} AND t.scene_session_id=${c.scene_session_id} AND t.assistant_text IS NOT NULL AND t.sent_at IS NOT NULL ORDER BY t.n DESC LIMIT 1`)[0];
  if(!reply)return none;
  if(input.acknowledge){
   if(input.scene_session_id!==c.scene_session_id||input.turn_no!==Number(reply.n))throw new WebError(409,'continuation_changed');
   await this.query.begin(async tx=>{
    const current=(await tx<Row[]>`SELECT active_scene_session_id FROM public.chat_state WHERE chat_id=${c.chat_id} FOR UPDATE`)[0];
    const latest=(await tx<Row[]>`SELECT n FROM public.chat_turns WHERE chat_id=${c.chat_id} AND scene_session_id=${c.scene_session_id} AND assistant_text IS NOT NULL AND sent_at IS NOT NULL ORDER BY n DESC LIMIT 1`)[0];
    if(current?.active_scene_session_id!==input.scene_session_id||Number(latest?.n)!==input.turn_no)throw new WebError(409,'continuation_changed');
    // Acknowledge only the activity observed for this replay, never a newer Web turn.
    await tx`UPDATE app_private.web_activity SET last_telegram_at=GREATEST(last_telegram_at,${c.last_web_at}::text::timestamptz) WHERE chat_id=${c.chat_id}`;
    await tx`UPDATE public.chat_state SET selected_character_i=${c.character_i} WHERE chat_id=${input.telegram_chat_id} AND user_id=${identity.user_id}`;
   });
   return {...none,acknowledged:true};
  }
  if(!c.web_is_newer)return none;
  return {action:input.confirm?'continue' as const:'offer' as const,chat_id:Number(c.chat_id),chat_code:c.chat_code,telegram_chat_id:input.telegram_chat_id,user_id:identity.user_id,character_i:Number(c.character_i),scene_session_id:c.scene_session_id,scene_mode:c.scene_mode,turn_no:Number(reply.n),assistant_text:input.confirm?reply.assistant_text:null,callback_data:'web_continue:'+c.character_i};
 }
}

export function registerWebEngineRoutes(app:FastifyInstance,bridge:WebEngineBridge){
 void app.register(async scope=>{
  scope.addHook('onRequest',async(request,reply)=>{if(!isInternalApiAuthorized(request.headers,config.INTERNAL_API_KEY_HEADER,config.INTERNAL_API_KEY))return reply.status(401).send({error:'unauthorized'});});
  scope.setErrorHandler((error,request,reply)=>{if(error instanceof WebError)return reply.status(error.statusCode).send({error:error.code});if(error instanceof z.ZodError)return reply.status(400).send({error:'invalid_request'});request.log.error({request_id:request.id},'Engine bridge failed');return reply.status(500).send({error:'engine_bridge_failed'});});
  const id=z.number().int().positive().safe();
  scope.post('/v1/web/engine-context',async request=>{const p=z.object({chat_id:id}).strict().parse(request.body);return bridge.context(p.chat_id);});
  scope.post('/v1/web/media-offer',async request=>{const p=z.object({chat_id:id,sku:z.string().min(1).max(120),media_signature:z.string().min(1).max(500),media_id:z.string().uuid().optional(),scene_session_id:z.string().min(1).max(200).optional(),debounce_revision:z.number().int().nonnegative().optional()}).strict().parse(request.body);return bridge.mediaOffer(p);});
  scope.post('/v1/web/continuation',async request=>{const p=z.object({telegram_chat_id:id,source_user_id:id,character_i:z.number().int().positive().max(32767).optional(),confirm:z.boolean().optional(),acknowledge:z.boolean().optional(),scene_session_id:z.string().min(1).max(200).optional(),turn_no:z.number().int().safe().optional()}).strict().parse(request.body);return bridge.continuation(p);});
 });
}
