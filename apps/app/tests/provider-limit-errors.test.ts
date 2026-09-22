import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setLocale } from "../src/i18n";
import {
  classifyProviderLimit,
} from "../src/react-app/domains/session/sync/provider-limit-classify";
import {
  classifyProviderError,
  extractProviderErrorSignals,
} from "../src/react-app/domains/session/sync/provider-error-classify";
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

describe("IP authorization provider errors", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  const ipAuthorizationError = {
    name: "APIError",
    data: {
      statusCode: 401,
      providerID: "lpr_managed",
      responseBody: JSON.stringify({
        error: {
          message: "Your IP is not authorized to make this request.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      }),
    },
  };

  test("classifies the exact nested provider response", () => {
    expect(classifyProviderError(ipAuthorizationError)).toBe("ip_not_authorized");
    expect(extractProviderErrorSignals(ipAuthorizationError)).toMatchObject({
      status: 401,
      type: "authentication_error",
      code: "invalid_api_key",
      provider: "lpr_managed",
    });
  });

  test("classifies a direct HTTP payload with a nested error object", () => {
    expect(classifyProviderError({
      name: "APIError",
      status: 401,
      error: {
        message: "Your IP is not authorized to make this request.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    })).toBe("ip_not_authorized");
  });

  test("does not classify an ordinary invalid API key", () => {
    expect(classifyProviderError({
      statusCode: 401,
      type: "authentication_error",
      code: "invalid_api_key",
      message: "Incorrect API key provided",
    })).toBe(null);
  });

  test("requires the structured authentication signature", () => {
    expect(classifyProviderError({
      statusCode: 401,
      code: "another_code",
      message: "Your IP is not authorized to make this request",
    })).toBe(null);
  });

  test("renders actionable guidance while preserving diagnostics", () => {
    const text = describeOpencodeSessionError(ipAuthorizationError);
    expect(text).toContain("network address");
    expect(text).toContain("temporary provider routing or IP allowlist delay");
    expect(text).toContain("usually do not need to replace your API key");
    expect(text).toContain("Status: 401");
    expect(text).toContain("Provider: lpr_managed");
    expect(text).toContain("Code: invalid_api_key");
  });

  test("renders localized guidance", () => {
    setLocale("zh");
    const text = describeOpencodeSessionError(ipAuthorizationError);
    expect(text).toContain("尚未授权当前工作节点的网络地址");
    expect(text).toContain("通常无需更换你的 API Key");
  });
});

describe("gateway transport provider errors", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  test("classifies and explains an expired JuggleWork gateway credential", () => {
    const error = {
      statusCode: 401,
      responseBody: JSON.stringify({
        error: {
          code: "unauthorized",
          message: "The gateway credential is missing, revoked, or expired.",
          type: "unauthorized",
        },
      }),
    };
    expect(classifyProviderError(error)).toBe("gateway_credential_invalid");
    const text = describeOpencodeSessionError(error);
    expect(text).toContain("JuggleWork gateway sign-in expired");
    expect(text).toContain("sign in to JuggleWork again");
    expect(text).toContain("Status: 401");
  });

  test("turns an nginx 413 HTML response into actionable size guidance", () => {
    const html = "<html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>";
    const error = { statusCode: 413, responseBody: html, message: "Request failed" };
    expect(classifyProviderError(error)).toBe("request_too_large");
    const text = describeOpencodeSessionError(error);
    expect(text).toContain("Request is too large for the gateway");
    expect(text).toContain("Remove or split large attachments");
    expect(text).toContain("/compact");
    expect(text).not.toContain("<html>");
  });

  test("preserves a TLS cause code and recommends a bounded retry", () => {
    const error = {
      message: "fetch failed",
      cause: {
        code: "CERT_HAS_EXPIRED",
        message: "unknown certificate verification error",
      },
    };
    expect(classifyProviderError(error)).toBe("tls_verification_failed");
    const text = describeOpencodeSessionError(error);
    expect(text).toContain("Secure connection verification failed");
    expect(text).toContain("Retry once");
    expect(text).toContain("Code: CERT_HAS_EXPIRED");
  });

  test("does not reclassify a generic unauthorized provider response as a gateway credential", () => {
    expect(classifyProviderError({ statusCode: 401, message: "Unauthorized" })).toBe(null);
  });
});
