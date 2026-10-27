import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerWebRoutes } from "../src/web/routes.js";
import { WebAuthError } from "../src/web/auth.js";
import { WebError, type WebRepositoryContract, type WebProfile, type WebChat } from "../src/web/types.js";

const identity = { auth_user_id: "11111111-1111-4111-8111-111111111111", is_anonymous: false, display_name: "User", locale: "en" };
const profile: WebProfile = { user_id: "u0000001", display_name: "User", language: "en", age_confirmed_at: "2026-10-25T00:00:00Z", terms_accepted_at: "2026-10-25T00:00:00Z", subscription_sku: null, subscription_until: null, entitlements: {}, needs_language_selection: false };
const chat: WebChat = { chat_code: "c0000001", character_i: 1, scene_mode: "roleplay", scene_session_id: "scene-1", turn_no: 0, scene_turn_no: 0, updated_at: "2026-10-25T00:00:00Z" };
const bearer = { authorization: "Bearer test" };

function createApp(overrides: Partial<WebRepositoryContract> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const owned = (userId: string, code: string) => {
    if (userId !== profile.user_id || code !== chat.chat_code) throw new WebError(404, "chat_not_found");
  };
  const repository: WebRepositoryContract = {
    async bootstrap(value) { calls.push({ method: "bootstrap", args: [value] }); return profile; },
    async resolveIdentity(id) { assert.equal(id, identity.auth_user_id); return profile.user_id; },
    async getMe(id) { assert.equal(id, profile.user_id); return profile; },
    async updateMe(id, patch) { calls.push({ method: "updateMe", args: [id, patch] }); return { ...profile, ...patch }; },
    async confirmAge(id) { calls.push({ method: "confirmAge", args: [id] }); return profile; },
    async acceptTerms(id) { calls.push({ method: "acceptTerms", args: [id] }); return profile; },
    async listCharacters() { return [{ character_i: 1, name: "Character", description: "Public", image_url: null, modes: ["roleplay", "fast"], chat_code: chat.chat_code }]; },
    async getCharacter() { return (await repository.listCharacters(profile.user_id))[0]!; },
    async listChats() { return [chat]; },
    async createChat(id, character, mode, clientId) { calls.push({ method: "createChat", args: [id, character, mode, clientId] }); return { chat, operation: null }; },
    async getChat(id, code) { owned(id, code); return chat; },
    async enqueue(id, code, action, clientId, text) { owned(id, code); calls.push({ method: "enqueue", args: [id, code, action, clientId, text] }); return { operation_id: "operation-1", event_id: "event-1", status: "pending", action, chat_code: code }; },
    async history(id, code) { owned(id, code); return { messages: [], next_before: null }; },
    async events(id, code, after) { owned(id, code); calls.push({ method: "events", args: [id, code, after] }); return { events: [{ cursor: "45", type: "message", data: { text: "A late persisted answer", turn_no: 3 }, created_at: "2026-10-25T00:00:00Z" }], cursor: "45" }; },
    async continuation(id, code) { owned(id, code); return { offered: true, separator: "---", messages: [], chat }; },
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerWebRoutes(app, { repository, authenticator: { async verify(authorization) { if (authorization !== bearer.authorization) throw new WebAuthError(401, "unauthorized"); return identity; } } });
  return { app, calls };
}

test("all Web routes authenticate before reading an account and hide internal errors", async (t) => {
  const { app } = createApp({ async resolveIdentity() { throw new Error("private SQL/auth material"); } });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/web/me" })).statusCode, 401);
  const failure = await app.inject({ url: "/web/me", headers: bearer });
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.json().error, "internal_error");
  assert.equal(failure.body.includes("private"), false);
});

test("bootstrap uses the verified Supabase identity and rejects client account identifiers", async (t) => {
  const { app, calls } = createApp({ async resolveIdentity() { throw new Error("bootstrap must not resolve first"); } });
  t.after(() => app.close());
  const result = await app.inject({ method: "POST", url: "/web/auth/bootstrap", headers: bearer, payload: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls[0], { method: "bootstrap", args: [identity] });
  assert.equal((await app.inject({ method: "POST", url: "/web/auth/bootstrap", headers: bearer, payload: { user_id: "u9999999" } })).statusCode, 400);
});

test("unbootstrapped identities cannot access the public profile", async (t) => {
  const { app } = createApp({ async resolveIdentity() { return null; } });
  t.after(() => app.close());
  const result = await app.inject({ url: "/web/me", headers: bearer });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error, "bootstrap_required");
});

test("ownership applies to reading, messages, events, continuation and reset", async (t) => {
  const { app } = createApp();
  t.after(() => app.close());
  for (const suffix of ["", "/messages", "/events", "/continuation"]) {
    const result = await app.inject({ url: `/web/chats/c9999999${suffix}`, headers: bearer });
    assert.equal(result.statusCode, 404);
  }
  for (const suffix of ["messages", "reset"]) {
    const result = await app.inject({ method: "POST", url: `/web/chats/c9999999/${suffix}`, headers: bearer, payload: suffix === "messages" ? { client_message_id: "m1", text: "Hi" } : { client_message_id: "r1" } });
    assert.equal(result.statusCode, 404);
  }
});

test("age and terms require separate explicit confirmation, and gate scene actions", async (t) => {
  const { app, calls } = createApp({ async getMe() { return { ...profile, age_confirmed_at: null, terms_accepted_at: null }; } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/web/me/confirm-age", headers: bearer, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/web/me/accept-terms", headers: bearer, payload: { accepted: false } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/web/me/confirm-age", headers: bearer, payload: { confirmed: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/web/me/accept-terms", headers: bearer, payload: { accepted: true } })).statusCode, 200);
  const denied = await app.inject({ method: "POST", url: "/web/chats/c0000001/messages", headers: bearer, payload: { client_message_id: "m1", text: "Hi" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.some((call) => call.method === "enqueue"), false);
});

test("message acceptance forwards the stable client ID and excludes transport secrets", async (t) => {
  const { app, calls } = createApp();
  t.after(() => app.close());
  for (let i = 0; i < 2; i++) {
    const result = await app.inject({ method: "POST", url: "/web/chats/c0000001/messages", headers: bearer, payload: { client_message_id: "message-1", text: "Hello" } });
    assert.equal(result.statusCode, 202);
    assert.equal(result.json().operation_id, "operation-1");
    assert.equal(result.body.includes("Bearer"), false);
  }
  assert.deepEqual(calls[0], { method: "enqueue", args: ["u0000001", "c0000001", "message", "message-1", "Hello"] });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal((await app.inject({ method: "POST", url: "/web/chats/c0000001/messages", headers: bearer, payload: { client_message_id: "m2", text: "Hello", user_id: "u9999999" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/web/chats/c0000001/messages", headers: bearer, payload: { text: "Hello" } })).statusCode, 400);
});

test("polling passes the durable cursor and returns late completions unchanged", async (t) => {
  const { app, calls } = createApp();
  t.after(() => app.close());
  const result = await app.inject({ url: "/web/chats/c0000001/events?after=44", headers: bearer });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().events[0].data.text, "A late persisted answer");
  assert.deepEqual(calls[0], { method: "events", args: ["u0000001", "c0000001", "44"] });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/web/chats/c0000001/events?after=-1", headers: bearer })).statusCode, 400);
});

test("profile patches cannot set entitlements or consents; manual language is explicit", async (t) => {
  const { app } = createApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "PATCH", url: "/web/me", headers: bearer, payload: { language: "ru" } })).json().language, "ru");
  for (const payload of [{ entitlements: { subscription: true } }, { age_confirmed_at: "now" }, { user_id: "u9999999" }]) {
    assert.equal((await app.inject({ method: "PATCH", url: "/web/me", headers: bearer, payload })).statusCode, 400);
  }
});
