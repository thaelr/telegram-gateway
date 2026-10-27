import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";
import type { WebRepositoryContract, WebProfile } from "../src/web/types.js";

process.env.NODE_ENV = "test";
installTestEnv();
const plan = { sku: "test", amount_xtr: 1, title: "test", description: "test", label: "test", button_text: "test" };
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([{ ...plan, days: 1 }]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([plan]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([{ ...plan, feature_key: "scene_unlock" }]);
const { buildApp } = await import("../src/server.js");

test("Web is disabled by default while existing health/internal route protection remains", async (t) => {
  const app = buildApp({ logger: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/web/me" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/v1/router-decision", payload: {} })).statusCode, 401);
});

test("injected Web routes mount in Gateway and delivery lifecycle starts/stops with the app", async () => {
  const lifecycle: string[] = [];
  const profile: WebProfile = { user_id: "u0000001", display_name: null, language: null, age_confirmed_at: null, terms_accepted_at: null, subscription_sku: null, subscription_until: null, entitlements: {}, needs_language_selection: true };
  const app = buildApp({ logger: false, web: {
    authenticator: { async verify() { return { auth_user_id: "11111111-1111-4111-8111-111111111111", is_anonymous: true, display_name: null, locale: null }; } },
    // This test only invokes bootstrap; repository behavior is covered separately.
    repository: { async bootstrap() { return profile; } } as unknown as WebRepositoryContract,
    deliveryWorker: { start() { lifecycle.push("start"); }, async stop() { lifecycle.push("stop"); } },
  } });
  try {
    const result = await app.inject({ method: "POST", url: "/web/auth/bootstrap", payload: {} });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().user_id, profile.user_id);
    assert.deepEqual(lifecycle, ["start"]);
    assert.equal((await app.inject({ method: "POST", url: "/v1/router-decision", payload: {} })).statusCode, 401);
  } finally { await app.close(); }
  assert.deepEqual(lifecycle, ["start", "stop"]);
});
