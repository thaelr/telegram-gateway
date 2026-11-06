import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseAuthVerifier, WebAuthError } from "../src/web/auth.js";

const id = "11111111-1111-4111-8111-111111111111";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const mockFetch = (run: (url: string, init: RequestInit) => Promise<Response>): typeof fetch =>
  ((input, init) => run(String(input), init ?? {})) as typeof fetch;

test("web auth verifies the bearer only with the fixed Supabase Auth endpoint", async () => {
  const verifier = new SupabaseAuthVerifier("https://project.supabase.co", "publishable-test", mockFetch(async (url, init) => {
    assert.equal(url, "https://project.supabase.co/auth/v1/user");
    assert.deepEqual(init.headers, { Authorization: "Bearer signed.token.value", apikey: "publishable-test" });
    assert.equal(init.redirect, "error");
    return response({ id, is_anonymous: false, app_metadata: { provider: "google" }, user_metadata: { full_name: "Test User", locale: "ru-RU", user_id: "u9999999" } });
  }));
  assert.deepEqual(await verifier.verify("Bearer signed.token.value"), {
    auth_user_id: id, is_anonymous: false, display_name: "Test User", locale: "ru-RU",
  });
});

test("web auth accepts verified anonymous users and does not infer an identity from metadata", async () => {
  const verifier = new SupabaseAuthVerifier("https://project.supabase.co", "key", mockFetch(async () => response({
    id, is_anonymous: true, user_metadata: { provider: "google", locale: "ru" },
  })));
  assert.deepEqual(await verifier.verify("Bearer token"), {
    auth_user_id: id, is_anonymous: true, display_name: null, locale: null,
  });
  const forged = new SupabaseAuthVerifier("https://project.supabase.co", "key", mockFetch(async () => response({
    id, is_anonymous: false, app_metadata: { provider: "email" }, user_metadata: { provider: "google", is_anonymous: true },
  })));
  await assert.rejects(forged.verify("Bearer token"), (error: unknown) => error instanceof WebAuthError && error.statusCode === 403);
});

test("web auth fails closed for missing, expired, malformed and unavailable authentication", async () => {
  let calls = 0;
  const verifier = new SupabaseAuthVerifier("https://project.supabase.co", "key", mockFetch(async () => {
    calls++; return response({}, 401);
  }));
  await assert.rejects(verifier.verify(undefined), { code: "unauthorized" });
  await assert.rejects(verifier.verify("Bearer token\nsecret"), { code: "unauthorized" });
  assert.equal(calls, 0);
  await assert.rejects(verifier.verify("Bearer expired"), { code: "unauthorized" });
  const malformed = new SupabaseAuthVerifier("https://project.supabase.co", "key", mockFetch(async () => response({ id: "untrusted" })));
  await assert.rejects(malformed.verify("Bearer token"), { code: "auth_unavailable" });
  const unavailable = new SupabaseAuthVerifier("https://project.supabase.co", "key", mockFetch(async () => { throw new Error("timeout"); }));
  await assert.rejects(unavailable.verify("Bearer token"), { code: "auth_unavailable" });
});

test("web auth refuses non-HTTPS project endpoints", () => {
  assert.throws(() => new SupabaseAuthVerifier("http://project.supabase.co", "key"), /HTTPS/u);
});

const customProvider = 'custom:telegram-test';
function telegramAuth(body: unknown, provider = customProvider) {
  return new SupabaseAuthVerifier('https://project.supabase.co', 'public-test',
    mockFetch(async () => response(body)), 10_000, provider);
}
const telegramUser = (claims: Record<string, unknown> = { id: 987654321 }) => ({
  id, is_anonymous: false, app_metadata: { provider: customProvider },
  identities: [{ provider: customProvider, user_id: id, identity_data: {
    iss: 'https://oauth.telegram.org', sub: '1234123412341234123', custom_claims: claims,
  } }],
});

test('Telegram PKCE uses the provider-owned numeric profile id, never the opaque subject', async () => {
  for (const value of [987654321, '987654321']) {
    const identity = await telegramAuth(telegramUser({ id: value })).verify('Bearer verified.session');
    assert.equal(identity.auth_user_id, id);
    assert.equal(identity.verified_telegram_id, '987654321');
    assert.equal(identity.is_anonymous, false);
  }
});

test('Telegram rejects forged metadata, mismatched issuer/user/provider and ambiguous linked identities', async () => {
  const missing = telegramUser();
  missing.identities = [];
  await assert.rejects(telegramAuth({ ...missing, user_metadata: { telegram_id: 987654321, custom_claims: { id: 987654321 } } }).verify('Bearer session'), { code: 'telegram_identity_unavailable' });
  const wrongIssuer = telegramUser(); wrongIssuer.identities[0]!.identity_data.iss = 'https://other.example';
  await assert.rejects(telegramAuth(wrongIssuer).verify('Bearer session'), { code: 'invalid_telegram_identity' });
  const wrongUser = telegramUser(); wrongUser.identities[0]!.user_id = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(telegramAuth(wrongUser).verify('Bearer session'), { code: 'invalid_telegram_identity' });
  await assert.rejects(telegramAuth(telegramUser(), 'custom:other-provider').verify('Bearer session'), { code: 'auth_provider_not_supported' });
  await assert.rejects(telegramAuth(telegramUser(), '').verify('Bearer session'), { code: 'auth_provider_not_supported' });
  const ambiguous = telegramUser(); ambiguous.identities.push(telegramUser({ id: 123456789 }).identities[0]!);
  await assert.rejects(telegramAuth(ambiguous).verify('Bearer session'), { code: 'invalid_telegram_identity' });
});

test('Telegram missing claim passthrough is recoverable and invalid numeric IDs fail closed', async () => {
  await assert.rejects(telegramAuth(telegramUser({})).verify('Bearer session'), { code: 'telegram_identity_unavailable' });
  for (const value of [0, -1, 1.5, 4503599627370496, '4503599627370496', Number.MAX_SAFE_INTEGER + 1, '00123', '1e8', '123abc', null, {}]) {
    await assert.rejects(telegramAuth(telegramUser({ id: value })).verify('Bearer session'), { code: 'invalid_telegram_identity' });
  }
});
