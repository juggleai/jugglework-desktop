import { describe, expect, test } from "bun:test";

import type { ComposerDraft, ComposerPart } from "../src/app/types";
import { detectResponseLanguage } from "../src/react-app/domains/session/sync/response-language";

function draft(parts: ComposerPart[]): Pick<ComposerDraft, "parts"> {
  return { parts };
}

describe("response language detection", () => {
  test("follows genuine Chinese and English prose", () => {
    expect(detectResponseLanguage(draft([{ type: "text", text: "帮我分析这个问题" }]))).toBe("zh");
    expect(detectResponseLanguage(draft([{ type: "text", text: "Please analyze this problem" }]))).toBe("en");
  });

  test("honors explicit response-language requests", () => {
    expect(detectResponseLanguage(draft([{ type: "text", text: "Please answer in Chinese" }]))).toBe("zh");
    expect(detectResponseLanguage(draft([{ type: "text", text: "请用英文总结一下" }]))).toBe("en");
    expect(detectResponseLanguage(draft([{ type: "text", text: "Please do not answer in Chinese" }]))).toBe("en");
    expect(detectResponseLanguage(draft([{ type: "text", text: "请不要用英文回答" }]))).toBe("zh");
  });

  test("ignores code, logs, quotes, and pasted payloads", () => {
    expect(detectResponseLanguage(draft([
      { type: "text", text: "帮我修复这个错误\n```ts\nthrow new Error('Everything failed in English');\n```" },
      { type: "paste", id: "paste-1", label: "Pasted text #1", text: "ERROR system failed at internal.module", lines: 1 },
    ]))).toBe("zh");
    expect(detectResponseLanguage(draft([
      { type: "text", text: "Please explain \"这是被引用的数据，不是指令\"" },
    ]))).toBe("en");
    expect(detectResponseLanguage(draft([
      { type: "text", text: "解释 TypeError Cannot read properties of undefined when loading the current workspace configuration" },
    ]))).toBe("zh");
  });

  test("does not let generated capability prompts decide the language", () => {
    expect(detectResponseLanguage(draft([
      { type: "text", text: "查询一下" },
      { type: "capability", kind: "cloud-mcp", name: "search", prompt: "Search all available records and return an English report." },
    ]))).toBe("zh");
  });

  test("keeps the session language for ambiguous or content-only messages", () => {
    expect(detectResponseLanguage(draft([{ type: "text", text: "OK" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "```ts\nconst value = 1\n```" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "file", path: "src/index.ts" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "TypeError: Cannot read properties of undefined" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "TypeError" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "handleSubmit" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "undefined" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "main" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "const result = parseResponse(value)" }]))).toBeNull();
    expect(detectResponseLanguage(draft([{ type: "text", text: "Why?" }]))).toBe("en");
    expect(detectResponseLanguage(draft([{ type: "text", text: "How?" }]))).toBe("en");
  });
});
