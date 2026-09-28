const PATTERN_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]"],
  [/([?&](?:token|key|signature|sig|credential)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/\b(?:sk|jwmcp|jwgw)_[A-Za-z0-9_-]+\b/g, "[REDACTED]"],
];

export function redactProviderMessage(value: unknown, credentials: readonly (string | null | undefined)[] = []): string {
  let message = value instanceof Error ? value.message : typeof value === "string" ? value : "Provider request failed.";
  for (const credential of credentials) {
    const secret = credential?.trim();
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of PATTERN_REDACTIONS) message = message.replace(pattern, replacement);
  return message.slice(0, 500);
}

export class VideoSubmissionError extends Error {
  constructor(
    readonly outcome: "rejected" | "unknown",
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
