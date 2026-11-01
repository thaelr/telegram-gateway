export type TelegramLanguage = string;

const LANGUAGE_PATTERN = /^[a-z][a-z0-9-]*$/u;

export function parseTelegramLanguage(value: unknown): TelegramLanguage | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return LANGUAGE_PATTERN.test(normalized) ? normalized : null;
}
