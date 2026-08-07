import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  TURN_LIMIT: z.coerce.number().int().positive().default(15),
  BUSINESS_TIME_ZONE: z.string().min(1).default("Europe/Moscow"),
  TURN_LIMIT_RESET_TEXT: z.string().min(1).default("00:00 МСК"),
});

export const config = envSchema.parse(process.env);
