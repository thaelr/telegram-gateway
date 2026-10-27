import { createHash, randomUUID } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../config.js';
import { languageFromLocale } from './auth.js';
import type { WebDeliveryStore } from './delivery.js';
import { WebError, type WebRepositoryContract, type WebIdentity, type WebProfile, type WebChat, type WebCharacter, type WebAction, type SceneMode, type WebOperation, type WebMessage, type WebEvent, type WebDeliveryEvent } from './types.js';

type DB = Pick<typeof sql, 'unsafe'>;
type Param = string | number | boolean | null;
type Row = Record<string, any>;
async function rows(db: DB, text: string, values: Param[] = []): Promise<Row[]> { return db.unsafe(text, values); }
const chatSelect = `SELECT c.chat_id, c.chat_code, c.character_i, s.scene_mode, c.active_scene_session_id AS scene_session_id, c.current_turn_no AS turn_no,c.scene_turn_no,c.updated_at::text FROM public.chat_state c LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id`;
function iso(value: unknown): string | null { return value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function publicChat(r: Row): WebChat { return {chat_code:r.chat_code,character_i:Number(r.character_i),scene_mode:r.scene_mode,scene_session_id:r.scene_session_id,turn_no:Number(r.turn_no),scene_turn_no:Number(r.scene_turn_no),updated_at:iso(r.updated_at)!}; }
function operation(r: Row, code: string): WebOperation { return {operation_id:r.event_id,event_id:r.event_id,status:r.status,action:r.action,chat_code:code}; }
export const initialLanguage = languageFromLocale;

export class WebRepository implements WebRepositoryContract, WebDeliveryStore {
 constructor(private readonly query: typeof sql = sql) {}
 async resolveIdentity(authUserId: string) { const r=await rows(this.query,`SELECT user_id FROM public.user_identities WHERE provider='supabase' AND external_id=$1`,[authUserId]); return r[0]?.user_id??null; }
 async bootstrap(identity: WebIdentity): Promise<WebProfile> {
  const userId = await this.query.begin(async tx => {
   await rows(tx,`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,['supabase:'+identity.auth_user_id]);
   const found=await rows(tx,`SELECT user_id FROM public.user_identities WHERE provider='supabase' AND external_id=$1`,[identity.auth_user_id]);
   if(found[0]) return found[0].user_id as string;
   const created=await rows(tx,`INSERT INTO public.users(display_name,language) VALUES($1,$2) RETURNING user_id`,[identity.display_name,initialLanguage(identity.locale)]);
   const id=created[0]!.user_id as string;
   await rows(tx,`INSERT INTO public.user_identities(user_id,provider,external_id) VALUES($1,'supabase',$2)`,[id,identity.auth_user_id]);
   return id;
  });
  return this.getMe(userId);
 }
 async getMe(userId: string): Promise<WebProfile> {
  const r=(await rows(this.query,`SELECT user_id,display_name,language,age_confirmed_at::text,terms_accepted_at::text,subscription_sku,subscription_until::text,entitlements_jsonb AS entitlements FROM public.users WHERE user_id=$1`,[userId]))[0];
  if(!r) throw new WebError(401,'account_not_found');
  return {...r,age_confirmed_at:iso(r.age_confirmed_at),terms_accepted_at:iso(r.terms_accepted_at),subscription_until:iso(r.subscription_until),needs_language_selection:r.language==null} as WebProfile;
 }
 async updateMe(userId: string, patch: {display_name?:string;language?:'ru'|'en'}) {
  await rows(this.query,`UPDATE public.users SET display_name=CASE WHEN $2 THEN $3 ELSE display_name END,language=CASE WHEN $4 THEN $5 ELSE language END,updated_at=now() WHERE user_id=$1`,[userId,patch.display_name!==undefined,patch.display_name??null,patch.language!==undefined,patch.language??null]);
  return this.getMe(userId);
 }
 async confirmAge(userId: string) { await rows(this.query,`SELECT app_private.confirm_user_age($1::varchar)`,[userId]);return this.getMe(userId); }
 async acceptTerms(userId: string) { await rows(this.query,`UPDATE public.users SET terms_accepted_at=COALESCE(terms_accepted_at,now()),updated_at=now() WHERE user_id=$1`,[userId]);return this.getMe(userId); }
 async listCharacters(userId: string): Promise<WebCharacter[]> {
  const r=await rows(this.query,`SELECT ch.character_i,ch.name,ch.description,COALESCE(ch.menu_photo_url,ch.gallery_photo_url) AS image_url,c.chat_code FROM public.characters ch LEFT JOIN public.chat_state c ON c.user_id=$1 AND c.character_i=ch.character_i AND c.is_active ORDER BY ch.character_i`,[userId]);
  return r.map(x=>({...x,character_i:Number(x.character_i),modes:['fast','roleplay']}) as WebCharacter);
 }
 async getCharacter(userId: string, characterId: number) {const c=(await this.listCharacters(userId)).find(x=>x.character_i===characterId);if(!c)throw new WebError(404,'character_not_found');return c;}
 async listChats(userId: string) {return (await rows(this.query,chatSelect+` WHERE c.user_id=$1 AND c.character_i IS NOT NULL AND c.is_active ORDER BY c.updated_at DESC`,[userId])).map(publicChat);}
 private async owned(db: DB,userId:string,code:string,lock=false): Promise<Row> {
  const c=(await rows(db,chatSelect+` WHERE c.user_id=$1 AND c.chat_code=$2 AND c.character_i IS NOT NULL AND c.is_active`+(lock?' FOR UPDATE OF c':''),[userId,code]))[0];
  if(!c)throw new WebError(404,'chat_not_found'); return c;
 }
 async getChat(userId:string,code:string){return publicChat(await this.owned(this.query,userId,code));}
 private async consents(db:DB,userId:string){const u=(await rows(db,`SELECT age_confirmed_at,terms_accepted_at FROM public.users WHERE user_id=$1`,[userId]))[0];if(!u?.age_confirmed_at||!u?.terms_accepted_at)throw new WebError(403,'consent_required');}
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
  const fingerprint=createHash('sha256').update(JSON.stringify({action,...(action === 'scene_start' ? {mode} : {}),data})).digest('hex');
  const existing=(await rows(db,`SELECT * FROM app_private.web_operations WHERE chat_id=$1 AND client_message_id=$2`,[c.chat_id,clientId]))[0];
  if(existing){if(existing.fingerprint!==fingerprint)throw new WebError(409,'idempotency_conflict');return operation(existing,c.chat_code);}
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
 async enqueue(userId:string,code:string,action:'message'|'reset',clientId:string,text?:string){
  return this.query.begin(async tx=>{const c=await this.owned(tx,userId,code,true);await this.consents(tx,userId);
   let mode:SceneMode=c.scene_mode;
   if(!mode){const start=(await rows(tx,`SELECT envelope->>'scene_mode' AS mode FROM app_private.web_operations WHERE chat_id=$1 AND action='scene_start' ORDER BY created_at LIMIT 1`,[c.chat_id]))[0];mode=start?.mode??'roleplay';}
   return this.insertOperation(tx,userId,c,action,clientId,mode,text);
  });
 }
 async history(userId:string,code:string,before?:string,limit=50):Promise<{messages:WebMessage[];next_before:string|null}>{
  const c=await this.owned(this.query,userId,code);
  let cursor:[number,number,string]=[Number.MAX_SAFE_INTEGER,2,'~'];
  if(before){try{const v=JSON.parse(Buffer.from(before,'base64url').toString());if(!Array.isArray(v)||v.length!==3||!Number.isSafeInteger(v[0])||![0,1].includes(v[1])||typeof v[2]!=='string'||!/^([mut]):\d+$/.test(v[2])||BigInt(v[2].slice(2))>9223372036854775807n)throw 0;cursor=[v[0],v[1],v[2]];}catch{throw new WebError(400,'invalid_history_cursor');}}
  const r=await rows(this.query,`WITH history AS (
   SELECT 'm:'||m.id AS id,'user' AS role,m.message_text AS text,m.source,m.scene_session_id,m.turn_no::bigint AS turn_no,m.created_at,0 AS role_order FROM public.chat_messages m WHERE m.chat_id=$1 AND m.sender_type='user' AND m.message_text IS NOT NULL
   UNION ALL SELECT 'u:'||t.n,'user',t.user_message,'telegram',t.scene_session_id,t.n,t.created_at,0 FROM public.chat_turns t WHERE t.chat_id=$1 AND t.user_message IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.chat_id=t.chat_id AND m.turn_no=t.n AND m.sender_type='user')
   UNION ALL SELECT 't:'||t.n,'assistant',t.assistant_text,COALESCE((SELECT m.source FROM public.chat_messages m WHERE m.chat_id=t.chat_id AND m.turn_no=t.n AND m.sender_type='user' ORDER BY m.id DESC LIMIT 1),'telegram'),t.scene_session_id,t.n,COALESCE(t.sent_at,t.updated_at),1 FROM public.chat_turns t WHERE t.chat_id=$1 AND t.assistant_text IS NOT NULL
   UNION ALL SELECT 't:'||m.turn_no,'assistant',m.message_text,m.source,m.scene_session_id,m.turn_no,m.created_at,1 FROM public.chat_messages m WHERE m.chat_id=$1 AND m.sender_type='assistant' AND m.event_type IS DISTINCT FROM 'scene.start.greeting' AND m.message_text IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chat_turns t WHERE t.chat_id=m.chat_id AND t.n=m.turn_no AND t.assistant_text IS NOT NULL)
   UNION ALL SELECT 'm:'||m.id,'assistant',m.message_text,m.source,m.scene_session_id,m.turn_no,m.created_at,1 FROM public.chat_messages m WHERE m.chat_id=$1 AND m.sender_type='assistant' AND m.event_type='scene.start.greeting' AND m.message_text IS NOT NULL
  ) SELECT *,created_at::text AS created_text FROM history WHERE (turn_no,role_order,substring(id FROM 3)::bigint)<($2::bigint,$3::integer,$4::bigint) ORDER BY turn_no DESC,role_order DESC,substring(id FROM 3)::bigint DESC LIMIT $5`,[c.chat_id,cursor[0],cursor[1],cursor[2]==='~'?'9223372036854775807':cursor[2].slice(2),Math.min(100,Math.max(1,limit))+1]);
  const more=r.length>limit;const selected=r.slice(0,limit);const last=selected.at(-1);
  return {messages:selected.reverse().map(x=>({id:x.id,role:x.role,text:x.text,source:x.source,scene_session_id:x.scene_session_id,turn_no:Number(x.turn_no),created_at:iso(x.created_text)!})),next_before:more&&last?Buffer.from(JSON.stringify([Number(last.turn_no),Number(last.role_order),last.id])).toString('base64url'):null};
 }
 async events(userId:string,code:string,after='0',limit=100):Promise<{events:WebEvent[];cursor:string}>{
  if(!/^\d{1,19}$/.test(after)||BigInt(after)>9223372036854775807n)throw new WebError(400,'invalid_event_cursor');
  const c=await this.owned(this.query,userId,code);
  const r=await rows(this.query,`SELECT cursor::text,type,data,created_at::text FROM app_private.web_events WHERE chat_id=$1 AND cursor>$2::bigint ORDER BY cursor LIMIT $3`,[c.chat_id,after,Math.min(100,Math.max(1,limit))]);
  return {events:r.map(event=>({...event,created_at:iso(event.created_at)!})) as WebEvent[],cursor:r.at(-1)?.cursor??after};
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
   const candidates=await rows(tx,`SELECT event_id,chat_id FROM app_private.web_operations WHERE ${due} ORDER BY sequence_no`,[now]);
   for(const candidate of candidates){
    // All engine and Gateway writers take chat -> operation -> event-counter locks.
    // Taking an operation first deadlocks against the event journal's chat FK lock.
    if(!(await rows(tx,`SELECT chat_id FROM public.chat_state WHERE chat_id=$1 FOR UPDATE SKIP LOCKED`,[candidate.chat_id])).length)continue;
    const o=(await rows(tx,`SELECT * FROM app_private.web_operations WHERE ${due} AND event_id=$2::uuid FOR UPDATE SKIP LOCKED`,[now,candidate.event_id]))[0];
    if(!o)continue;
    const recovery=['delivered','processing'].includes(o.status);
    if(o.attempts>=input.maxAttempts){
     await rows(tx,`UPDATE app_private.web_operations SET status='failed',error_code=$2,lease_token=NULL,lease_until=NULL,updated_at=$3::timestamptz WHERE event_id=$1::uuid`,[o.event_id,recovery?'engine_attempts_exhausted':'delivery_attempts_exhausted',now]);continue;
    }
    if((await rows(tx,`SELECT 1 FROM app_private.web_operations WHERE chat_id=$1 AND sequence_no<$2 AND (status IN ('accepted','delivering') OR (action IN ('scene_start','reset') AND status IN ('delivered','processing'))) LIMIT 1`,[o.chat_id,o.sequence_no])).length)continue;
    const r=(await rows(tx,`UPDATE app_private.web_operations SET status='delivering',attempts=attempts+1,lease_token=$2::uuid,lease_until=$3::timestamptz+($4::integer*interval '1 millisecond'),error_code=CASE WHEN $5 THEN 'engine_processing_recovery' ELSE error_code END,updated_at=$3::timestamptz WHERE event_id=$1::uuid RETURNING envelope,attempts`,[o.event_id,input.leaseToken,now,input.leaseMs,recovery]))[0]!;
    return {event:r.envelope as WebDeliveryEvent,attempts:Number(r.attempts),leaseToken:input.leaseToken};
   }
   return null;
  });
 }
 private async settle(eventId:string,work:(tx:DB)=>Promise<unknown>){await this.query.begin(async tx=>{await rows(tx,`SELECT chat_id FROM public.chat_state WHERE chat_id=(SELECT chat_id FROM app_private.web_operations WHERE event_id=$1::uuid) FOR UPDATE`,[eventId]);await work(tx);});}
 async settleDelivered(eventId:string,leaseToken:string,now:Date){await this.settle(eventId,tx=>rows(tx,`UPDATE app_private.web_operations SET status='delivered',lease_token=NULL,lease_until=NULL,error_code=CASE WHEN error_code='engine_processing_recovery' THEN error_code ELSE NULL END,updated_at=$3::timestamptz WHERE event_id=$1 AND lease_token=$2::uuid AND status='delivering'`,[eventId,leaseToken,now.toISOString()]));}
 async settleFailure(eventId:string,leaseToken:string,failure:{code:string;retryAt:Date|null;terminal:boolean},now:Date){await this.settle(eventId,tx=>rows(tx,`UPDATE app_private.web_operations SET status=$3,error_code=CASE WHEN $3='accepted' AND error_code='engine_processing_recovery' THEN error_code ELSE $4 END,next_attempt_at=COALESCE($5::timestamptz,next_attempt_at),lease_token=NULL,lease_until=NULL,updated_at=$6::timestamptz WHERE event_id=$1 AND lease_token=$2::uuid AND status='delivering'`,[eventId,leaseToken,failure.terminal?'failed':'accepted',failure.code,failure.retryAt?.toISOString()??null,now.toISOString()]));}
}
