import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { WebError } from './types.js';

const ISSUER = 'https://oauth.telegram.org';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
type TelegramKey = JsonWebKey & { kid: string; alg?: string; use?: string };
export interface TelegramProofVerifier { verify(token: string, nonce: string): Promise<string> }
export const linkHash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Only Telegram's default RS256 Login tokens, fixed issuer/keys and an account-bound nonce.
 * The opaque OIDC subject is not a Telegram numeric user ID; require the signed profile id.
 */
export class TelegramLoginVerifier implements TelegramProofVerifier {
  private keys: TelegramKey[] = [];
  private cachedUntil = 0;
  private pendingKeys: Promise<void> | null = null;
  constructor(private readonly clientId: string, private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  private async loadKeys(): Promise<void> {
    try {
      const response = await this.fetcher(JWKS_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      const body = await response.json() as { keys?: unknown };
      if (!Array.isArray(body.keys) || body.keys.length > 30) throw new Error();
      this.keys = body.keys.filter((key: TelegramKey) => key && key.kty === 'RSA'
        && typeof key.kid === 'string' && typeof key.n === 'string' && typeof key.e === 'string'
        && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      this.cachedUntil = this.now() + 60_000;
    } catch { throw new WebError(503, 'telegram_login_unavailable'); }
  }

  async verify(token: string, nonce: string): Promise<string> {
    const invalid = () => new WebError(401, 'invalid_telegram_proof');
    if (!this.clientId || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
    const [headerText, payloadText, signatureText] = token.split('.') as [string, string, string];
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerText, 'base64url').toString());
      claims = JSON.parse(Buffer.from(payloadText, 'base64url').toString());
      if (!header || !claims || Array.isArray(header) || Array.isArray(claims)) throw invalid();
    } catch { throw invalid(); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw invalid();
    const currentTime = Math.floor(this.now() / 1000);
    if (claims.iss !== ISSUER || claims.aud !== this.clientId || claims.nonce !== nonce
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= currentTime
      || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat)
      || claims.iat > currentTime + 30 || claims.iat < currentTime - 600
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > currentTime + 30))
      || typeof claims.id !== 'number' || !Number.isSafeInteger(claims.id) || claims.id <= 0 || claims.id > 4503599627370495) throw invalid();
    if (this.cachedUntil <= this.now()) {
      if (!this.pendingKeys) this.pendingKeys = this.loadKeys().finally(() => { this.pendingKeys = null; });
      await this.pendingKeys;
    }
    const key = this.keys.find(candidate => candidate.kid === header.kid);
    if (!key) throw invalid();
    try {
      if (!verify('RSA-SHA256', Buffer.from(`${headerText}.${payloadText}`),
        createPublicKey({ key, format: 'jwk' }), Buffer.from(signatureText, 'base64url'))) throw invalid();
    } catch { throw invalid(); }
    return String(claims.id);
  }
}
