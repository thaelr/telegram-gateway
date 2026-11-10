import { z } from "zod";
import { loadExperimentConfigsFromEnv } from "./modules/experiments/abTesting.js";
import { characterGalleryOrderSchema } from "./telegramUxCopy.js";
export type { TelegramUxCopy } from "./telegramUxCopy.js";

const positiveIntegerSchema = z.number().int().positive();
const telegramUserIdSchema = z.number().int().positive().safe();
const maintenanceTextDefault = "У нас технические работы, они займут 10-15 минут. Извини за неудобства";
const telegramApiBaseUrlDefault = "https://midnight-telegram-proxy.shenko-nik.workers.dev";

const invoicePlanSchema = z.object({
  sku: z.string().min(1),
  amount_xtr: positiveIntegerSchema,
  amount_rub: positiveIntegerSchema.nullable().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  label: z.string().min(1),
  button_text: z.string().min(1),
}).strict();

const mediaSubscriptionPlanSchema = invoicePlanSchema.extend({
  days: positiveIntegerSchema,
  tier: z.enum(['base', 'full']).optional(),
});

const mediaPhotoPlanSchema = invoicePlanSchema;

const mediaActionPlanSchema = invoicePlanSchema.extend({
  feature_key: z.string().min(1),
  scene_unlock_upgrade: z.object({
    amount_xtr: positiveIntegerSchema,
    amount_rub: positiveIntegerSchema.nullable(),
    discount_percent: z.number().int().min(0).max(99),
  }).strict().optional(),
}).superRefine((plan, ctx) => {
  if (plan.scene_unlock_upgrade && plan.feature_key !== "video_pass") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scene_unlock_upgrade"], message: "Only video_pass supports scene_unlock_upgrade" });
  }
});

const mediaPromotionItemSchema = z.object({
  sku: z.string().min(1),
  promo_amount_xtr: positiveIntegerSchema,
  promo_amount_rub: positiveIntegerSchema.nullable().optional(),
}).strict();

const mediaPromotionSchema = z.object({
  promo_key: z.string().min(1),
  items: z.array(mediaPromotionItemSchema).min(1),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.starts_at) > Date.parse(value.ends_at)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "starts_at must be before or equal to ends_at",
      path: ["starts_at"],
    });
  }
  addUniqueStringIssue(
    value.items.map((item) => item.sku),
    "Promotion item skus must be unique",
    ctx,
    ["items"],
  );
});

const mediaSubscriptionPlansSchema = z.array(mediaSubscriptionPlanSchema).min(1).superRefine((value, ctx) => {
  addUniqueStringIssue(value.map((plan) => plan.sku), "Subscription plan skus must be unique", ctx);
  if (value.filter(plan => plan.tier === 'full').length > 1) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Configure one Full plan'});
  value.forEach((plan,index) => { if(plan.tier === 'full' && plan.days !== 30) ctx.addIssue({code:z.ZodIssueCode.custom,path:[index,'days'],message:'Full lasts 30 days'}); });
});

const mediaPhotoPlansSchema = z.array(mediaPhotoPlanSchema).min(1).superRefine((value, ctx) => {
  addUniqueStringIssue(value.map((plan) => plan.sku), "Photo plan skus must be unique", ctx);
});

const mediaActionPlansSchema = z.array(mediaActionPlanSchema).min(1).superRefine((value, ctx) => {
  addUniqueStringIssue(value.map((plan) => plan.sku), "Action plan skus must be unique", ctx);
  addUniqueStringIssue(value.map((plan) => plan.feature_key), "Action plan feature keys must be unique", ctx);
});

const mediaPromotionsSchema = z.array(mediaPromotionSchema).superRefine((value, ctx) => {
  for (let leftIndex = 0; leftIndex < value.length; leftIndex += 1) {
    const left = value[leftIndex]!;
    const leftStart = Date.parse(left.starts_at);
    const leftEnd = Date.parse(left.ends_at);
    const leftSkus = new Set(left.items.map((item) => item.sku));

    for (let rightIndex = leftIndex + 1; rightIndex < value.length; rightIndex += 1) {
      const right = value[rightIndex]!;
      const rightStart = Date.parse(right.starts_at);
      const rightEnd = Date.parse(right.ends_at);
      const overlaps = leftStart <= rightEnd && rightStart <= leftEnd;
      if (!overlaps) {
        continue;
      }

      const duplicateSku = right.items.find((item) => leftSkus.has(item.sku))?.sku;
      if (duplicateSku) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Promotion windows for sku ${duplicateSku} must not overlap`,
          path: [rightIndex, "items"],
        });
      }
    }
  }
});

const rewardDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["scene_unlock", "scene_skip", "photo_unlock"]),
    amount: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("subscription"),
    days: z.number().int().positive(),
  }).strict(),
]);

const rewardSlotSchema = z.object({
  slot: z.number().int().positive(),
  campaign_id: z.string().trim().min(1),
  enabled: z.boolean(),
  valid_from: z.string().datetime({ offset: true }).nullable().optional(),
  valid_until: z.string().datetime({ offset: true }).nullable().optional(),
  rewards: z.array(rewardDefinitionSchema).min(1),
  success_text: z.string().min(1),
  next_action: z.string().trim().min(1).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.valid_from
    && value.valid_until
    && Date.parse(value.valid_from) > Date.parse(value.valid_until)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "valid_from must be before or equal to valid_until",
      path: ["valid_from"],
    });
  }
});

export type MediaSubscriptionPlan = z.infer<typeof mediaSubscriptionPlanSchema>;
export type MediaPhotoPlan = z.infer<typeof mediaPhotoPlanSchema>;
export type MediaActionPlan = z.infer<typeof mediaActionPlanSchema>;
export type MediaPromotion = z.infer<typeof mediaPromotionSchema>;

const legalUrlsSchema = z.record(
  z.string().trim().min(1),
  z.object({
    terms: z.string().trim().url().optional(),
    privacy: z.string().trim().url().optional(),
  }).strict(),
);

function parseJsonEnv<T>(
  raw: string,
  schema: z.ZodType<T>,
): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return schema.parse(parsed);
  } catch (error) {
    throw new Error(
      `Invalid JSON config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function addUniqueStringIssue(
  values: string[],
  message: string,
  ctx: z.RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path,
    });
  }
}

const rawEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  INTERNAL_API_KEY: z.string().min(1),
  INTERNAL_API_KEY_HEADER: z.string().min(1).default("x-internal-api-key"),
  WEB_ENABLED: z.string().default("false").pipe(z.enum(["true", "false"])).transform((value) => value === "true"),
  WEB_ALLOWED_ORIGINS: z.string().default('').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean))
    .refine(origins => origins.every(origin => {
      try { const url = new URL(origin); return url.origin === origin && !url.username && !url.password
        && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); }
      catch { return false; }
    }), 'WEB_ALLOWED_ORIGINS requires exact HTTPS origins or local HTTP origins'),
  TELEGRAM_LOGIN_CLIENT_ID: z.string().trim().default('').refine(value => value === '' || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))), 'Invalid Telegram Login client ID'),
  SUPABASE_TELEGRAM_PROVIDER: z.string().trim().default('').refine(value => value === '' || /^custom:[a-z0-9][a-z0-9:-]{0,42}$/.test(value), 'Invalid Supabase Telegram provider identifier'),
  WEB_CHARACTER_GALLERY_JSON: z.string().default('{}').transform(raw => parseJsonEnv(raw,
    z.record(z.string().regex(/^[1-9]\d*$/), z.record(z.string().regex(/^[a-z][a-z0-9-]*$/),
      z.array(z.string().url().refine(value => new URL(value).protocol === 'https:', 'Gallery photos require HTTPS')))))),
  SUPABASE_URL: z.string().trim().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().optional(),
  MEDIA_VIDEO_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MEDIA_FULL_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(0),
  MEDIA_UPGRADE_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(0),
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().optional(),
  WEB_N8N_WEBHOOK_URL: z.string().trim().optional(),
  WEB_N8N_WEBHOOK_SECRET: z.string().trim().optional(),
  WEB_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  WEB_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WEB_DELIVERY_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  TELEGRAM_CHARACTER_GALLERY_ORDER_JSON: z
    .string()
    .transform((raw) => parseJsonEnv(raw, characterGalleryOrderSchema)),
  TELEGRAM_CHARACTER_VOTE_URL: z.string().trim().url(),
  PUBLIC_OFFER_URL: z.string().trim().url(),
  LEGAL_URLS_JSON: z
    .string()
    .default("{}")
    .transform((raw) => parseJsonEnv(raw, legalUrlsSchema)),
  GATEWAY_PUBLIC_URL: z.string().trim().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().trim().optional(),
  TG_BOT_TOKEN: z.string().min(1),
  TELEGRAM_API_BASE_URL: z.string().trim().url()
    .refine((value) => {
      const url = new URL(value);
      const localHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]", "telegram-mock"]);
      return !url.username && !url.password && !url.search && !url.hash
        && (url.protocol === "https:" || (url.protocol === "http:" && localHttpHosts.has(url.hostname)));
    }, "TELEGRAM_API_BASE_URL requires HTTPS or a local test HTTP host without credentials, query, or hash")
    .default(telegramApiBaseUrlDefault)
    .transform((value) => value.replace(/\/+$/u, "")),
  SBP_ENABLED: z
    .string()
    .optional()
    .transform((value) => value?.trim().toLowerCase() === "true"),
  SBP_API_BASE_URL: z.string().trim().optional(),
  SBP_MERCHANT_ID: z.string().trim().optional(),
  SBP_API_SECRET: z.string().trim().optional(),
  SBP_RETURN_URL: z.string().trim().optional(),
  SBP_FAILED_URL: z.string().trim().optional(),
  NOWPAYMENTS_ENABLED: z.string().default("false").pipe(z.enum(["true", "false"])).transform((value) => value === "true"),
  NOWPAYMENTS_API_BASE_URL: z.string().trim().default("https://api.nowpayments.io/v1"),
  NOWPAYMENTS_API_KEY: z.string().trim().optional(),
  NOWPAYMENTS_IPN_SECRET: z.string().trim().optional(),
  NOWPAYMENTS_IPN_URL: z.string().trim().optional(),
  NOWPAYMENTS_SUCCESS_URL: z.string().trim().optional(),
  NOWPAYMENTS_CANCEL_URL: z.string().trim().optional(),
  NOWPAYMENTS_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  MAINTENANCE_MODE: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((value) => value === "true"),
  MAINTENANCE_TEXT: z.string().min(1).default(maintenanceTextDefault),
  MAINTENANCE_ALLOWED_USER_IDS_JSON: z
    .string()
    .default("[]")
    .transform((raw) => parseJsonEnv(raw, z.array(telegramUserIdSchema))),
  DAILY_FREE_LIMITS_JSON: z.string().optional().transform(raw => raw === undefined ? undefined :
    parseJsonEnv(raw,z.object({messages:positiveIntegerSchema,photos:positiveIntegerSchema}).strict())),
  BUSINESS_TIME_ZONE: z.literal("Europe/Moscow").default("Europe/Moscow"),
  SCENE_ACCESS_DAYS: z.coerce.number().int().positive().safe().default(7),

  MEDIA_PAYMENT_CURRENCY: z.string().min(1).default("XTR"),
  MEDIA_STORAGE_BASE_URL: z
    .string()
    .url()
    .default("https://media.example.com"),
  MEDIA_DEFAULT_BUCKET_NAME: z.string().min(1).default("media_bucket"),
  MEDIA_BUCKET_ALIAS_MAP_JSON: z
    .string()
    .default("{}")
    .transform((raw) =>
      parseJsonEnv(
        raw,
        z.record(z.string().min(1), z.string().min(1)),
      ))
    .transform((map) =>
      Object.fromEntries(
        Object.entries(map).map(([key, value]) => [key.trim().toLowerCase(), value.trim()]),
      )),
  MEDIA_SUBSCRIPTION_PLANS_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        mediaSubscriptionPlansSchema,
      )),
  MEDIA_PHOTO_PLANS_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        mediaPhotoPlansSchema,
      )),
  MEDIA_ACTION_PLANS_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        mediaActionPlansSchema,
      )),
  MEDIA_PROMOTIONS_JSON: z
    .string()
    .default("[]")
    .transform((raw) =>
      parseJsonEnv(
        raw,
        mediaPromotionsSchema,
      )),
  REWARD_SLOTS_JSON: z
    .string()
    .default("[]")
    .transform((raw) =>
      parseJsonEnv(raw, z.array(rewardSlotSchema)))
    .refine(
      (slots) => new Set(slots.map((slot) => slot.slot)).size === slots.length,
      "Reward slots must be unique",
    )
    .refine(
      (slots) => new Set(slots.map((slot) => slot.campaign_id)).size === slots.length,
      "Reward campaign ids must be unique",
    ),
});

const parsedEnv = rawEnvSchema.parse(process.env);

if (parsedEnv.SBP_ENABLED || parsedEnv.NOWPAYMENTS_ENABLED) {
  const pass = parsedEnv.MEDIA_ACTION_PLANS_JSON.find(plan => plan.feature_key === "video_pass");
  if (pass?.scene_unlock_upgrade?.amount_rub === null) {
    throw new Error("MEDIA_ACTION_PLANS_JSON video_pass.scene_unlock_upgrade.amount_rub must be positive with RUB payments enabled");
  }
}

if (parsedEnv.NOWPAYMENTS_ENABLED) {
  for (const key of ["NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET", "NOWPAYMENTS_IPN_URL", "NOWPAYMENTS_SUCCESS_URL", "NOWPAYMENTS_CANCEL_URL"] as const) {
    if (!parsedEnv[key]) throw new Error(`NOWPayments is enabled but ${key} is missing`);
  }
  for (const key of ["NOWPAYMENTS_API_BASE_URL", "NOWPAYMENTS_IPN_URL", "NOWPAYMENTS_SUCCESS_URL", "NOWPAYMENTS_CANCEL_URL"] as const) {
    const url = new URL(parsedEnv[key]!);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${key} must use HTTPS without URL credentials`);
  }
}

if (parsedEnv.WEB_ENABLED) {
  for (const key of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "WEB_N8N_WEBHOOK_URL", "WEB_N8N_WEBHOOK_SECRET"] as const) {
    if (!parsedEnv[key]) throw new Error(`Web API is enabled but ${key} is missing`);
  }
  for (const key of ["SUPABASE_URL", "WEB_N8N_WEBHOOK_URL"] as const) {
    const url = new URL(parsedEnv[key]!);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(`${key} must use HTTPS without URL credentials`);
    }
  }
}

const normalizedSbpConfig = {
  SBP_ENABLED: parsedEnv.SBP_ENABLED,
  SBP_API_BASE_URL: parsedEnv.SBP_API_BASE_URL?.trim() || null,
  SBP_MERCHANT_ID: parsedEnv.SBP_MERCHANT_ID?.trim() || null,
  SBP_API_SECRET: parsedEnv.SBP_API_SECRET?.trim() || null,
  SBP_RETURN_URL: parsedEnv.SBP_RETURN_URL?.trim() || null,
  SBP_FAILED_URL: parsedEnv.SBP_FAILED_URL?.trim() || null,
} as const;

const gatewayPublicUrl =
  (parsedEnv.GATEWAY_PUBLIC_URL?.replace(/\/+$/u, "") || null)
  ?? (parsedEnv.RAILWAY_PUBLIC_DOMAIN
    ? `https://${parsedEnv.RAILWAY_PUBLIC_DOMAIN.replace(/\/+$/u, "")}`
    : null);

if (normalizedSbpConfig.SBP_ENABLED) {
  const missingKeys = [
    ["SBP_API_BASE_URL", normalizedSbpConfig.SBP_API_BASE_URL],
    ["SBP_MERCHANT_ID", normalizedSbpConfig.SBP_MERCHANT_ID],
    ["SBP_API_SECRET", normalizedSbpConfig.SBP_API_SECRET],
    ["SBP_RETURN_URL", normalizedSbpConfig.SBP_RETURN_URL],
    ["SBP_FAILED_URL", normalizedSbpConfig.SBP_FAILED_URL],
    ["GATEWAY_PUBLIC_URL", gatewayPublicUrl],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingKeys.length > 0) {
    throw new Error(
      `SBP is enabled but required env vars are missing: ${missingKeys.join(", ")}`,
    );
  }

  z.string().url().parse(normalizedSbpConfig.SBP_API_BASE_URL);
  z.string().url().parse(normalizedSbpConfig.SBP_RETURN_URL);
  z.string().url().parse(normalizedSbpConfig.SBP_FAILED_URL);
  z.string().url().parse(gatewayPublicUrl);
}

export const config = {
  ...parsedEnv,
  ...normalizedSbpConfig,
  // The legacy message limit applies only when the combined config is absent.
  DAILY_FREE_LIMITS_JSON: parsedEnv.DAILY_FREE_LIMITS_JSON ?? {
    messages: z.coerce.number().int().positive().parse(process.env.TURN_LIMIT ?? 20), photos: 3
  },
  TURN_LIMIT_RESET_TEXT: "00:00 МСК",
  GATEWAY_PUBLIC_URL: gatewayPublicUrl,
  EXPERIMENTS: loadExperimentConfigsFromEnv(process.env),
};
