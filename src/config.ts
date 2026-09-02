import { z } from "zod";

const invoicePlanSchema = z.object({
  sku: z.string().min(1),
  amount_xtr: z.coerce.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  label: z.string().min(1),
  button_text: z.string().min(1),
});

const mediaSubscriptionPlanSchema = invoicePlanSchema.extend({
  days: z.coerce.number().int().positive(),
});

const mediaPhotoPlanSchema = invoicePlanSchema;

const mediaActionPlanSchema = invoicePlanSchema.extend({
  feature_key: z.string().min(1),
});

const mediaPromotionItemSchema = z.object({
  sku: z.string().min(1),
  promo_amount_xtr: z.coerce.number().int().positive(),
});

const mediaPromotionSchema = z.object({
  promo_key: z.string().min(1),
  items: z.array(mediaPromotionItemSchema).min(1),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
}).superRefine((value, ctx) => {
  if (Date.parse(value.starts_at) > Date.parse(value.ends_at)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "starts_at must be before or equal to ends_at",
      path: ["starts_at"],
    });
  }
});

const textSchema = z.string().min(1);

const telegramUxCopySchema = z.object({
  terms: z.object({
    message: textSchema,
    open_button: textSchema,
    accept_button: textSchema,
  }),
  scene_reset: z.object({
    confirm: textSchema,
    yes_button: textSchema,
    no_button: textSchema,
    processing: textSchema,
    continue: textSchema,
  }),
  promo: z.object({
    activated: textSchema,
    effect_id: textSchema,
  }),
  paysupport: z.object({
    message_html: textSchema,
  }),
  scene_mode: z.object({
    choice: textSchema,
    roleplay_button: textSchema,
    fast_button: textSchema,
    back_button: textSchema,
    transition: z.object({
      fast: z.object({
        text: textSchema,
        effect_id: textSchema,
      }),
      roleplay: z.object({
        text: textSchema,
        effect_id: textSchema,
      }),
    }),
  }),
  character_gallery: z.object({
    heading: textSchema,
    empty: textSchema,
    characters: z.record(z.string().min(1), z.object({
      gallery_title: textSchema,
      gallery_body: textSchema,
      mode_intro: textSchema,
      roleplay_description_html: textSchema,
      fast_description_html: textSchema,
    })),
  }),
  subscription: z.object({
    active: textSchema,
    daily_limit_offer: textSchema,
    command_offer: textSchema,
  }),
  media: z.object({
    get_photo_button: textSchema,
    more_photo_button: textSchema,
    generating: textSchema,
    pay_button: textSchema,
    scene_unlock_button: textSchema,
    prev_button: textSchema,
    next_button: textSchema,
  }),
  callbacks: z.object({
    newscene_yes: textSchema,
    newscene_no: textSchema,
    terms_accept: textSchema,
    character_select: textSchema,
    character_back: textSchema,
    scene_mode_fast: textSchema,
    scene_mode_roleplay: textSchema,
    scene_access_activated: textSchema,
  }),
  payment_errors: z.object({
    expired: textSchema,
    stale: textSchema,
    different_scene: textSchema,
    subscription_active: textSchema,
    scene_already_unlocked: textSchema,
  }),
});

export type MediaSubscriptionPlan = z.infer<typeof mediaSubscriptionPlanSchema>;
export type MediaPhotoPlan = z.infer<typeof mediaPhotoPlanSchema>;
export type MediaActionPlan = z.infer<typeof mediaActionPlanSchema>;
export type MediaPromotion = z.infer<typeof mediaPromotionSchema>;
export type TelegramUxCopy = z.infer<typeof telegramUxCopySchema>;

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

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  INTERNAL_API_KEY: z.string().min(1),
  INTERNAL_API_KEY_HEADER: z.string().min(1).default("x-internal-api-key"),
  TURN_LIMIT: z.coerce.number().int().positive().default(20),
  BUSINESS_TIME_ZONE: z.string().min(1).default("Europe/Moscow"),
  TURN_LIMIT_RESET_TEXT: z.string().min(1).default("00:00 МСК"),
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
        z.array(mediaSubscriptionPlanSchema).min(1),
      )),
  MEDIA_PHOTO_PLANS_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        z.array(mediaPhotoPlanSchema).min(1),
      )),
  MEDIA_ACTION_PLANS_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        z.array(mediaActionPlanSchema).min(1),
      )),
  MEDIA_PROMOTIONS_JSON: z
    .string()
    .default("[]")
    .transform((raw) =>
      parseJsonEnv(
        raw,
        z.array(mediaPromotionSchema),
      )),
  TELEGRAM_UX_COPY_JSON: z
    .string()
    .transform((raw) =>
      parseJsonEnv(
        raw,
        telegramUxCopySchema,
      )),
});

export const config = envSchema.parse(process.env);
