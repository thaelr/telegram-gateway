export type TelegramLanguage = "ru" | "en";

const RUSSIAN_FALLBACK_LANGUAGE_CODES = new Set([
  "az",
  "be",
  "hy",
  "ka",
  "kk",
  "ky",
  "ru",
  "tg",
  "tk",
  "uk",
  "uz",
]);

type TelegramUser = {
  id?: unknown;
  language_code?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedUser(
  update: Record<string, unknown>,
  updateField: string,
  userField: "from" | "user" = "from",
): TelegramUser | null {
  const container = asRecord(update[updateField]);
  return asRecord(container?.[userField]) as TelegramUser | null;
}

export function normalizeTelegramLanguageCode(
  languageCode: unknown,
): TelegramLanguage | null {
  if (typeof languageCode !== "string") return null;

  const primaryCode = languageCode.trim().toLowerCase().split(/[-_]/u, 1)[0];
  if (!primaryCode) return null;
  if (primaryCode === "en") return "en";
  return RUSSIAN_FALLBACK_LANGUAGE_CODES.has(primaryCode) ? "ru" : "en";
}

export function extractTelegramLanguage(
  rawUpdate: unknown,
  sourceUserId: number | null | undefined,
): TelegramLanguage | null {
  const update = asRecord(rawUpdate);
  if (!update || sourceUserId == null) return null;

  const candidates = [
    nestedUser(update, "message"),
    nestedUser(update, "callback_query"),
    nestedUser(update, "pre_checkout_query"),
    nestedUser(update, "my_chat_member"),
    nestedUser(update, "edited_message"),
    nestedUser(update, "chat_member"),
    nestedUser(update, "chat_join_request"),
    nestedUser(update, "shipping_query"),
    nestedUser(update, "inline_query"),
    nestedUser(update, "chosen_inline_result"),
    nestedUser(update, "poll_answer", "user"),
  ];

  const sourceUser = candidates.find((candidate) =>
    candidate != null && Number(candidate.id) === sourceUserId
  );
  return normalizeTelegramLanguageCode(sourceUser?.language_code);
}
