const INTEGER_TEXT_PATTERN = /^-?\d+$/u;

export function parseIntegerInput(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!INTEGER_TEXT_PATTERN.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const normalized = parseIntegerInput(value);
  return normalized != null && normalized > 0 ? normalized : null;
}

export function normalizeNonNegativeInteger(value: unknown): number | null {
  const normalized = parseIntegerInput(value);
  return normalized != null && normalized >= 0 ? normalized : null;
}
