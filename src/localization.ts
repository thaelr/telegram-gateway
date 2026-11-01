import { telegramUxCopySchema, type TelegramUxCopy } from "./telegramUxCopy.js";

export type SupportedLocale = "ru" | "en";
export type LocalizationDictionary = Record<string, unknown>;

export interface LocalizationStore {
  load(locale: string, namespace: string): Promise<LocalizationDictionary | null>;
}

function isRecord(value: unknown): value is LocalizationDictionary {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mergeDictionaries(
  base: LocalizationDictionary,
  overlay: LocalizationDictionary | null,
): LocalizationDictionary {
  if (!overlay) return { ...base };
  const result: LocalizationDictionary = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value)
      ? mergeDictionaries(current, value)
      : value;
  }
  return result;
}

function normalizeLocale(locale: string | null | undefined): string {
  const normalized = String(locale ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/u.test(normalized) ? normalized : "ru";
}

type CacheEntry = {
  expiresAt: number;
  value: LocalizationDictionary | null;
};

export class LocalizationService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: LocalizationStore,
    private readonly telegramCompatibilityCopy: TelegramUxCopy,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(locale: string, namespace: string): Promise<LocalizationDictionary | null> {
    const key = `${locale}\u0000${namespace}`;
    const cached = this.cache.get(key);
    const currentTime = this.now();
    if (cached && cached.expiresAt > currentTime) return cached.value;

    const value = await this.store.load(locale, namespace);
    this.cache.set(key, { value, expiresAt: currentTime + this.ttlMs });
    return value;
  }

  async getNamespace(
    locale: string | null | undefined,
    namespace: string,
    compatibilityFallback: LocalizationDictionary = {},
  ): Promise<LocalizationDictionary> {
    const selectedLocale = normalizeLocale(locale);
    const russian = await this.load("ru", namespace);
    const selected = selectedLocale === "ru"
      ? russian
      : await this.load(selectedLocale, namespace);
    return mergeDictionaries(
      mergeDictionaries(compatibilityFallback, russian),
      selected,
    );
  }

  async getTelegramCopy(locale: string | null | undefined): Promise<TelegramUxCopy> {
    const dictionary = await this.getNamespace(
      locale,
      "telegram",
      this.telegramCompatibilityCopy as unknown as LocalizationDictionary,
    );
    const localized = telegramUxCopySchema.parse(dictionary);

    // These values steer runtime behavior and are intentionally not translations.
    // Keep them owned by validated runtime config even if a malformed localization
    // import contains fields with the same shape.
    localized.promo.effect_id = this.telegramCompatibilityCopy.promo.effect_id;
    localized.scene_mode.transition.fast.effect_id =
      this.telegramCompatibilityCopy.scene_mode.transition.fast.effect_id;
    localized.scene_mode.transition.roleplay.effect_id =
      this.telegramCompatibilityCopy.scene_mode.transition.roleplay.effect_id;
    localized.character_gallery.order = [
      ...this.telegramCompatibilityCopy.character_gallery.order,
    ];
    localized.character_gallery.vote_url =
      this.telegramCompatibilityCopy.character_gallery.vote_url;

    return localized;
  }

  async translate(
    locale: string | null | undefined,
    namespace: string,
    key: string,
    parameters: Record<string, string | number> = {},
  ): Promise<string | null> {
    const dictionary = await this.getNamespace(locale, namespace);
    let value: unknown = dictionary;
    for (const segment of key.split(".")) {
      if (!segment || !isRecord(value)) return null;
      value = value[segment];
    }
    if (typeof value !== "string") return null;
    return Object.entries(parameters).reduce(
      (text, [parameter, replacement]) =>
        text.replaceAll(`{${parameter}}`, String(replacement)),
      value,
    );
  }

  clear(): void {
    this.cache.clear();
  }
}
