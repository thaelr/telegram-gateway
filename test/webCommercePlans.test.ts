import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

process.env.NODE_ENV = "test";
installTestEnv();
const plan = { sku: "subscription", amount_xtr: 200, amount_rub: 1000, title: "Plan", description: "Public description", label: "Plan", button_text: "Buy" };
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON = JSON.stringify([{ ...plan, days: 14 }]);
process.env.MEDIA_PHOTO_PLANS_JSON = JSON.stringify([{ ...plan, sku: "photo", amount_xtr: 10, amount_rub: 100 }]);
process.env.MEDIA_ACTION_PLANS_JSON = JSON.stringify([{ ...plan, sku: "unlock", feature_key: "scene_unlock", amount_xtr: 80, amount_rub: 400 }]);
const { config } = await import("../src/config.js");
const { MediaCommerceDecisionService } = await import("../src/mediaCommerceDecisionService.js");
const { resolveSubscriptionPlans, resolvePhotoPlanBySku, resolveActionPlanByFeatureKey } = await import("../src/mediaCommerce/plans.js");
type Repository = ConstructorParameters<typeof MediaCommerceDecisionService>[0];

function strictService(calls: string[], assignment?: unknown) {
  const repository = new Proxy({}, { get(_target, property) {
    if (property === "loadAbTestAssignment") return async () => { calls.push(String(property)); return assignment; };
    return () => { throw new Error(`Unexpected persistence action: ${String(property)}`); };
  } }) as Repository;
  return new MediaCommerceDecisionService(repository, { async createStarsInvoice() { throw new Error("Unexpected Stars side effect"); } }, { async createPayment() { throw new Error("Unexpected SBP side effect"); } });
}

test("Web plans reuse the same effective promotions as existing Commerce without creating invoices", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 25) });
  const oldPromotions = config.MEDIA_PROMOTIONS_JSON, oldExperiments = config.EXPERIMENTS;
  t.after(() => { config.MEDIA_PROMOTIONS_JSON = oldPromotions; config.EXPERIMENTS = oldExperiments; });
  config.EXPERIMENTS = [];
  config.MEDIA_PROMOTIONS_JSON = [{ promo_key: "promotion", starts_at: "2026-10-24T00:00:00Z", ends_at: "2026-10-26T00:00:00Z", items: [{ sku: "subscription", promo_amount_xtr: 140, promo_amount_rub: 700 }, { sku: "photo", promo_amount_xtr: 7, promo_amount_rub: 70 }, { sku: "unlock", promo_amount_xtr: 56, promo_amount_rub: 280 }] }];
  const calls: string[] = [];
  const plans = await strictService(calls).webProductPlans(null);
  assert.deepEqual(plans.map((item) => [item.sku, item.amount_xtr, item.amount_rub, item.original_amount_rub, item.promo_key]), [
    ["subscription", 140, 700, 1000, "promotion"], ["photo", 7, 70, 100, "promotion"], ["unlock", 56, 280, 400, "promotion"],
  ]);
  const legacy = [resolveSubscriptionPlans()[0]!, resolvePhotoPlanBySku("photo")!, resolveActionPlanByFeatureKey("scene_unlock")!];
  assert.deepEqual(plans.map((p) => p.amount_rub), legacy.map((p) => p.amount_rub));
  assert.deepEqual(calls, []);
});

test("Web account experiment overrides follow shared promotion precedence and hide disabled products", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 25) });
  const oldPromotions = config.MEDIA_PROMOTIONS_JSON, oldExperiments = config.EXPERIMENTS;
  t.after(() => { config.MEDIA_PROMOTIONS_JSON = oldPromotions; config.EXPERIMENTS = oldExperiments; });
  config.MEDIA_PROMOTIONS_JSON = [{ promo_key: "promotion", starts_at: "2026-10-24T00:00:00Z", ends_at: "2026-10-26T00:00:00Z", items: [{ sku: "subscription", promo_amount_xtr: 140, promo_amount_rub: 700 }] }];
  config.EXPERIMENTS = [{ key: "subscription_offer", assignment_key: "subscription_offer|2026-10-24T00:00:00Z", version: "test-v1", starts_at: "2026-10-24T00:00:00Z", ends_at: "2026-10-26T00:00:00Z", distribution: { B: 100 }, variants: { B: { plans: [{ sku: "subscription", amount_xtr: 150, amount_rub: 750, days: 20 }], scene_unlock: { enabled: false } } } }];
  const calls: string[] = [];
  const plans = await strictService(calls, { variant: "B", assigned_at: "2026-10-24T00:00:00Z" }).webProductPlans(8000000000000001);
  assert.equal(plans.find((p) => p.sku === "subscription")?.amount_rub, 750);
  assert.equal(plans.find((p) => p.sku === "subscription")?.subscription_days, 20);
  assert.equal(plans.some((p) => p.sku === "unlock"), false);
  assert.deepEqual(calls, ["loadAbTestAssignment"]);
});
