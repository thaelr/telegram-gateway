import { sql } from "./db.js";
import type {
  LocalizationDictionary,
  LocalizationStore,
} from "./localization.js";

function isRecord(value: unknown): value is LocalizationDictionary {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function postgresCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export class LocalizationRepository implements LocalizationStore {
  constructor(private readonly query: typeof sql = sql) {}

  async load(locale: string, namespace: string): Promise<LocalizationDictionary | null> {
    try {
      const rows = await this.query<Array<{ copy_json: unknown }>>`
        SELECT copy_json
        FROM public.ui_localizations
        WHERE locale = ${locale}::text
          AND namespace = ${namespace}::text
        LIMIT 1
      `;
      return isRecord(rows[0]?.copy_json) ? rows[0].copy_json : null;
    } catch (error) {
      // During the staged rollout the Gateway may start before the schema migration.
      // Only that known case falls back to the existing env copy; other DB failures surface.
      if (postgresCode(error) === "42P01") return null;
      throw error;
    }
  }

  async listLanguages(): Promise<Array<{ locale: string; metadata: unknown }>> {
    try {
      return await this.query<Array<{ locale: string; metadata: unknown }>>`
        SELECT locale, copy_json -> '_language' AS metadata
        FROM public.ui_localizations
        WHERE namespace = 'telegram'
          AND jsonb_typeof(copy_json -> '_language') = 'object'
          AND COALESCE((copy_json -> '_language' ->> 'enabled')::boolean, false)
        ORDER BY
          COALESCE((copy_json -> '_language' ->> 'sort_order')::integer, 2147483647),
          locale
      `;
    } catch (error) {
      if (postgresCode(error) === "42P01") return [];
      throw error;
    }
  }
}
