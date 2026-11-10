import { WebError, type WebMessage } from './types.js';

/** One projection of the existing journals, shared by history and unread summaries.
 * $1 is an already ownership-checked chat_id. No messages or URLs are copied to
 * another store. Delivery IDs are stable even when a signed URL is refreshed.
 */
export const WEB_HISTORY_CTE = `WITH history AS (
 SELECT 'm:'||m.id AS id,'user'::text AS role,m.message_text AS text,m.source,m.scene_session_id,
  COALESCE(m.turn_no,0)::bigint AS turn_no,m.created_at,
  NULL::text AS media_kind,NULL::text AS media_id,NULL::text AS video_delivery_id,NULL::text AS photo_url,
  (SELECT o.client_message_id FROM app_private.web_operations o WHERE o.chat_id=m.chat_id AND o.event_id::text=m.source_event_id LIMIT 1) AS client_message_id
 FROM public.chat_messages m
 WHERE m.chat_id=$1 AND m.sender_type='user' AND m.message_text IS NOT NULL
 AND NOT (COALESCE(m.event_type,'') IN ('media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass') AND m.payload_json->>'uuid' IS NOT NULL)
 UNION ALL
 SELECT 'u:'||t.n,'user',t.user_message,'telegram',t.scene_session_id,t.n,t.created_at,NULL,NULL,NULL,NULL,NULL
 FROM public.chat_turns t WHERE t.chat_id=$1 AND t.user_message IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.chat_id=t.chat_id AND m.turn_no=t.n AND m.sender_type='user')
 UNION ALL
 SELECT 't:'||t.n,'assistant',t.assistant_text,
  COALESCE((SELECT m.source FROM public.chat_messages m WHERE m.chat_id=t.chat_id AND m.turn_no=t.n AND m.sender_type='user' ORDER BY m.id DESC LIMIT 1),'telegram'),
  t.scene_session_id,t.n,COALESCE(t.sent_at,t.updated_at,t.created_at),NULL,NULL,NULL,NULL,NULL
 FROM public.chat_turns t WHERE t.chat_id=$1 AND t.assistant_text IS NOT NULL
 UNION ALL
 SELECT 't:'||m.turn_no,'assistant',m.message_text,m.source,m.scene_session_id,m.turn_no,m.created_at,NULL,NULL,NULL,NULL,NULL
 FROM public.chat_messages m WHERE m.chat_id=$1 AND m.sender_type='assistant'
 AND m.event_type IS DISTINCT FROM 'scene.start.greeting' AND m.message_text IS NOT NULL
 AND NOT (COALESCE(m.event_type,'') IN ('media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass') AND m.payload_json->>'uuid' IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.chat_turns t WHERE t.chat_id=m.chat_id AND t.n=m.turn_no AND t.assistant_text IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.chat_messages newer WHERE newer.chat_id=m.chat_id AND newer.turn_no=m.turn_no
   AND newer.sender_type='assistant' AND newer.event_type IS DISTINCT FROM 'scene.start.greeting'
   AND newer.message_text IS NOT NULL AND newer.id>m.id
   AND NOT (COALESCE(newer.event_type,'') IN ('media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass') AND newer.payload_json->>'uuid' IS NOT NULL))
 UNION ALL
 SELECT 'm:'||m.id,'assistant',m.message_text,m.source,m.scene_session_id,COALESCE(m.turn_no,0),m.created_at,NULL,NULL,NULL,NULL,NULL
 FROM public.chat_messages m WHERE m.chat_id=$1 AND m.sender_type='assistant' AND m.event_type='scene.start.greeting' AND m.message_text IS NOT NULL
 UNION ALL
 SELECT 'm:'||m.id,'assistant',COALESCE(m.message_text,''),m.source,m.scene_session_id,COALESCE(m.turn_no,0),m.created_at,
  'photo',m.payload_json->>'uuid',NULL,NULL,NULL
 FROM public.chat_messages m WHERE m.chat_id=$1 AND m.payload_json->>'uuid' IS NOT NULL
 AND m.event_type IN ('media.photo.unlocked.free','media.photo.unlocked.paid','media.photo.unlocked.subscription','media.photo.unlocked.scene_pass')
 UNION ALL
 SELECT 'v:'||d.delivery_id,'assistant','',d.source,d.scene_session_id,
  COALESCE((SELECT m.turn_no FROM public.chat_messages m WHERE m.chat_id=d.chat_id AND m.payload_json->>'panel_message_id'=d.photo_message_id::text ORDER BY m.id DESC LIMIT 1),
   (SELECT o.turn_no FROM app_private.web_media_offers o WHERE o.chat_id=d.chat_id AND o.panel_id=d.photo_message_id LIMIT 1),0),
  d.delivered_at,'video',d.video_id::text,d.delivery_id::text,NULL,NULL
 FROM app_private.video_deliveries d WHERE d.chat_id=$1 AND d.status='delivered' AND d.delivered_at IS NOT NULL
  AND d.requested_photo_uuid IS NULL
)`;

/** Same journal projection for every already-owned chat in one SQL statement. */
export const WEB_SUMMARY_HISTORY_CTE = WEB_HISTORY_CTE
 .replace('WITH history AS (','history AS (')
 .replaceAll('m.chat_id=$1','m.chat_id IN (SELECT chat_id FROM owned_chats)')
 .replaceAll('t.chat_id=$1','t.chat_id IN (SELECT chat_id FROM owned_chats)')
 .replaceAll('d.chat_id=$1','d.chat_id IN (SELECT chat_id FROM owned_chats)')
 .replaceAll("SELECT 'm:'||m.id", "SELECT m.chat_id,'m:'||m.id")
 .replaceAll("SELECT 'u:'||t.n", "SELECT t.chat_id,'u:'||t.n")
 .replaceAll("SELECT 't:'||t.n", "SELECT t.chat_id,'t:'||t.n")
 .replaceAll("SELECT 't:'||m.turn_no", "SELECT m.chat_id,'t:'||m.turn_no")
 .replaceAll("SELECT 'v:'||d.delivery_id", "SELECT d.chat_id,'v:'||d.delivery_id");

type HistoryRow = Record<string, any>;
function historyTimestamp(value:unknown):string {
 const raw=value instanceof Date?value.toISOString():String(value);
 const normalized=new Date(raw).toISOString();
 const fraction=/[T ]\d{2}:\d{2}:\d{2}\.(\d{1,6})/u.exec(raw)?.[1]??'000';
 // Fixed-width UTC text also preserves chronology in clients sorting ISO strings.
 return normalized.replace(/\.\d{3}Z$/u,'.'+fraction.padEnd(6,'0')+'Z');
}
export function mapHistoryMessage(row: HistoryRow): WebMessage {
 return {
  id:row.id,role:row.role,text:row.text??'',source:row.source,
  scene_session_id:row.scene_session_id,turn_no:Number(row.turn_no),
  created_at:historyTimestamp(row.created_text??row.created_at),
  ...(row.media_kind?{media_kind:row.media_kind,media_id:row.media_id}:{}),
  ...(row.video_delivery_id?{video_delivery_id:row.video_delivery_id}:{}),
  ...(row.client_message_id?{client_message_id:row.client_message_id}:{}),
  ...(row.media_kind==='photo'?{photo_url:row.photo_url??null}:{}),
 };
}

export function decodeHistoryCursor(before?:string):[string,string]|null {
 if(!before)return null;
 try {
  const value:unknown=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));
  if(!Array.isArray(value)||value.length!==3||value[0]!==2
   ||typeof value[1]!=='string'||value[1].length>64||!Number.isFinite(Date.parse(value[1]))
   ||typeof value[2]!=='string'||!(/^(?:[mut]:\d{1,19}|v:[0-9a-f-]{36})$/u.test(value[2])))throw 0;
  return [value[1],value[2]];
 } catch {throw new WebError(400,'invalid_history_cursor');}
}

export function encodeHistoryCursor(row:HistoryRow):string {
 // Preserve PostgreSQL microseconds in the cursor; Date.toISOString truncates them.
 return Buffer.from(JSON.stringify([2,row.created_text,row.id])).toString('base64url');
}

export function iso(value: unknown): string | null { return value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
