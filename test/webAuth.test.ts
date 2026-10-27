import test from "node:test";
import assert from "node:assert/strict";
import { languageFromLocale, SupabaseAuthVerifier, WebAuthError } from "../src/web/auth.js";

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

test("web locale mapping leaves missing locale for manual selection", () => {
  assert.equal(languageFromLocale(null), null);
  assert.equal(languageFromLocale(""), null);
  assert.equal(languageFromLocale("ru_RU"), "ru");
  assert.equal(languageFromLocale("en-US"), "en");
  assert.equal(languageFromLocale("kk-KZ"), "ru");
  assert.equal(languageFromLocale("hy"), "ru");
  assert.equal(languageFromLocale("fr-FR"), "en");
  assert.equal(languageFromLocale("ro-RO"), "en");
  assert.equal(languageFromLocale("ro-MD"), "ru");
});
