export type ProviderErrorKind = "ip_not_authorized";

export type ProviderErrorSignals = {
  status: number | null;
  type: string | null;
  code: string | null;
  provider: string | null;
  message: string | null;
  responseBody: string | null;
  retries: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readString(value: unknown, max = 4_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

function collectRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const append = (value: unknown) => {
    const candidate = record(value);
    if (candidate && !records.includes(candidate)) records.push(candidate);
  };

  const root = record(error);
  // Provider payloads are more specific than transport wrappers such as
  // `APIError`; inspect nested `error` objects first.
  append(root?.error);
  const data = record(root?.data);
  append(data?.error);
  const cause = record(root?.cause);
  append(cause?.error);
  const causeData = record(cause?.data);
  append(causeData?.error);
  append(root);
  append(data);
  append(cause);
  append(causeData);

  return records;
}

function firstString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const candidate of records) {
    for (const key of keys) {
      const value = readString(candidate[key]);
      if (value) return value;
    }
  }
  return null;
}

function firstNumber(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const candidate of records) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function parseResponseError(responseBody: string | null): Record<string, unknown> | null {
  if (!responseBody) return null;
  try {
    const parsed = record(JSON.parse(responseBody));
    return record(parsed?.error) ?? parsed;
  } catch {
    return null;
  }
}

/** Normalize the nested error shapes emitted by OpenCode and provider SDKs. */
export function extractProviderErrorSignals(error: unknown): ProviderErrorSignals {
  const records = collectRecords(error);
  const responseBody = firstString(records, ["responseBody", "body", "response"]);
  const responseError = parseResponseError(responseBody);
  const allRecords = responseError ? [...records, responseError] : records;
  const structuredErrorRecords = responseError ? [responseError, ...records] : records;

  return {
    status: firstNumber(allRecords, ["statusCode", "status"]),
    type: firstString(structuredErrorRecords, ["type", "name"]),
    code: firstString(structuredErrorRecords, ["code", "errorCode"]),
    provider: firstString(allRecords, ["providerID", "providerId", "provider"]),
    message:
      (error instanceof Error ? readString(error.message) : null) ??
      (typeof error === "string" ? readString(error) : null) ??
      firstString(structuredErrorRecords, ["message", "detail", "reason", "error"]),
    responseBody,
    retries: firstNumber(allRecords, ["retries", "retryCount"]),
  };
}

function normalize(value: string | null): string {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Detect only the observed IP-allowlist response. A generic 401 or
 * `invalid_api_key` remains a terminal authentication failure.
 */
export function classifyProviderError(error: unknown): ProviderErrorKind | null {
  const signals = extractProviderErrorSignals(error);
  const text = normalize([signals.message, signals.responseBody].filter(Boolean).join("\n"));
  const hasExpectedShape =
    signals.status === 401 &&
    normalize(signals.type) === "authentication_error" &&
    normalize(signals.code) === "invalid_api_key";

  return hasExpectedShape && text.includes("your ip is not authorized to make this request")
    ? "ip_not_authorized"
    : null;
}
