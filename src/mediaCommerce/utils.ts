import { randomBytes } from "node:crypto";

export function normalizeString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function normalizeLowerString(value: string | null | undefined): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export function normalizeNonNegativeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

export function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseJsonObject(
  value: unknown,
): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseJsonArray(value: unknown): unknown[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function isExpired(isoString: string | null | undefined): boolean {
  if (!isoString) return false;
  const timestamp = Date.parse(isoString);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

export function buildRandomToken(prefix: "btn" | "inv"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export const INVOICE_TTL_MS = 30 * 60 * 1000;

export function extractPanelFromRawUpdate(
  rawUpdate: unknown,
): { panel_text: string | null; panel_entities_json: unknown[] | null } {
  const update = parseJsonObject(rawUpdate);
  const callback = parseJsonObject(update?.callback_query);
  const message = parseJsonObject(callback?.message);
  const text =
    typeof message?.text === "string"
      ? normalizeString(message.text)
      : typeof message?.caption === "string"
        ? normalizeString(message.caption)
        : null;
  const entities =
    parseJsonArray(message?.entities)
    ?? parseJsonArray(message?.caption_entities)
    ?? null;

  return {
    panel_text: text,
    panel_entities_json: entities,
  };
}
