import test from "node:test";
import assert from "node:assert/strict";
import { testTelegramUxCopy } from "./testEnv.js";

const baselineSubscriptionPlans = [{
  sku: "sub_14",
  amount_xtr: 200,
  amount_rub: 199,
  days: 14,
  title: "14 days",
  description: "14 days",
  label: "14 days",
  button_text: "Subscribe",
}];

const baselinePhotoPlans = [{
  sku: "photo",
  amount_xtr: 10,
  amount_rub: 99,
  title: "Photo",
  description: "Photo",
  label: "Photo",
  button_text: "Pay",
}];

const baselineActionPlans = [{
  sku: "fast_skip",
  feature_key: "fast_scene_skip",
  amount_xtr: 10,
  amount_rub: 99,
  title: "Fast skip",
  description: "Fast skip",
  label: "Fast skip",
  button_text: "Pay",
}];

const envKeys = [
  "DATABASE_URL",
  "INTERNAL_API_KEY",
  "TG_BOT_TOKEN",
  "TELEGRAM_UX_COPY_JSON",
  "MEDIA_SUBSCRIPTION_PLANS_JSON",
  "MEDIA_PHOTO_PLANS_JSON",
  "MEDIA_ACTION_PLANS_JSON",
  "MEDIA_PROMOTIONS_JSON",
] as const;

let importId = 0;

async function importConfigWith(overrides: Record<string, string>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of envKeys) {
    previous.set(key, process.env[key]);
  }

  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
  process.env.INTERNAL_API_KEY = "test-internal-key";
  process.env.TG_BOT_TOKEN = "test-telegram-bot-token";
  process.env.TELEGRAM_UX_COPY_JSON = JSON.stringify(testTelegramUxCopy);
  process.env.MEDIA_SUBSCRIPTION_PLANS_JSON = JSON.stringify(baselineSubscriptionPlans);
  process.env.MEDIA_PHOTO_PLANS_JSON = JSON.stringify(baselinePhotoPlans);
  process.env.MEDIA_ACTION_PLANS_JSON = JSON.stringify(baselineActionPlans);
  process.env.MEDIA_PROMOTIONS_JSON = "[]";

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    importId += 1;
    await import(`../src/config.js?config-test=${importId}`);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("money JSON config rejects unknown fields and numeric strings", async () => {
  await assert.rejects(
    importConfigWith({
      MEDIA_SUBSCRIPTION_PLANS_JSON: JSON.stringify([{
        ...baselineSubscriptionPlans[0],
        ammount_xtr: 300,
      }]),
    }),
    /Invalid JSON config/u,
  );

  await assert.rejects(
    importConfigWith({
      MEDIA_PHOTO_PLANS_JSON: JSON.stringify([{
        ...baselinePhotoPlans[0],
        amount_xtr: "10",
      }]),
    }),
    /Invalid JSON config/u,
  );
});

test("money JSON config rejects duplicate ids and overlapping promotions", async () => {
  const cases: Array<Record<string, string>> = [
    {
      MEDIA_SUBSCRIPTION_PLANS_JSON: JSON.stringify([
        baselineSubscriptionPlans[0],
        { ...baselineSubscriptionPlans[0], title: "Duplicate" },
      ]),
    },
    {
      MEDIA_ACTION_PLANS_JSON: JSON.stringify([
        baselineActionPlans[0],
        { ...baselineActionPlans[0], sku: "other_action" },
      ]),
    },
    {
      MEDIA_PROMOTIONS_JSON: JSON.stringify([{
        promo_key: "promo",
        starts_at: "2026-01-01T00:00:00Z",
        ends_at: "2026-01-02T00:00:00Z",
        items: [
          { sku: "sub_14", promo_amount_xtr: 100, promo_amount_rub: 99 },
          { sku: "sub_14", promo_amount_xtr: 100, promo_amount_rub: 99 },
        ],
      }]),
    },
    {
      MEDIA_PROMOTIONS_JSON: JSON.stringify([
        {
          promo_key: "promo_a",
          starts_at: "2026-01-01T00:00:00Z",
          ends_at: "2026-01-02T00:00:00Z",
          items: [{ sku: "sub_14", promo_amount_xtr: 100, promo_amount_rub: 99 }],
        },
        {
          promo_key: "promo_b",
          starts_at: "2026-01-02T00:00:00Z",
          ends_at: "2026-01-03T00:00:00Z",
          items: [{ sku: "sub_14", promo_amount_xtr: 100, promo_amount_rub: 99 }],
        },
      ]),
    },
  ];

  for (const configCase of cases) {
    await assert.rejects(importConfigWith(configCase), /Invalid JSON config/u);
  }
});
