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

export type MediaSubscriptionPlan = z.infer<typeof mediaSubscriptionPlanSchema>;
export type MediaPhotoPlan = z.infer<typeof mediaPhotoPlanSchema>;
export type MediaActionPlan = z.infer<typeof mediaActionPlanSchema>;

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
  TURN_LIMIT: z.coerce.number().int().positive().default(15),
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
});

export const config = envSchema.parse(process.env);
