import { createHash, randomUUID } from 'node:crypto';
import { sql } from '../db.js';
import { signVideoUrl } from '../videoStorage.js';
import { WebError } from './types.js';

type Row = Record<string, any>;
type DB = Pick<typeof sql, 'unsafe'>;
const query = async (db: DB, statement: string, args: any[] = []): Promise<Row[]> => {
 try { return await db.unsafe(statement, args); }
 catch(error) {
  const code=(error as {code?:string})?.code;
  if(code==='42501')throw new WebError(403,'video_access_denied');
  if(code==='22023')throw new WebError(409,'video_context_changed');
  throw error;
 }
};
const iso = (value: unknown) => value == null ? null : new Date(String(value)).toISOString();
export const WEB_VIDEO_ACCESS_SECONDS = 120;
export type WebVideoContext = {
 video: { video_id: string; bucket_name: string; storage_path: string } | null;
 full_active: boolean; video_pass_active: boolean; panel_delivered: boolean; scene_active: boolean;
 delivery?: Row | null;
};
export type VideoPhotoContext = {chat_id: number; scene_session_id: string | null; character_i: number; media_signature: string; panel_id: number};

/** Uses the common Commerce delivery ledger. No Web video ownership library is created. */
export class WebVideoAccess {
 constructor(private readonly db: typeof sql = sql, private readonly signer = signVideoUrl, private readonly now: () => number = Date.now) {}
 async context(photo: VideoPhotoContext, db: DB = this.db): Promise<WebVideoContext> {
  const [row] = await query(db, 'SELECT public.media_video_context($1,$2,$3::integer,$4,$5) AS result', [photo.chat_id, photo.scene_session_id, photo.character_i, photo.media_signature, photo.panel_id]);
  return row!.result as WebVideoContext;
 }
 async contexts(photos:Array<VideoPhotoContext&{media_id:string}>):Promise<Map<string,WebVideoContext>>{
  if(!photos.length)return new Map();
  const result=await query(this.db,`SELECT p.media_id,public.media_video_context(p.chat_id,p.scene_session_id,p.character_i,p.media_signature,p.panel_id) AS result
    FROM jsonb_to_recordset($1::text::jsonb) AS p(media_id text,chat_id bigint,scene_session_id text,character_i integer,media_signature text,panel_id bigint)`,[JSON.stringify(photos)]);
  return new Map(result.map(row=>[row.media_id,row.result as WebVideoContext]));
 }
 async prepare(request: Record<string, unknown>, db: DB = this.db): Promise<Row> {
  const [row] = await query(db, 'SELECT public.media_prepare_video_delivery($1::text::jsonb) AS result', [JSON.stringify({...request, source: 'web'})]);
  if (row?.result?.status === 'duplicate_payment_requires_review') return row.result;
  if (!row?.result?.delivery_id) throw new WebError(409, row?.result?.reason ?? 'video_delivery_unavailable');
  return row.result;
 }
 requestKey(userId: string, code: string, mediaId: string, clientId: string) {
  return 'web-video:' + createHash('sha256').update(JSON.stringify([userId, code, mediaId, clientId])).digest('hex');
 }
 async byRequest(userId: string, key: string): Promise<Row | null> {
  return (await query(this.db, "SELECT * FROM app_private.video_deliveries WHERE user_id=$1 AND request_key=$2 AND source='web'", [userId, key]))[0] ?? null;
 }
 async owned(userId: string, id: string): Promise<Row> {
  const row = (await query(this.db, "SELECT d.* FROM app_private.video_deliveries d JOIN public.chat_state c ON c.chat_id=d.chat_id AND c.user_id=$1 WHERE d.user_id=$1 AND d.delivery_id=$2::uuid AND (d.source='web' OR d.status='delivered')", [userId, id]))[0];
  if (!row) throw new WebError(404, 'video_delivery_not_found');
  return row;
 }
 publicDelivery(row: Row) {
  return {delivery_id: row.delivery_id, video_id: row.video_id, status: row.status, ready_at: iso(row.eligible_at ?? row.ready_at), access_path: '/web/commerce/video-deliveries/' + row.delivery_id};
 }
 async access(userId: string, id: string) {
  let delivery = await this.owned(userId, id);
  if (delivery.status === 'delivered') return this.completedAccess(delivery);
  if (delivery.status === 'uncertain' || delivery.status === 'sending') return this.publicDelivery(delivery);
  if (new Date(String(delivery.eligible_at)).getTime() > this.now()) return this.publicDelivery(delivery);
  const claim = randomUUID();
  await query(this.db, 'SELECT public.media_claim_video_delivery($1::uuid,$2::uuid) AS result', [id, claim]);
  // Fetch after claiming: the claim token is the authority, never a client-provided status.
  delivery = await this.owned(userId, id);
  if (delivery.status === 'delivered') return this.completedAccess(delivery);
  if (delivery.status !== 'sending' || delivery.claim_token !== claim) return this.publicDelivery(delivery);
  let url: string;
  try {
   url = await this.signer(delivery.bucket_name, delivery.storage_path, WEB_VIDEO_ACCESS_SECONDS);
  } catch {
   await query(this.db, 'SELECT public.media_fail_video_delivery($1::uuid,$2::uuid,$3,true)', [id, claim, 'storage_signing_failed']);
   throw new WebError(503, 'video_delivery_retryable');
  }
  await query(this.db, 'SELECT public.media_complete_video_delivery($1::uuid,$2::uuid,NULL::bigint)', [id, claim]);
  delivery = await this.owned(userId, id);
  if (delivery.status !== 'delivered') throw new WebError(503, 'video_delivery_pending');
  return {...this.publicDelivery(delivery), video_url: url, expires_at: new Date(this.now() + WEB_VIDEO_ACCESS_SECONDS * 1000).toISOString()};
 }
 private async completedAccess(delivery: Row) {
  // Delivery is permanent history; only its technical Storage URL expires.
  // Ownership was verified above. No subscription check, claim or new purchase.
  const seconds = WEB_VIDEO_ACCESS_SECONDS;
  const expires = this.now() + seconds * 1000;
  let url:string;
  try {url = await this.signer(delivery.bucket_name, delivery.storage_path, seconds);}
  catch {throw new WebError(503,'video_delivery_retryable');}
  return {...this.publicDelivery(delivery), video_url: url, expires_at: new Date(expires).toISOString()};
 }
}
