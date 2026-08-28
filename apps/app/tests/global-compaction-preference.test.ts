import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  formatConfigWithAutoCompaction,
  readAutoCompactionFromConfig,
} from "../src/react-app/domains/settings/state/global-compaction-preference";

describe("readAutoCompactionFromConfig", () => {
  test("配置为空时默认开启", () => {
    expect(readAutoCompactionFromConfig(null)).toBe(true);
    expect(readAutoCompactionFromConfig("")).toBe(true);
    expect(readAutoCompactionFromConfig("   ")).toBe(true);
  });

  test("未声明 compaction 时默认开启", () => {
    expect(readAutoCompactionFromConfig('{"$schema":"https://opencode.ai/config.json"}')).toBe(true);
  });

  test("声明了 compaction 但没有 auto 时默认开启", () => {
    expect(readAutoCompactionFromConfig('{"compaction":{"prune":true}}')).toBe(true);
  });

  test("显式 false 时关闭", () => {
    expect(readAutoCompactionFromConfig('{"compaction":{"auto":false}}')).toBe(false);
  });

  test("显式 true 时开启", () => {
    expect(readAutoCompactionFromConfig('{"compaction":{"auto":true}}')).toBe(true);
  });
});

describe("formatConfigWithAutoCompaction", () => {
  test("空配置写入后可读回", () => {
    const next = formatConfigWithAutoCompaction("", false);
    expect(readAutoCompactionFromConfig(next)).toBe(false);
    expect(next.endsWith("\n")).toBe(true);
  });

  test("保留其余顶层键", () => {
    const raw = '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark"\n}\n';
    const next = formatConfigWithAutoCompaction(raw, false);
    const parsed = parse(next) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(readAutoCompactionFromConfig(next)).toBe(false);
  });

  test("保留 compaction 下的其他字段", () => {
    const raw = '{\n  "compaction": {\n    "prune": true,\n    "reserved": 20000\n  }\n}\n';
    const next = formatConfigWithAutoCompaction(raw, false);
    const parsed = parse(next) as { compaction?: Record<string, unknown> };
    expect(parsed.compaction?.prune).toBe(true);
    expect(parsed.compaction?.reserved).toBe(20000);
    expect(parsed.compaction?.auto).toBe(false);
  });

  test("保留 JSONC 注释", () => {
    const raw = '{\n  // 用户备注\n  "theme": "dark"\n}\n';
    const next = formatConfigWithAutoCompaction(raw, true);
    expect(next).toContain("// 用户备注");
    expect(readAutoCompactionFromConfig(next)).toBe(true);
  });

  test("重复写入同一值稳定", () => {
    const once = formatConfigWithAutoCompaction("", false);
    expect(formatConfigWithAutoCompaction(once, false)).toBe(once);
  });
});
