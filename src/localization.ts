import { z } from "zod";
import { telegramUxCopySchema, type TelegramUxCopy } from "./telegramUxCopy.js";

export type LocalizationDictionary = Record<string, unknown>;

export interface LocalizationStore {
  load(locale: string, namespace: string): Promise<LocalizationDictionary | null>;
  listLanguages?(): Promise<Array<{ locale: string; metadata: unknown }>>;
}

export type LanguageOption = {
  locale: string;
  display_name: string;
  sort_order: number;
};

export type TelegramRuntimeSettings = {
  characterGalleryOrder: number[];
  characterVoteUrl: string;
};

export type PaymentChannel = "telegram" | "web";
export type ConfiguredPaymentMethod = "stars" | "sbp";

const languageMetadataSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  enabled: z.literal(true),
  sort_order: z.number().int(),
}).passthrough();

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

function parseLocale(locale: string | null | undefined): string | null {
  const normalized = String(locale ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/u.test(normalized) ? normalized : null;
}

function normalizeLocale(locale: string | null | undefined): string {
  return parseLocale(locale) ?? "ru";
}

type CacheEntry = {
  expiresAt: number;
  value: LocalizationDictionary | null;
};

export class LocalizationService {
  private readonly cache = new Map<string, CacheEntry>();
  private languageCache: { expiresAt: number; value: LanguageOption[] } | null = null;

  constructor(
    private readonly store: LocalizationStore,
    private readonly telegramRuntimeSettings: TelegramRuntimeSettings,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxCacheEntries = 256,
  ) {}

  private async load(locale: string, namespace: string): Promise<LocalizationDictionary | null> {
    const key = `${locale}\u0000${namespace}`;
    const cached = this.cache.get(key);
    const currentTime = this.now();
    if (cached && cached.expiresAt > currentTime) return cached.value;

    const value = await this.store.load(locale, namespace);
    if (this.cache.size >= this.maxCacheEntries) {
      for (const [cacheKey, entry] of this.cache) {
        if (entry.expiresAt <= currentTime) this.cache.delete(cacheKey);
      }
      while (this.cache.size >= this.maxCacheEntries) {
        const oldestKey = this.cache.keys().next().value as string | undefined;
        if (oldestKey == null) break;
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value, expiresAt: currentTime + this.ttlMs });
    return value;
  }

  async getEnabledLanguages(): Promise<LanguageOption[]> {
    const currentTime = this.now();
    if (this.languageCache && this.languageCache.expiresAt > currentTime) {
      return this.languageCache.value.map((value) => ({ ...value }));
    }
    const rows = await this.store.listLanguages?.() ?? [];
    const languages = rows.flatMap((row) => {
      const locale = parseLocale(row.locale);
      const parsed = languageMetadataSchema.safeParse(row.metadata);
      return parsed.success && locale != null && locale === row.locale
        ? [{ locale, display_name: parsed.data.display_name, sort_order: parsed.data.sort_order }]
        : [];
    }).sort((left, right) => left.sort_order - right.sort_order || left.locale.localeCompare(right.locale));
    this.languageCache = { value: languages, expiresAt: currentTime + this.ttlMs };
    return languages.map((value) => ({ ...value }));
  }

  async isEnabledLanguage(locale: string | null | undefined): Promise<boolean> {
    const normalized = parseLocale(locale);
    if (normalized == null) return false;
    return (await this.getEnabledLanguages()).some((item) => item.locale === normalized);
  }

  async getNamespace(
    locale: string | null | undefined,
    namespace: string,
  ): Promise<LocalizationDictionary> {
    const selectedLocale = normalizeLocale(locale);
    const russian = await this.load("ru", namespace);
    const selected = selectedLocale === "ru"
      ? russian
      : await this.load(selectedLocale, namespace);
    return mergeDictionaries(russian ?? {}, selected);
  }

  async getExactNamespace(
    locale: string | null | undefined,
    namespace: string,
  ): Promise<LocalizationDictionary | null> {
    const normalized = parseLocale(locale);
    return normalized == null ? null : this.load(normalized, namespace);
  }

  async getPaymentMethods(
    locale: string | null | undefined,
    channel: PaymentChannel,
  ): Promise<ConfiguredPaymentMethod[]> {
    const dictionary = await this.getExactNamespace(locale, "payment_methods");
    const configured = dictionary?.[channel];
    const methods = Array.isArray(configured)
      ? configured.filter((value): value is ConfiguredPaymentMethod => value === "stars" || value === "sbp")
      : [];
    const unique = [...new Set(methods)];
    if (channel === "telegram" && !unique.includes("stars")) unique.push("stars");
    return channel === "telegram" ? unique : unique.filter((value) => value !== "stars");
  }

  async getTelegramCopy(locale: string | null | undefined): Promise<TelegramUxCopy> {
    const dictionary = await this.getNamespace(locale, "telegram");
    const localized = telegramUxCopySchema.parse(dictionary);

    // These values steer runtime behavior and are intentionally not translations.
    // Keep them owned by validated runtime config even if a malformed localization
    // import contains fields with the same shape.
    localized.character_gallery.order = [...this.telegramRuntimeSettings.characterGalleryOrder];
    localized.character_gallery.vote_url = this.telegramRuntimeSettings.characterVoteUrl;

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
    this.languageCache = null;
  }
}
