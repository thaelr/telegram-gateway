import { config } from './config.js';

/** Server-only: a private Storage object is exposed only after an entitlement/delivery claim. */
export async function signVideoUrl(bucket: string, path: string, expiresInSeconds = 120): Promise<string> {
  const origin = config.SUPABASE_URL?.replace(/\/+$/u, '');
  const key = config.SUPABASE_SERVICE_ROLE_KEY;
  if (!origin || !key) throw new Error('Video Storage server credentials are not configured');
  if (!bucket || !path || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid video storage path');
  const object = `${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(`${origin}/storage/v1/object/sign/${object}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: Math.max(1, Math.min(120, Math.trunc(expiresInSeconds))) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Video URL signing failed (${response.status})`);
  const body = await response.json() as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) throw new Error('Video URL signing response is invalid');
  const url = new URL(signed.startsWith('/object/') ? `/storage/v1${signed}` : signed, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('Unexpected video URL origin');
  return url.toString();
}
