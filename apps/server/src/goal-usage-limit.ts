/**
 * Detects an account-level usage limit (quota, plan, balance, points) in the
 * error an engine run ended with. Mirrors the hard-limit signatures the
 * renderer classifies in `provider-limit-classify.ts`; transient rate limits
 * (429 "too many requests") are deliberately not matched because they retry.
 */
const CODE_TOKENS = [
  "insufficient_quota",
  "usage_limit_reached",
  "usage_limit_exceeded",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "payment_required",
  "insufficient_points",
];

const TEXT_PHRASES = [
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
  "does not have enough available points",
  "account balance",
  "arrears",
  "欠费",
  "余额不足",
  "配额不足",
  "额度不足",
  "额度已用完",
  "用量已达上限",
  "积分不足",
  "积分耗尽",
];

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isUsageLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const data = (record.data && typeof record.data === "object" ? record.data : {}) as Record<string, unknown>;
  if (data.statusCode === 402 || data.status === 402) return true;
  const identity = [record.name, record.code, data.code, data.errorCode].map(lower).join("\n");
  if (CODE_TOKENS.some((token) => identity.includes(token))) return true;
  const text = [record.message, data.message, data.responseBody, data.body].map(lower).join("\n");
  return TEXT_PHRASES.some((phrase) => text.includes(phrase));
}

/** The error of the newest assistant message, if that message failed. */
export function latestAssistantError(messages: unknown): unknown {
  if (!Array.isArray(messages)) return null;
  const assistants = messages
    .filter((message) => message?.info?.role === "assistant")
    .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
  return assistants.at(-1)?.info?.error ?? null;
}
