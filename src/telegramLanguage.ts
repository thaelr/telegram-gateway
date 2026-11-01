export type TelegramLanguage = "ru" | "en";

export function parseTelegramLanguage(value: unknown): TelegramLanguage | null {
  return value === "ru" || value === "en" ? value : null;
}
