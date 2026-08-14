import { z } from "zod";

const mediaSubscriptionPlanSchema = z.object({
  sku: z.string().min(1),
  days: z.coerce.number().int().positive(),
  amount_xtr: z.coerce.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  label: z.string().min(1),
  button_text: z.string().min(1),
});

function parseJsonEnv<T>(
  raw: string,
  fallback: T,
  schema: z.ZodType<T>,
): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return schema.parse(parsed);
  } catch {
    return schema.parse(fallback);
  }
}

const defaultMediaSubscriptionPlans = [
  {
    sku: "media_sub_14d",
    days: 14,
    amount_xtr: 100,
    title: "Subscription plan A",
    description: "Extended access plan for chat and media actions.",
    label: "Plan A",
    button_text: "Plan A",
  },
  {
    sku: "media_sub_30d",
    days: 30,
    amount_xtr: 200,
    title: "Subscription plan B",
    description: "Longer access plan for chat and media actions.",
    label: "Plan B",
    button_text: "Plan B",
  },
] satisfies Array<z.input<typeof mediaSubscriptionPlanSchema>>;

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
        {},
        z.record(z.string().min(1), z.string().min(1)),
      ))
    .transform((map) =>
      Object.fromEntries(
        Object.entries(map).map(([key, value]) => [key.trim().toLowerCase(), value.trim()]),
      )),
  MEDIA_SUBSCRIPTION_PLANS_JSON: z
    .string()
    .default(JSON.stringify(defaultMediaSubscriptionPlans))
    .transform((raw) =>
      parseJsonEnv(
        raw,
        defaultMediaSubscriptionPlans,
        z.array(mediaSubscriptionPlanSchema).min(1),
      )),
});

export const config = envSchema.parse(process.env);
