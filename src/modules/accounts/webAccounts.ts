import { iso } from '../../web/history.js';
import { sql } from '../../db.js';
import { WebError, type WebIdentity, type WebProfile } from '../../web/types.js';
type DB = Pick<typeof sql, 'unsafe'>;
type Param = string | number | boolean | null;
type Row = Record<string, any>;
export async function lockWebAccount(db:DB,userId:string,write=false){
  const account=await db.unsafe<Row[]>(`SELECT user_id FROM public.users WHERE user_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[userId]);
  // A separate statement after the lock sees identity adoption committed while
  // this request was waiting. An EXISTS predicate in the locking statement alone
  // could still use its earlier MVCC snapshot.
  const identity=await db.unsafe<Row[]>(`SELECT 1 FROM public.user_identities WHERE user_id=$1 AND provider='supabase' LIMIT 1`,[userId]);
  if(!account.length||!identity.length)throw new WebError(401,'account_not_found');
 }

export async function consents(db:DB,userId:string){await lockWebAccount(db,userId);const u=(await db.unsafe<Row[]>(`SELECT language_confirmed_at,age_confirmed_at,terms_accepted_at FROM public.users WHERE user_id=$1`,[userId]))[0];if(!u?.terms_accepted_at&&!u?.language_confirmed_at)throw new WebError(403,'language_selection_required');if(!u?.age_confirmed_at||!u?.terms_accepted_at)throw new WebError(403,'consent_required');}
export async function resolveIdentity(query: typeof sql, authUserId: string) { const r=await query.unsafe<Row[]>(`SELECT user_id FROM public.user_identities WHERE provider='supabase' AND external_id=$1`,[authUserId]); return r[0]?.user_id??null; }

export async function bootstrap(query: typeof sql, identity: WebIdentity): Promise<WebProfile> {
  let row:Row|undefined;
  for(let attempt=0;attempt<3;attempt++){
   row=(await query.unsafe<Row[]>(`SELECT app_private.web_bootstrap_identity($1::text,$2::text,$3::text) AS result`,
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
  return getMe(query, result.user_id);
 }

export async function getMe(query: typeof sql, userId: string): Promise<WebProfile> {
  const r=(await query.unsafe<Row[]>(`SELECT user_id,display_name,profile_text,language,language_confirmed_at::text,age_confirmed_at::text,terms_accepted_at::text,subscription_sku,subscription_until::text,entitlements_jsonb AS entitlements FROM public.users WHERE user_id=$1`,[userId]))[0];
  if(!r) throw new WebError(401,'account_not_found');
  return {...r,language_confirmed_at:iso(r.language_confirmed_at),age_confirmed_at:iso(r.age_confirmed_at),terms_accepted_at:iso(r.terms_accepted_at),subscription_until:iso(r.subscription_until),needs_language_selection:r.language_confirmed_at==null&&r.terms_accepted_at==null} as WebProfile;
 }

export async function updateMe(query: typeof sql, userId: string, patch: {display_name?:string;profile_text?:string;language?:string}) {
  await query.begin(async tx=>{await lockWebAccount(tx,userId,true);
  await tx.unsafe<Row[]>(`UPDATE public.users SET display_name=CASE WHEN $2 THEN $3 ELSE display_name END,language=CASE WHEN $4 THEN $5 ELSE language END,language_confirmed_at=CASE WHEN $4 THEN now() ELSE language_confirmed_at END,profile_text=CASE WHEN $6 THEN $7 ELSE profile_text END,updated_at=now() WHERE user_id=$1`,[userId,patch.display_name!==undefined,patch.display_name??null,patch.language!==undefined,patch.language??null,patch.profile_text!==undefined,patch.profile_text??null]);});
  return getMe(query, userId);
 }

export async function confirmAge(query: typeof sql, userId: string) { await query.begin(async tx=>{await lockWebAccount(tx,userId,true);await tx.unsafe<Row[]>(`SELECT app_private.confirm_user_age($1::varchar)`,[userId]);});return getMe(query, userId); }

export async function acceptTerms(query: typeof sql, userId: string) {
  await query.begin(async tx=>{await lockWebAccount(tx,userId,true);
  const updated=await tx.unsafe<Row[]>(`UPDATE public.users SET terms_accepted_at=COALESCE(terms_accepted_at,now()),updated_at=now() WHERE user_id=$1 AND (language_confirmed_at IS NOT NULL OR terms_accepted_at IS NOT NULL) RETURNING user_id`,[userId]);
  if(!updated.length)throw new WebError(403,'language_selection_required');});
  return getMe(query, userId);
 }
