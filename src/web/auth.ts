import { z } from "zod";
import type { WebIdentity } from "./types.js";
export type { WebIdentity } from "./types.js";

export interface WebAuthenticator {
  verify(authorization: string | undefined): Promise<WebIdentity>;
}

export class WebAuthError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}
const userSchema = z.object({
  id: z.string().uuid(),
  is_anonymous: z.boolean().optional(),
  app_metadata: z.object({
    provider: z.string().optional(),
    providers: z.array(z.string()).optional(),
  }).passthrough().optional(),
  identities: z.array(z.object({
    provider: z.string(), user_id: z.string().uuid().optional(),
    identity_data: z.record(z.unknown()).optional(),
  }).passthrough()).max(100).optional(),
  user_metadata: z.record(z.unknown()).optional(),
}).passthrough();

function optionalText(value: unknown, length: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, length)
    : null;
}

/** Telegram's OIDC subject is opaque. Only the profile `id` claim, preserved by
 * Supabase's custom_claims_allowlist in provider-owned identity_data, is a bot ID.
 * User-editable user_metadata and generic identity.id/provider_id are never proofs.
 */
function telegramIdentity(user: z.infer<typeof userSchema>, provider: string): string | undefined {
  if (!provider) return undefined;
  const matches = (user.identities ?? []).filter(identity => identity.provider === provider);
  if (!matches.length) {
    if (user.app_metadata?.provider === provider) throw new WebAuthError(503, 'telegram_identity_unavailable');
    return undefined;
  }
  const ids = matches.map(identity => {
    if (identity.user_id !== undefined && identity.user_id !== user.id) throw new WebAuthError(403, 'invalid_telegram_identity');
    const data = identity.identity_data;
    if (!data || data.iss !== 'https://oauth.telegram.org') throw new WebAuthError(403, 'invalid_telegram_identity');
    const claims = data.custom_claims;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) || !('id' in claims)) throw new WebAuthError(503, 'telegram_identity_unavailable');
    const raw = (claims as Record<string, unknown>).id;
    const id = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? String(raw)
      : typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? raw : null;
    if (!id || BigInt(id) > 4503599627370495n) throw new WebAuthError(403, 'invalid_telegram_identity');
    return id;
  });
  if (new Set(ids).size !== 1) throw new WebAuthError(403, 'invalid_telegram_identity');
  return ids[0];
}

/** Supabase's authenticated user endpoint verifies signature, expiry and session.
 * Never decode a browser JWT or user_metadata to authorize an account. */
export class SupabaseAuthVerifier implements WebAuthenticator {
  private readonly endpoint: string;

  constructor(
    supabaseUrl: string,
    private readonly publishableKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly telegramProvider = '',
  ) {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS project URL");
    }
    this.endpoint = `${url.origin}/auth/v1/user`;
    if (!publishableKey.trim()) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
    if (telegramProvider && !/^custom:[a-z0-9][a-z0-9:-]{0,42}$/.test(telegramProvider)) throw new Error('Invalid Supabase Telegram provider identifier');
  }

  async verify(authorization: string | undefined): Promise<WebIdentity> {
    if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/iu.test(authorization)
      || authorization.length > 16_384) {
      throw new WebAuthError(401, "unauthorized");
    }
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "GET",
        headers: { Authorization: authorization, apikey: this.publishableKey },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new WebAuthError(503, "auth_unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebAuthError(401, "unauthorized");
    }
    if (!response.ok) throw new WebAuthError(503, "auth_unavailable");
    let data: unknown;
    try { data = await response.json(); } catch { throw new WebAuthError(503, "auth_unavailable"); }
    const parsed = userSchema.safeParse(data);
    if (!parsed.success) throw new WebAuthError(503, "auth_unavailable");
    const user = parsed.data;
    const anonymous = user.is_anonymous === true;
    const telegramId = telegramIdentity(user, this.telegramProvider);
    const google = user.app_metadata?.provider === "google"
      || user.app_metadata?.providers?.includes("google")
      || user.identities?.some((identity) => identity.provider === "google");
    if (!anonymous && !google && !telegramId) throw new WebAuthError(403, "auth_provider_not_supported");
    return {
      auth_user_id: user.id,
      is_anonymous: anonymous,
      display_name: optionalText(user.user_metadata?.full_name ?? user.user_metadata?.name, 120),
      locale: google ? optionalText(user.user_metadata?.locale, 40) : null,
      ...(telegramId ? { verified_telegram_id: telegramId } : {}),
    };
  }
}
