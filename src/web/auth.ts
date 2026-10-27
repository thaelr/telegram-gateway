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
  identities: z.array(z.object({ provider: z.string() }).passthrough()).optional(),
  user_metadata: z.record(z.unknown()).optional(),
}).passthrough();

function optionalText(value: unknown, length: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, length)
    : null;
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
  ) {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS project URL");
    }
    this.endpoint = `${url.origin}/auth/v1/user`;
    if (!publishableKey.trim()) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
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
    const google = user.app_metadata?.provider === "google"
      || user.app_metadata?.providers?.includes("google")
      || user.identities?.some((identity) => identity.provider === "google");
    if (!anonymous && !google) throw new WebAuthError(403, "auth_provider_not_supported");
    return {
      auth_user_id: user.id,
      is_anonymous: anonymous,
      display_name: optionalText(user.user_metadata?.full_name ?? user.user_metadata?.name, 120),
      locale: google ? optionalText(user.user_metadata?.locale, 40) : null,
    };
  }
}

/** A manual language stored in users.language always takes precedence. */
export function languageFromLocale(locale: string | null | undefined): "ru" | "en" | null {
  if (!locale?.trim()) return null;
  const normalized = locale.trim().replace(/_/gu, "-").toLowerCase();
  const [language] = normalized.split("-");
  if (language === "ru" || language === "en") return language;
  const cisLanguages = new Set(["uk", "be", "kk", "ky", "tg", "tk", "uz", "hy", "az", "mo"]);
  const region = normalized.split("-").find((part, index) => index > 0 && /^[a-z]{2}$/u.test(part));
  const cisRegions = new Set(["ru", "by", "kz", "kg", "tj", "tm", "uz", "am", "az", "md", "ua"]);
  return cisLanguages.has(language ?? "") || (region != null && cisRegions.has(region)) ? "ru" : "en";
}
