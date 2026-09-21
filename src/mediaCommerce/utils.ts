import { createHash, randomBytes } from "node:crypto";
import {
  normalizeNonNegativeInteger as normalizeStrictNonNegativeInteger,
  normalizePositiveInteger as normalizeStrictPositiveInteger,
} from "../numeric.js";
import {
  parseJsonArray as parseLenientJsonArray,
  parseJsonObject as parseLenientJsonObject,
} from "../json.js";

export const TELEGRAM_INVOICE_PAYLOAD_MAX_BYTES = 128;

export function buildTelegramInvoicePayload(paymentToken: string): string {
  return `stars_${createHash("sha256").update(paymentToken).digest("hex")}`;
}

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
  return normalizeStrictPositiveInteger(value);
}

export function normalizeNonNegativeInteger(value: unknown): number | null {
  return normalizeStrictNonNegativeInteger(value);
}

export function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseJsonObject(
  value: unknown,
): Record<string, unknown> | null {
  return parseLenientJsonObject(value);
}

export function parseJsonArray(value: unknown): unknown[] | null {
  return parseLenientJsonArray(value);
}

export function isExpired(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return !Number.isFinite(timestamp) || timestamp < Date.now();
  }
  if (typeof value !== "string") return true;

  const trimmed = value.trim();
  if (!trimmed) return false;
  const timestamp = Date.parse(trimmed);
  return !Number.isFinite(timestamp) || timestamp < Date.now();
}

export function buildRandomToken(prefix: "btn" | "inv"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export const INVOICE_TTL_MS = 30 * 60 * 1000;

export function extractPanelFromRawUpdate(
  rawUpdate: unknown,
): {
  panel_text: string | null;
  panel_entities_json: unknown[] | null;
  message_kind: "text" | "caption" | null;
  reply_markup: Record<string, unknown> | null;
} {
  const update = parseJsonObject(rawUpdate);
  const callback = parseJsonObject(update?.callback_query);
  const message = parseJsonObject(callback?.message);
  const messageKind =
    typeof message?.text === "string"
      ? "text"
      : typeof message?.caption === "string"
        ? "caption"
        : null;
  const text =
    typeof message?.text === "string"
      ? (message.text.length > 0 ? message.text : null)
      : typeof message?.caption === "string"
        ? (message.caption.length > 0 ? message.caption : null)
        : null;
  const entities =
    parseJsonArray(message?.entities)
    ?? parseJsonArray(message?.caption_entities)
    ?? null;

  return {
    panel_text: text,
    panel_entities_json: entities,
    message_kind: messageKind,
    reply_markup: parseJsonObject(message?.reply_markup),
  };
}
