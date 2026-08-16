import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setLocale } from "../src/i18n";
import {
  classifyProviderLimit,
} from "../src/react-app/domains/session/sync/provider-limit-classify";
import {
  describeOpencodeSessionError,
} from "../src/react-app/domains/session/sync/usechat-adapter";

describe("classifyProviderLimit", () => {
  test("OpenAI insufficient_quota code is a hard usage limit", () => {
    expect(classifyProviderLimit({ status: 429, code: "insufficient_quota" })).toBe("usage_limit");
  });

  test("Anthropic usage_limit_reached is terminal despite 429", () => {
    expect(classifyProviderLimit({ status: 429, code: "usage_limit_reached" })).toBe("usage_limit");
  });

  test("quota/plan text is a usage limit", () => {
    expect(
      classifyProviderLimit({
        status: 403,
        text: "You exceeded your current quota, please check your plan and billing details",
      }),
    ).toBe("usage_limit");
  });

  test("payment required status is a usage limit", () => {
    expect(classifyProviderLimit({ status: 402, text: "Payment required" })).toBe("usage_limit");
  });

  test("localized balance text is a usage limit", () => {
    expect(classifyProviderLimit({ text: "请求失败：余额不足，请充值后重试" })).toBe("usage_limit");
  });

  test("plain throttles stay retryable rate limits", () => {
    expect(
      classifyProviderLimit({ status: 429, text: "Rate limit reached for requests. Please try again in 20s" }),
    ).toBe(null);
    expect(classifyProviderLimit({ status: 429, text: "Too many requests" })).toBe(null);
  });

  test("context_length_exceeded code is a context overflow", () => {
    expect(classifyProviderLimit({ code: "context_length_exceeded" })).toBe("context_overflow");
  });

  test("engine ContextOverflowError name is a context overflow", () => {
    expect(classifyProviderLimit({ name: "ContextOverflowError" })).toBe("context_overflow");
  });

  test("provider context-length text is a context overflow", () => {
    expect(
      classifyProviderLimit({
        text: "This model's maximum context length is 8192 tokens, however you requested 10000 tokens",
      }),
    ).toBe("context_overflow");
  });
});

describe("describeOpencodeSessionError limit formatting", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  test("usage limit object error gets heading, hint, and raw diagnostics", () => {
    const text = describeOpencodeSessionError({
      name: "AI_APICallError",
      statusCode: 429,
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    });
    expect(text).toContain("Model usage limit reached");
    expect(text).toContain("switch to another model");
    expect(text).toContain("You exceeded your current quota");
    expect(text).toContain("Status: 429");
  });

  test("zh locale renders the localized usage limit heading", () => {
    setLocale("zh");
    const text = describeOpencodeSessionError({ code: "insufficient_quota", message: "quota exceeded" });
    expect(text).toContain("模型调用已达上限");
  });

  test("string context overflow error gets heading and recovery hint", () => {
    const text = describeOpencodeSessionError("context_length_exceeded: prompt is too long");
    expect(text).toContain("Context window exceeded");
    expect(text).toContain("/compact");
  });

  test("object context overflow keeps status diagnostics", () => {
    const text = describeOpencodeSessionError({
      name: "ContextOverflowError",
      statusCode: 400,
      message: "The conversation is too long for the model",
    });
    expect(text).toContain("Context window exceeded");
    expect(text).toContain("Status: 400");
  });

  test("plain throttle messages pass through unchanged", () => {
    const text = describeOpencodeSessionError("Rate limit reached for requests");
    expect(text).toBe("Rate limit reached for requests");
  });
});
