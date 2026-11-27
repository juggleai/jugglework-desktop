import { describe, expect, test } from "bun:test";
import { isUsageLimitError, latestAssistantError } from "./goal-usage-limit.js";

describe("goal usage limit detection", () => {
  test("hard account limits are recognised, transient rate limits are not", () => {
    expect(isUsageLimitError({ name: "APIError", data: { statusCode: 402, message: "Payment required" } })).toBe(true);
    expect(isUsageLimitError({ name: "APIError", data: { message: "You exceeded your current quota", statusCode: 429 } })).toBe(true);
    expect(isUsageLimitError({ name: "APIError", data: { code: "insufficient_points" } })).toBe(true);
    expect(isUsageLimitError({ name: "APIError", data: { message: "余额不足，请充值" } })).toBe(true);
    expect(isUsageLimitError({ name: "APIError", data: { message: "Too many requests", statusCode: 429 } })).toBe(false);
    expect(isUsageLimitError({ name: "ProviderAuthError", data: { message: "bad key" } })).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
    expect(isUsageLimitError("quota exceeded")).toBe(false);
  });

  test("reads the error of the newest assistant message only", () => {
    const messages = [
      { info: { role: "assistant", time: { created: 1 }, error: { name: "APIError", data: { statusCode: 402 } } } },
      { info: { role: "user", time: { created: 2 } } },
      { info: { role: "assistant", time: { created: 3 } } },
    ];
    expect(latestAssistantError(messages)).toBeNull();
    expect(isUsageLimitError(latestAssistantError([messages[0]]))).toBe(true);
    expect(latestAssistantError("nope")).toBeNull();
  });
});
