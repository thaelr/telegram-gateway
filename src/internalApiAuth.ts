type HeaderValue = string | string[] | undefined;

function normalizeHeaderValue(value: HeaderValue): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0].trim() || null : null;
  }

  return typeof value === "string" ? value.trim() || null : null;
}

export function isInternalApiAuthorized(
  headers: Record<string, HeaderValue>,
  headerName: string,
  expectedApiKey: string,
): boolean {
  const normalizedHeaderName = headerName.trim().toLowerCase();
  const provided = normalizeHeaderValue(headers[normalizedHeaderName]);
  return provided != null && provided === expectedApiKey;
}
