import { createHash, randomUUID } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../config.js';
import { MediaCatalogRepository } from '../mediaCommerceRepository/catalogRepository.js';
import { WEB_HISTORY_CTE, WEB_SUMMARY_HISTORY_CTE, decodeHistoryCursor, encodeHistoryCursor, mapHistoryMessage } from './history.js';
import type { WebDeliveryStore } from './delivery.js';
import {eventSchema,quickRepliesSchema,parseStored} from './contracts.js';
import type {WebQuickReplies} from './types.js';
import { WebError, type WebRepositoryContract, type WebIdentity, type WebProfile, type WebChat, type WebChatSummary, type WebCharacter, type WebAction, type SceneMode, type WebOperation, type WebMessage, type WebEvent, type WebDeliveryEvent } from './types.js';

type DB = Pick<typeof sql, 'unsafe'>;
type Param = string | number | boolean | null;
type Row = Record<string, any>;
async function rows(db: DB, text: string, values: Param[] = []): Promise<Row[]> { return db.unsafe(text, values); }
const chatSelect = `SELECT c.chat_id, c.chat_code, c.character_i, c.source, s.scene_mode, c.active_scene_session_id AS scene_session_id, c.current_turn_no AS turn_no,c.scene_turn_no,c.updated_at::text FROM public.chat_state c LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id`;
function iso(value: unknown): string | null { return value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function publicChat(r: Row): WebChat { return {chat_code:r.chat_code,origin:r.source==='web'?'web':'telegram',character_i:Number(r.character_i),scene_mode:r.scene_mode,scene_session_id:r.scene_session_id,turn_no:Number(r.turn_no),scene_turn_no:Number(r.scene_turn_no),updated_at:iso(r.updated_at)!}; }
function operation(r: Row, code: string): WebOperation { return {operation_id:r.event_id,event_id:r.event_id,status:r.status,action:r.action,chat_code:code,...(r.client_message_id?{client_message_id:r.client_message_id}:{}),...(r.error_code?{error_code:r.error_code}:{})}; }
export class WebRepository implements WebRepositoryContract, WebDeliveryStore {
 constructor(private readonly query: typeof sql = sql) {}
 async resolveIdentity(authUserId: string) { const r=await rows(this.query,`SELECT user_id FROM public.user_identities WHERE provider='supabase' AND external_id=$1`,[authUserId]); return r[0]?.user_id??null; }
 async bootstrap(identity: WebIdentity): Promise<WebProfile> {
  let row:Row|undefined;
  for(let attempt=0;attempt<3;attempt++){
   row=(await rows(this.query,`SELECT app_private.web_bootstrap_identity($1::text,$2::text,$3::text) AS result`,
    [identity.auth_user_id,identity.display_name,identity.verified_telegram_id??null]))[0];
   if(row?.result?.code!=='account_busy'||attempt===2)break;
   await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
  }
  const result=row?.result;
  if(result?.status==='error'){
   const allowed=new Set(['subscription_conflict','telegram_identity_conflict','telegram_account_conflict','identity_conflict','account_busy']);
   throw new WebError(allowed.has(result.code)?409:500,allowed.has(result.code)?result.code:'internal_error');
  }
  if(result?.status!=='linked'||typeof result.user_id!=='string')throw new WebError(500,'internal_error');
  return this.getMe(result.user_id);
 }
 async getMe(userId: string): Promise<WebProfile> {
  const r=(await rows(this.query,`SELECT user_id,display_name,profile_text,language,language_confirmed_at::text,age_confirmed_at::text,terms_accepted_at::text,subscription_sku,subscription_until::text,entitlements_jsonb AS entitlements FROM public.users WHERE user_id=$1`,[userId]))[0];
  if(!r) throw new WebError(401,'account_not_found');
  return {...r,language_confirmed_at:iso(r.language_confirmed_at),age_confirmed_at:iso(r.age_confirmed_at),terms_accepted_at:iso(r.terms_accepted_at),subscription_until:iso(r.subscription_until),needs_language_selection:r.language_confirmed_at==null&&r.terms_accepted_at==null} as WebProfile;
 }
 private async lockWebAccount(db:DB,userId:string,write=false){
  const account=await rows(db,`SELECT user_id FROM public.users WHERE user_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[userId]);
  // A separate statement after the lock sees identity adoption committed while
  // this request was waiting. An EXISTS predicate in the locking statement alone
  // could still use its earlier MVCC snapshot.
  const identity=await rows(db,`SELECT 1 FROM public.user_identities WHERE user_id=$1 AND provider='supabase' LIMIT 1`,[userId]);
  if(!account.length||!identity.length)throw new WebError(401,'account_not_found');
 }
 async updateMe(userId: string, patch: {display_name?:string;profile_text?:string;language?:string}) {
  await this.query.begin(async tx=>{await this.lockWebAccount(tx,userId,true);
  await rows(tx,`UPDATE public.users SET display_name=CASE WHEN $2 THEN $3 ELSE display_name END,language=CASE WHEN $4 THEN $5 ELSE language END,language_confirmed_at=CASE WHEN $4 THEN now() ELSE language_confirmed_at END,profile_text=CASE WHEN $6 THEN $7 ELSE profile_text END,updated_at=now() WHERE user_id=$1`,[userId,patch.display_name!==undefined,patch.display_name??null,patch.language!==undefined,patch.language??null,patch.profile_text!==undefined,patch.profile_text??null]);});
  return this.getMe(userId);
 }
 async confirmAge(userId: string) { await this.query.begin(async tx=>{await this.lockWebAccount(tx,userId,true);await rows(tx,`SELECT app_private.confirm_user_age($1::varchar)`,[userId]);});return this.getMe(userId); }
 async acceptTerms(userId: string) {
  await this.query.begin(async tx=>{await this.lockWebAccount(tx,userId,true);
  const updated=await rows(tx,`UPDATE public.users SET terms_accepted_at=COALESCE(terms_accepted_at,now()),updated_at=now() WHERE user_id=$1 AND (language_confirmed_at IS NOT NULL OR terms_accepted_at IS NOT NULL) RETURNING user_id`,[userId]);
  if(!updated.length)throw new WebError(403,'language_selection_required');});
  return this.getMe(userId);
 }
 async listCharacters(userId: string): Promise<WebCharacter[]> {
  const r=await rows(this.query,`SELECT u.language AS requested_language,ch.character_i,ch.name,COALESCE(NULLIF(ch.description_translations_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.description_translations_json->>'ru',''),ch.description) AS description,COALESCE(NULLIF(ch.scene_start_exposition_translations_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.scene_start_exposition_translations_json->>'ru',''),ch.scene_start_exposition_text) AS scene_start_exposition_text,COALESCE(NULLIF(ch.scene_start_greeting_translations_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.scene_start_greeting_translations_json->>'ru',''),ch.scene_start_greeting_text) AS scene_start_greeting_text,COALESCE(NULLIF(ch.fast_mode_scene_start_exposition_translations_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.fast_mode_scene_start_exposition_translations_json->>'ru',''),ch.fast_mode_scene_start_exposition_text) AS fast_mode_scene_start_exposition_text,COALESCE(NULLIF(ch.fast_mode_scene_start_greeting_translations_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.fast_mode_scene_start_greeting_translations_json->>'ru',''),ch.fast_mode_scene_start_greeting_text) AS fast_mode_scene_start_greeting_text,COALESCE(NULLIF(ch.gallery_photo_urls_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.gallery_photo_urls_json->>'en',''),(SELECT NULLIF(entry.value,'') FROM jsonb_each_text(ch.gallery_photo_urls_json) entry WHERE NULLIF(entry.value,'') IS NOT NULL ORDER BY entry.key LIMIT 1),NULLIF(ch.gallery_photo_url,'')) AS gallery_photo_url,COALESCE(NULLIF(ch.menu_photo_urls_json->>COALESCE(u.language,'ru'),''),NULLIF(ch.menu_photo_urls_json->>'en',''),(SELECT NULLIF(entry.value,'') FROM jsonb_each_text(ch.menu_photo_urls_json) entry WHERE NULLIF(entry.value,'') IS NOT NULL ORDER BY entry.key LIMIT 1),NULLIF(ch.menu_photo_url,'')) AS menu_photo_url,c.chat_code FROM public.characters ch CROSS JOIN public.users u LEFT JOIN public.chat_state c ON c.user_id=u.user_id AND c.character_i=ch.character_i AND c.is_active WHERE u.user_id=$1 ORDER BY ch.character_i`,[userId]);
  return r.map(({requested_language,...x})=>{
   const configured=config.WEB_CHARACTER_GALLERY_JSON[String(x.character_i)]??{};
   const gallery=configured[requested_language]??configured.ru??configured.en??[];
   return {...x,image_url:x.menu_photo_url??x.gallery_photo_url,gallery_photos:[...new Set([...gallery,x.gallery_photo_url,x.menu_photo_url].filter((value):value is string=>typeof value==='string'&&value.length>0))],character_i:Number(x.character_i),modes:['fast','roleplay']} as WebCharacter;
  });
 }
 async getCharacter(userId: string, characterId: number) {const c=(await this.listCharacters(userId)).find(x=>x.character_i===characterId);if(!c)throw new WebError(404,'character_not_found');return c;}
 async listChats(userId:string){return this.listChatSummaries(userId);}
 async listChatSummaries(userId:string):Promise<WebChatSummary[]>{
  const result=await rows(this.query,`WITH owned_chats AS (${chatSelect} WHERE c.user_id=$1 AND c.character_i IS NOT NULL AND c.is_active),
   ${WEB_SUMMARY_HISTORY_CTE},
   latest AS (SELECT DISTINCT ON (chat_id) chat_id,to_jsonb(h)||jsonb_build_object('created_text',created_at::text) AS last_message FROM history h ORDER BY chat_id,created_at DESC,id DESC),
   unread AS (SELECT h.chat_id,count(*)::int AS unread_count FROM history h LEFT JOIN app_private.web_activity a USING(chat_id)
    WHERE h.role='assistant' AND (h.created_at,h.id)>(COALESCE(a.last_read_at,'-infinity'::timestamptz),COALESCE(a.last_read_message_id,'')) GROUP BY h.chat_id)
   SELECT c.*,l.last_message,COALESCE(n.unread_count,0) AS unread_count,a.last_read_message_id FROM owned_chats c
   LEFT JOIN latest l USING(chat_id) LEFT JOIN unread n USING(chat_id) LEFT JOIN app_private.web_activity a USING(chat_id) ORDER BY c.updated_at DESC`,[userId]);
  return result.map(row=>({...publicChat(row),last_message:row.last_message?mapHistoryMessage(row.last_message):null,unread_count:Number(row.unread_count),last_read_message_id:row.last_read_message_id??null}));
 }
 private async owned(db: DB,userId:string,code:string,lock=false): Promise<Row> {
  const c=(await rows(db,chatSelect+` WHERE c.user_id=$1 AND c.chat_code=$2 AND c.character_i IS NOT NULL AND c.is_active`+(lock?' FOR UPDATE OF c':''),[userId,code]))[0];
  if(!c)throw new WebError(404,'chat_not_found'); return c;
 }
 async getChat(userId:string,code:string){return publicChat(await this.owned(this.query,userId,code));}
 private async consents(db:DB,userId:string){await this.lockWebAccount(db,userId);const u=(await rows(db,`SELECT language_confirmed_at,age_confirmed_at,terms_accepted_at FROM public.users WHERE user_id=$1`,[userId]))[0];if(!u?.terms_accepted_at&&!u?.language_confirmed_at)throw new WebError(403,'language_selection_required');if(!u?.age_confirmed_at||!u?.terms_accepted_at)throw new WebError(403,'consent_required');}
 async createChat(userId:string,characterId:number,mode:SceneMode,clientId:string) {
  return this.query.begin(async tx=>{
   await this.consents(tx,userId);
   const valid=await rows(tx,`SELECT 1 FROM public.characters WHERE character_i=$1`,[characterId]);if(!valid.length)throw new WebError(404,'character_not_found');
   await rows(tx,`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,['chat:'+userId+':'+characterId]);
   let c=(await rows(tx,chatSelect+` WHERE c.user_id=$1 AND c.character_i=$2 AND c.is_active FOR UPDATE OF c`,[userId,characterId]))[0];
   if(c){const start=(await rows(tx,`SELECT * FROM app_private.web_operations WHERE chat_id=$1 AND action='scene_start' ORDER BY created_at LIMIT 1`,[c.chat_id]))[0];return {chat:publicChat(c),operation:start?operation(start,c.chat_code):null};}
   const inserted=(await rows(tx,`INSERT INTO public.chat_state(source,user_id,character_i,selected_character_i) VALUES('web',$1,$2,$2) ON CONFLICT(user_id,character_i) WHERE user_id IS NOT NULL AND character_i IS NOT NULL AND is_active DO NOTHING RETURNING chat_code`,[userId,characterId]))[0];
   // A Telegram writer need not take our advisory lock. If it won the unique-key race,
   // use its permanent chat without generating a new scene in that existing history.
   if(!inserted){
    c=(await rows(tx,chatSelect+` WHERE c.user_id=$1 AND c.character_i=$2 AND c.is_active FOR UPDATE OF c`,[userId,characterId]))[0];
    if(!c)throw new WebError(409,'chat_creation_conflict');
    const start=(await rows(tx,`SELECT * FROM app_private.web_operations WHERE chat_id=$1 AND action='scene_start' ORDER BY sequence_no LIMIT 1`,[c.chat_id]))[0];
    return {chat:publicChat(c),operation:start?operation(start,c.chat_code):null};
   }
   c=await this.owned(tx,userId,inserted.chat_code,true);
   const op=await this.insertOperation(tx,userId,c,'scene_start',clientId,mode);
   return {chat:publicChat(c),operation:op};
  });
 }
 private async insertOperation(db:DB,userId:string,c:Row,action:WebAction,clientId:string,mode:SceneMode,text?:string):Promise<WebOperation>{
  const data={client_message_id:clientId,...(text===undefined?{}:{user_message:text})};
  const fingerprint=createHash('sha256').update(JSON.stringify({action,...(['scene_start','reset'].includes(action) ? {mode} : {}),data})).digest('hex');
  const existing=(await rows(db,`SELECT * FROM app_private.web_operations WHERE chat_id=$1 AND client_message_id=$2`,[c.chat_id,clientId]))[0];
  if(existing){
   // Retain retry compatibility for resets accepted before mode was part of the
   // fingerprint. Their immutable envelope still binds the original mode.
   const legacy=action==='reset'&&existing.envelope?.scene_mode===mode
    &&existing.fingerprint===createHash('sha256').update(JSON.stringify({action,data})).digest('hex');
   if(existing.fingerprint!==fingerprint&&!legacy)throw new WebError(409,'idempotency_conflict');
   return operation(existing,c.chat_code);
  }
  if(action==='message'){
   const access=(await rows(db,`SELECT (u.subscription_until>now()) OR EXISTS(SELECT 1 FROM public.chat_scene_sessions s WHERE s.chat_id=$1 AND s.scene_session_id=c.active_scene_session_id AND s.scene_access_unlocked_at IS NOT NULL) AS unlimited FROM public.chat_state c JOIN public.users u ON u.user_id=c.user_id WHERE c.chat_id=$1`,[c.chat_id]))[0];
   const usage=(await rows(db,`SELECT (SELECT count(*) FROM public.chat_turns WHERE chat_id=$1 AND message_type<>'command' AND (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date) + (SELECT count(*) FROM app_private.web_operations o WHERE o.chat_id=$1 AND (o.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date AND action='message' AND status IN ('accepted','delivering','delivered','processing') AND NOT EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.chat_id=o.chat_id AND m.source_event_id=o.event_id::text)) AS used`,[c.chat_id,config.BUSINESS_TIME_ZONE]))[0];
   if(!access?.unlimited&&Number(usage?.used)>=config.TURN_LIMIT)throw new WebError(429,'turn_limit');
  }
  const eventId=randomUUID();
  const envelope:WebDeliveryEvent={event_id:eventId,user_id:userId,chat_id:Number(c.chat_id),character_i:Number(c.character_i),scene_mode:mode,source:'web',action,data};
  const r=(await rows(db,`INSERT INTO app_private.web_operations(event_id,user_id,chat_id,client_message_id,action,fingerprint,envelope) VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb) RETURNING *`,[eventId,userId,c.chat_id,clientId,action,fingerprint,JSON.stringify(envelope)]))[0]!;
  await rows(db,`INSERT INTO app_private.web_activity(chat_id,last_web_at) VALUES($1,now()) ON CONFLICT(chat_id) DO UPDATE SET last_web_at=EXCLUDED.last_web_at`,[c.chat_id]);
  return operation(r,c.chat_code);
 }
 async enqueue(userId:string,code:string,action:'message'|'reset',clientId:string,text?:string,requestedMode?:SceneMode){
  return this.query.begin(async tx=>{const c=await this.owned(tx,userId,code,true);await this.consents(tx,userId);
   let mode:SceneMode=action==='reset'&&requestedMode?requestedMode:c.scene_mode;
   if(action==='reset'&&!requestedMode){const previous=(await rows(tx,`SELECT envelope->>'scene_mode' AS mode FROM app_private.web_operations WHERE chat_id=$1 AND client_message_id=$2 AND action='reset'`,[c.chat_id,clientId]))[0];if(previous?.mode)mode=previous.mode;}
   if(!mode){const start=(await rows(tx,`SELECT envelope->>'scene_mode' AS mode FROM app_private.web_operations WHERE chat_id=$1 AND action='scene_start' ORDER BY created_at LIMIT 1`,[c.chat_id]))[0];mode=start?.mode??'roleplay';}
   return this.insertOperation(tx,userId,c,action,clientId,mode,text);
  });
 }
 async history(userId:string,code:string,before?:string,limit=50):Promise<{messages:WebMessage[];next_before:string|null;event_cursor:string;quick_replies:WebQuickReplies|null}>{
  return this.query.begin('isolation level repeatable read read only',async tx=>{
   const c=await this.owned(tx,userId,code),cursor=decodeHistoryCursor(before),size=Math.min(100,Math.max(1,limit));
   const result=await rows(tx,WEB_HISTORY_CTE+` SELECT *,created_at::text AS created_text FROM history
    WHERE ($2::text::timestamptz IS NULL OR (created_at,id)<($2::text::timestamptz,$3::text))
    ORDER BY created_at DESC,id DESC LIMIT $4`,[c.chat_id,cursor?.[0]??null,cursor?.[1]??null,size+1]);
   const selected=result.slice(0,size),last=selected.at(-1),catalog=new MediaCatalogRepository(tx as unknown as typeof sql);
   const media=await catalog.loadPhotosByUuid(selected.filter(row=>row.media_kind==='photo'&&row.media_id).map(row=>String(row.media_id)));
   const messages=selected.reverse().map(row=>{const message=mapHistoryMessage(row);if(message.media_kind==='photo'&&message.media_id)message.photo_url=media.get(message.media_id)?.photo_url??null;return message;});
   const [snapshot]=await rows(tx,`SELECT (SELECT value::text FROM app_private.web_event_counters WHERE chat_id=$1) AS value,
    CASE WHEN q.data IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.chat_id=$1
      AND m.scene_session_id=$2 AND m.sender_type='user' AND m.direction='inbound'
      AND m.created_at>=(q.data->>'published_at')::timestamptz) THEN q.data ELSE NULL END AS quick
    FROM (SELECT COALESCE(s.opening_replies_json->'web_current',
      (SELECT e.data||jsonb_build_object('published_at',e.created_at) FROM app_private.web_events e
       WHERE e.chat_id=$1 AND e.type='quick_replies' AND e.data->>'scene_session_id'=$2 ORDER BY e.cursor DESC LIMIT 1)) AS data
      FROM public.chat_scene_sessions s WHERE s.chat_id=$1 AND s.scene_session_id=$2) q`,[c.chat_id,c.scene_session_id]);
   const quick=snapshot?.quick?parseStored(quickRepliesSchema,snapshot.quick):null;
   // A chat can exist before its scene starts; the counter still belongs to the
   // same read snapshot even when there is no quick-reply scene row yet.
   const counter=snapshot??(await rows(tx,'SELECT value::text FROM app_private.web_event_counters WHERE chat_id=$1',[c.chat_id]))[0];
   return {messages,next_before:result.length>size&&last?encodeHistoryCursor(last):null,event_cursor:counter?.value??'0',quick_replies:quick};
  });
 }
 async events(userId:string,code:string,after='0',limit=100,operationIds:string[]=[]):Promise<{events:WebEvent[];cursor:string;operations:WebOperation[]}>{
  if(!/^\d{1,19}$/.test(after)||BigInt(after)>9223372036854775807n)throw new WebError(400,'invalid_event_cursor');
  if(operationIds.length>50||operationIds.some(id=>!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))))throw new WebError(400,'invalid_operation_ids');
  return this.query.begin('isolation level repeatable read read only',async tx=>{
   const c=await this.owned(tx,userId,code);
   const [bounds]=await rows(tx,`SELECT COALESCE((SELECT value FROM app_private.web_event_counters WHERE chat_id=$1),0)::text AS high,
     (SELECT min(cursor) FROM app_private.web_events WHERE chat_id=$1)::text AS low`,[c.chat_id]);
   const high=BigInt(bounds!.high),low=bounds!.low==null?high+1n:BigInt(bounds!.low);
   if(BigInt(after)>high||(BigInt(after)<low-1n))throw new WebError(409,'event_cursor_gap');
   const events=await rows(tx,`SELECT e.cursor::text,e.type,e.data,e.created_at::text FROM app_private.web_events e WHERE e.chat_id=$1 AND e.cursor>$2::bigint ORDER BY e.cursor LIMIT $3`,[c.chat_id,after,Math.min(100,Math.max(1,limit))]);
   // A missing retained cursor must never advance a client past an unseen effect.
   let expected=BigInt(after)+1n;
   for(const event of events){if(BigInt(event.cursor)!==expected)throw new WebError(409,'event_cursor_gap');expected=BigInt(event.cursor)+1n;}
   const operations=operationIds.length?await tx.unsafe<Row[]>('SELECT event_id,client_message_id,status,action,error_code FROM app_private.web_operations WHERE user_id=$1 AND chat_id=$2 AND event_id=ANY($3::uuid[])',[userId,c.chat_id,operationIds]):[];
   return {events:events.map(event=>parseStored(eventSchema,{...event,created_at:iso(event.created_at)!})),cursor:events.at(-1)?.cursor??after,operations:operations.map(row=>operation(row,code))};
  });
 }
 async continuation(userId:string,code:string){
  const c=await this.owned(this.query,userId,code);const activity=(await rows(this.query,`SELECT last_web_at,last_telegram_at,(last_telegram_at IS NOT NULL AND (last_web_at IS NULL OR last_telegram_at>last_web_at)) AS telegram_is_newer FROM app_private.web_activity WHERE chat_id=$1`,[c.chat_id]))[0];
  const h=(await this.history(userId,code,undefined,100)).messages;
  const selected=new Set([...h.filter(x=>x.role==='user').slice(-2),...h.filter(x=>x.role==='assistant').slice(-2)].map(x=>x.id));
  const telegramLatest=activity?.last_telegram_at??h.filter(x=>x.source==='telegram').at(-1)?.created_at;
  const offered=activity?.last_telegram_at?activity.telegram_is_newer:!!telegramLatest&&(!activity?.last_web_at||new Date(telegramLatest).getTime()>new Date(activity.last_web_at).getTime());
  return {offered,separator:'---',messages:offered?h.filter(x=>selected.has(x.id)):[],chat:publicChat(c)};
 }
 async claimNext(input:{leaseToken:string;leaseMs:number;maxAttempts:number;now:Date}){
  return this.query.begin(async tx=>{
   const now=input.now.toISOString();
   const due=`((status IN ('accepted','delivering') AND next_attempt_at<=$1::timestamptz AND (lease_until IS NULL OR lease_until<$1::timestamptz)) OR (status IN ('delivered','processing') AND updated_at<$1::timestamptz-interval '5 minutes'))`;
   const candidates=await rows(tx,`SELECT candidate.event_id,candidate.chat_id FROM app_private.web_operations candidate WHERE ${due}
    AND NOT EXISTS(SELECT 1 FROM app_private.web_operations prior WHERE prior.chat_id=candidate.chat_id AND prior.sequence_no<candidate.sequence_no
      AND (prior.status IN ('accepted','delivering') OR (prior.action IN ('scene_start','reset') AND prior.status IN ('delivered','processing'))))
    ORDER BY candidate.sequence_no LIMIT 100`,[now]);
   for(const candidate of candidates){
    // All engine and Gateway writers take chat -> operation -> event-counter locks.
    // Taking an operation first deadlocks against the event journal's chat FK lock.
    if(!(await rows(tx,`SELECT chat_id FROM public.chat_state WHERE chat_id=$1 FOR UPDATE SKIP LOCKED`,[candidate.chat_id])).length)continue;
    const o=(await rows(tx,`SELECT * FROM app_private.web_operations WHERE ${due} AND event_id=$2::uuid FOR UPDATE SKIP LOCKED`,[now,candidate.event_id]))[0];
    if(!o)continue;
    const recovery=['delivered','processing'].includes(o.status);
    if(o.attempts>=input.maxAttempts){
     await this.terminalFailure(tx,o.event_id,recovery?'engine_attempts_exhausted':'delivery_attempts_exhausted',now);continue;
    }
    if((await rows(tx,`SELECT 1 FROM app_private.web_operations WHERE chat_id=$1 AND sequence_no<$2 AND (status IN ('accepted','delivering') OR (action IN ('scene_start','reset') AND status IN ('delivered','processing'))) LIMIT 1`,[o.chat_id,o.sequence_no])).length)continue;
    const r=(await rows(tx,`UPDATE app_private.web_operations SET status='delivering',attempts=attempts+1,lease_token=$2::uuid,lease_until=$3::timestamptz+($4::integer*interval '1 millisecond'),error_code=CASE WHEN $5 THEN 'engine_processing_recovery' ELSE error_code END,updated_at=$3::timestamptz WHERE event_id=$1::uuid RETURNING envelope,attempts`,[o.event_id,input.leaseToken,now,input.leaseMs,recovery]))[0]!;
    return {event:r.envelope as WebDeliveryEvent,attempts:Number(r.attempts),leaseToken:input.leaseToken};
   }
   return null;
  });
 }
 private async terminalFailure(db:DB,eventId:string,error:string,now:string,leaseToken?:string){
  const [operation]=await rows(db,`SELECT * FROM app_private.web_operations WHERE event_id=$1::uuid
    AND ($2::uuid IS NULL OR (lease_token=$2::uuid AND status='delivering')) FOR UPDATE`,[eventId,leaseToken??null]);
  if(!operation)return;
  const pending=await rows(db,`SELECT m.id,m.debounce_revision,m.scene_session_id,c.active_scene_session_id,c.debounce_revision AS current_revision
   FROM public.chat_messages m JOIN public.chat_state c USING(chat_id) WHERE m.chat_id=$1 AND m.source='web' AND m.source_event_id=$2
   AND m.sender_type='user' AND m.direction='inbound' AND m.processing_status IN ('pending','batched')`,[operation.chat_id,eventId]);
  const batched=pending.some(row=>row.scene_session_id===row.active_scene_session_id&&Number(row.debounce_revision)<Number(row.current_revision));
  const newer=batched&&(await rows(db,`SELECT 1 FROM public.chat_messages m JOIN public.chat_state c USING(chat_id)
   LEFT JOIN app_private.web_operations o ON o.chat_id=m.chat_id AND o.event_id::text=m.source_event_id
   WHERE m.chat_id=$1 AND m.scene_session_id=c.active_scene_session_id AND m.debounce_revision=c.debounce_revision
    AND m.sender_type='user' AND m.direction='inbound' AND m.processing_status IN ('pending','batched')
    AND ((m.source='web' AND o.sequence_no>$2 AND o.status IN ('delivering','delivered','processing'))
      OR (m.source<>'web' AND m.created_at>$3::timestamptz-interval '5 minutes')) LIMIT 1`,[operation.chat_id,operation.sequence_no,now])).length>0;
  if(newer){await rows(db,`UPDATE app_private.web_operations SET status='processing',error_code='engine_processing_recovery',lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE event_id=$1::uuid`,[eventId,now]);return;}
  // Drop only the exhausted inbound effect and invalidate its still-current
  // Writer revision. An expired mixed-channel batch is invalidated as well;
  // a live newer inbound is protected by the bounded defer above.
  await rows(db,`UPDATE public.chat_state c SET debounce_revision=c.debounce_revision+1 WHERE c.chat_id=$1 AND EXISTS(
   SELECT 1 FROM public.chat_messages m WHERE m.chat_id=c.chat_id AND m.source='web' AND m.source_event_id=$2 AND m.sender_type='user'
    AND m.processing_status IN ('pending','batched') AND m.scene_session_id=c.active_scene_session_id
    AND (m.debounce_revision=c.debounce_revision OR (m.debounce_revision<c.debounce_revision AND EXISTS(
     SELECT 1 FROM public.chat_messages latest WHERE latest.chat_id=c.chat_id AND latest.scene_session_id=c.active_scene_session_id
      AND latest.debounce_revision=c.debounce_revision AND latest.sender_type='user' AND latest.direction='inbound'
      AND latest.processing_status IN ('pending','batched')))))`,[operation.chat_id,eventId]);
  await rows(db,`UPDATE public.chat_messages SET processing_status='dropped' WHERE chat_id=$1 AND source='web' AND source_event_id=$2
   AND sender_type='user' AND direction='inbound' AND processing_status IN ('pending','batched')`,[operation.chat_id,eventId]);
  await rows(db,`UPDATE app_private.web_operations SET status='failed',error_code=$2,lease_token=NULL,lease_until=NULL,updated_at=$3::timestamptz WHERE event_id=$1::uuid`,[eventId,error,now]);
 }
 private async settle(eventId:string,work:(tx:DB)=>Promise<unknown>){await this.query.begin(async tx=>{await rows(tx,`SELECT chat_id FROM public.chat_state WHERE chat_id=(SELECT chat_id FROM app_private.web_operations WHERE event_id=$1::uuid) FOR UPDATE`,[eventId]);await work(tx);});}
 async settleDelivered(eventId:string,leaseToken:string,now:Date){await this.settle(eventId,tx=>rows(tx,`UPDATE app_private.web_operations SET status='delivered',lease_token=NULL,lease_until=NULL,error_code=CASE WHEN error_code='engine_processing_recovery' THEN error_code ELSE NULL END,updated_at=$3::timestamptz WHERE event_id=$1 AND lease_token=$2::uuid AND status='delivering'`,[eventId,leaseToken,now.toISOString()]));}
 async settleFailure(eventId:string,leaseToken:string,failure:{code:string;retryAt:Date|null;terminal:boolean},now:Date){await this.settle(eventId,tx=>failure.terminal
  ?this.terminalFailure(tx,eventId,failure.code,now.toISOString(),leaseToken)
  :rows(tx,`UPDATE app_private.web_operations SET status='accepted',error_code=CASE WHEN error_code='engine_processing_recovery' THEN error_code ELSE $3 END,next_attempt_at=COALESCE($4::timestamptz,next_attempt_at),lease_token=NULL,lease_until=NULL,updated_at=$5::timestamptz WHERE event_id=$1 AND lease_token=$2::uuid AND status='delivering'`,[eventId,leaseToken,failure.code,failure.retryAt?.toISOString()??null,now.toISOString()]));}

}
