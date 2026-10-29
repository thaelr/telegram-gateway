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
};
export type VideoPhotoContext = {chat_id: number; scene_session_id: string | null; character_i: number; media_signature: string; panel_id: number};

/** Uses the common Commerce delivery ledger. No Web video ownership library is created. */
export class WebVideoAccess {
 constructor(private readonly db: typeof sql = sql, private readonly signer = signVideoUrl, private readonly now: () => number = Date.now) {}
 async context(photo: VideoPhotoContext, db: DB = this.db): Promise<WebVideoContext> {
  const [row] = await query(db, 'SELECT public.media_video_context($1,$2,$3::integer,$4,$5) AS result', [photo.chat_id, photo.scene_session_id, photo.character_i, photo.media_signature, photo.panel_id]);
  return row!.result as WebVideoContext;
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
  const row = (await query(this.db, "SELECT * FROM app_private.video_deliveries WHERE user_id=$1 AND delivery_id=$2::uuid AND source='web'", [userId, id]))[0];
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
  // A lost HTTP response can be recovered inside the original short window only.
  const expires = new Date(String(delivery.delivered_at)).getTime() + WEB_VIDEO_ACCESS_SECONDS * 1000;
  const seconds = Math.floor((expires - this.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new WebError(410, 'video_delivery_expired');
  let url:string;
  try {url = await this.signer(delivery.bucket_name, delivery.storage_path, seconds);}
  catch {throw new WebError(503,'video_delivery_retryable');}
  return {...this.publicDelivery(delivery), video_url: url, expires_at: new Date(expires).toISOString()};
 }
}
