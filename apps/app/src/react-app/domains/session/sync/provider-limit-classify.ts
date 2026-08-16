/**
 * Classifies terminal provider limit failures that end a task run.
 *
 * Two kinds matter for the session UI:
 * - `usage_limit`: the account hit a hard model-call limit (quota, plan,
 *   spending, or billing). Retrying cannot recover until the plan/quota
 *   changes, so the run must terminate with a clear, localized error.
 * - `context_overflow`: the conversation exceeds the model context window.
 *   The engine's automatic compaction is the first recovery path; when this
 *   classification still surfaces as a session error, compaction did not
 *   recover (or is disabled) and the run terminates with actionable advice.
 *
 * Transient rate limiting (HTTP 429 "too many requests" style) is deliberately
 * NOT classified here — the engine retries those with backoff and the UI keeps
 * its retry countdown. A 429 carrying a hard-limit signature (for example
 * Anthropic `usage_limit_reached`) is a usage limit, not a retryable throttle.
 */

export type ProviderLimitKind = "usage_limit" | "context_overflow";

export interface ProviderLimitSignals {
  /** HTTP status code from the provider response, when known. */
  status?: number | null;
  /** Provider error `code` / `errorCode` field, when known. */
  code?: string | null;
  /** Engine error class name (for example `ContextOverflowError`). */
  name?: string | null;
  /** Combined human-readable provider text (message + response body). */
  text?: string | null;
}

/** Hard account-limit tokens matched against code/name text. */
const USAGE_LIMIT_CODE_TOKENS = [
  "insufficient_quota",
  "usage_limit_reached",
  "usage_limit_exceeded",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "payment_required",
];

const USAGE_LIMIT_TEXT_PHRASES = [
  "usage limit",
  "exceeded your current quota",
  "quota exceeded",
  "exceeded your quota",
  "quota has been exhausted",
  "plan limit",
  "spending limit",
  "hard limit",
  "insufficient credit",
  "insufficient balance",
  "out of credits",
  "out of credit",
  "account balance",
  "arrears",
  // Relay gateways commonly localize hard-limit failures.
  "欠费",
  "余额不足",
  "配额不足",
  "额度不足",
  "额度已用完",
  "用量已达上限",
];

const CONTEXT_OVERFLOW_CODE_TOKENS = [
  "context_length_exceeded",
  "context_window_exceeded",
];

const CONTEXT_OVERFLOW_TEXT_PHRASES = [
  "context_length_exceeded",
  "exceeds the context window",
  "exceeds the context limit",
  "maximum context length",
  "input is too long for requested model",
  "prompt is too long",
  "too many tokens",
  "token limit exceeded",
  "context window is full",
  "上下文长度",
  "超出上下文",
  "上下文超限",
];

const RATE_LIMIT_TEXT_PHRASES = [
  "rate limit",
  "ratelimit",
  "too many requests",
  "throttl",
];

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.toLowerCase().trim() : "";
}

/**
 * Detect a terminal provider limit failure. Returns `null` for everything
 * that should keep the existing generic/rate-limit handling.
 */
export function classifyProviderLimit(signals: ProviderLimitSignals): ProviderLimitKind | null {
  const code = normalize(signals.code);
  const name = normalize(signals.name);
  const codeAndName = `${code}\n${name}`;
  const text = normalize(signals.text);

  const isUsageLimit =
    signals.status === 402 ||
    (codeAndName.trim().length > 0 && includesAny(codeAndName, USAGE_LIMIT_CODE_TOKENS)) ||
    (text.length > 0 && includesAny(text, USAGE_LIMIT_TEXT_PHRASES));
  if (isUsageLimit) return "usage_limit";

  const isContextOverflow =
    (codeAndName.trim().length > 0 && includesAny(codeAndName, [...CONTEXT_OVERFLOW_CODE_TOKENS, "contextoverflowerror"])) ||
    (text.length > 0 && includesAny(text, CONTEXT_OVERFLOW_TEXT_PHRASES));
  if (isContextOverflow) return "context_overflow";

  // Guard: throttle wording without any hard-limit signature stays a
  // retryable rate limit and must not be classified as terminal.
  if (text.length > 0 && includesAny(text, RATE_LIMIT_TEXT_PHRASES)) return null;

  return null;
}
