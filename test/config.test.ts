import test from "node:test";
import assert from "node:assert/strict";

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
  "PUBLIC_OFFER_URL",
  "TG_BOT_TOKEN",
  "TELEGRAM_PROMO_EFFECT_ID",
  "TELEGRAM_FAST_SCENE_EFFECT_ID",
  "TELEGRAM_ROLEPLAY_SCENE_EFFECT_ID",
  "TELEGRAM_CHARACTER_GALLERY_ORDER_JSON",
  "TELEGRAM_CHARACTER_VOTE_URL",
  "MEDIA_SUBSCRIPTION_PLANS_JSON",
  "MEDIA_PHOTO_PLANS_JSON",
  "MEDIA_ACTION_PLANS_JSON",
  "MEDIA_PROMOTIONS_JSON",
  "MAINTENANCE_MODE",
  "MAINTENANCE_TEXT",
  "MAINTENANCE_ALLOWED_USER_IDS_JSON",
] as const;

let importId = 0;

async function importConfigWith(overrides: Record<string, string>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of envKeys) {
    previous.set(key, process.env[key]);
  }

  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
  process.env.INTERNAL_API_KEY = "test-internal-key";
  process.env.PUBLIC_OFFER_URL = "https://offer.example/terms";
  process.env.TG_BOT_TOKEN = "test-telegram-bot-token";
  process.env.TELEGRAM_PROMO_EFFECT_ID = "promo-effect";
  process.env.TELEGRAM_FAST_SCENE_EFFECT_ID = "fast-scene-effect";
  process.env.TELEGRAM_ROLEPLAY_SCENE_EFFECT_ID = "roleplay-scene-effect";
  process.env.TELEGRAM_CHARACTER_GALLERY_ORDER_JSON = "[1,2,3,4]";
  process.env.TELEGRAM_CHARACTER_VOTE_URL = "https://example.com/vote";
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

test("character gallery runtime config validates order ids and vote URL", async () => {
  for (const order of [[1, 1], [0], [1.5]]) {
    await assert.rejects(
      importConfigWith({
        TELEGRAM_CHARACTER_GALLERY_ORDER_JSON: JSON.stringify(order),
      }),
      /Invalid JSON config/u,
    );
  }

  await assert.rejects(
    importConfigWith({ TELEGRAM_CHARACTER_VOTE_URL: "not-a-url" }),
    /Invalid url/u,
  );
});

test("maintenance whitelist accepts only positive numeric Telegram user ids", async () => {
  await importConfigWith({
    MAINTENANCE_MODE: "true",
    MAINTENANCE_ALLOWED_USER_IDS_JSON: "[123,456]",
  });

  for (const invalid of ["{}", "[0]", "[-1]", "[1.5]", "[9007199254740992]", '["123"]']) {
    await assert.rejects(
      importConfigWith({ MAINTENANCE_ALLOWED_USER_IDS_JSON: invalid }),
      /Invalid JSON config/u,
    );
  }

  await assert.rejects(
    importConfigWith({ MAINTENANCE_MODE: "enabled" }),
    /Invalid enum value/u,
  );
});
