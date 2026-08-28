import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  formatConfigWithMcpEnabled,
  formatConfigWithMcpEntry,
  formatConfigWithoutMcpEntry,
  parseGlobalMcpEntries,
} from "../src/react-app/domains/settings/state/global-mcp-config";

const SAMPLE = `{
  // 用户备注
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "mcp": {
    "context7": { "type": "remote", "url": "https://example.com/mcp" },
    "local-tool": { "type": "local", "command": ["npx", "-y", "tool"] }
  }
}
`;

describe("parseGlobalMcpEntries", () => {
  test("解析 mcp 段", () => {
    const entries = parseGlobalMcpEntries(SAMPLE);
    expect(entries.map((entry) => entry.name)).toEqual(["context7", "local-tool"]);
    expect(entries[0]?.config.type).toBe("remote");
    expect(entries[1]?.config.command).toEqual(["npx", "-y", "tool"]);
  });

  test("内容为空或没有 mcp 段时返回空列表", () => {
    expect(parseGlobalMcpEntries(null)).toEqual([]);
    expect(parseGlobalMcpEntries("")).toEqual([]);
    expect(parseGlobalMcpEntries('{"theme":"dark"}')).toEqual([]);
  });
});

describe("formatConfigWithMcpEntry", () => {
  test("新增条目并保留其余配置与注释", () => {
    const next = formatConfigWithMcpEntry(SAMPLE, "added", { type: "remote", url: "https://a.test" });
    expect(next).toContain("// 用户备注");
    const parsed = parse(next) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    expect(parseGlobalMcpEntries(next).map((entry) => entry.name)).toEqual([
      "context7",
      "local-tool",
      "added",
    ]);
  });

  test("同名条目被覆盖而非追加", () => {
    const next = formatConfigWithMcpEntry(SAMPLE, "context7", { type: "remote", url: "https://b.test" });
    const entries = parseGlobalMcpEntries(next);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.name === "context7")?.config.url).toBe("https://b.test");
  });

  test("空配置也能写入", () => {
    const next = formatConfigWithMcpEntry("", "solo", { type: "remote", url: "https://c.test" });
    expect(parseGlobalMcpEntries(next).map((entry) => entry.name)).toEqual(["solo"]);
  });
});

describe("formatConfigWithoutMcpEntry", () => {
  test("只移除目标条目", () => {
    const next = formatConfigWithoutMcpEntry(SAMPLE, "context7");
    expect(parseGlobalMcpEntries(next).map((entry) => entry.name)).toEqual(["local-tool"]);
    expect(next).toContain("// 用户备注");
    expect((parse(next) as Record<string, unknown>).theme).toBe("dark");
  });

  test("目标不存在时内容不变", () => {
    expect(formatConfigWithoutMcpEntry(SAMPLE, "missing")).toBe(SAMPLE);
  });
});

describe("formatConfigWithMcpEnabled", () => {
  test("写入 enabled 字段", () => {
    const next = formatConfigWithMcpEnabled(SAMPLE, "context7", false);
    const entry = parseGlobalMcpEntries(next).find((item) => item.name === "context7");
    expect(entry?.config.enabled).toBe(false);
    expect(entry?.config.url).toBe("https://example.com/mcp");
  });

  test("不影响其他条目", () => {
    const next = formatConfigWithMcpEnabled(SAMPLE, "context7", false);
    const other = parseGlobalMcpEntries(next).find((item) => item.name === "local-tool");
    expect(other?.config.enabled).toBeUndefined();
  });

  test("目标不存在时内容不变", () => {
    expect(formatConfigWithMcpEnabled(SAMPLE, "missing", false)).toBe(SAMPLE);
  });
});
