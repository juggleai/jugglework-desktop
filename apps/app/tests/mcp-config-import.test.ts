import { describe, expect, test } from "bun:test";

import {
  isPlaceholderValue,
  parseMcpServersJson,
} from "../src/react-app/domains/connections/mcp-config-import";

function unwrap(result: ReturnType<typeof parseMcpServersJson>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.config;
}

describe("parseMcpServersJson", () => {
  test("标准 mcpServers 片段", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: {
        postgres: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-postgres"],
          env: { DATABASE_URI: "postgresql://localhost/db" },
        },
      },
    })));

    expect(config.name).toBe("postgres");
    expect(config.type).toBe("local");
    expect(config.command).toBe("npx -y @modelcontextprotocol/server-postgres");
    expect(config.environment).toEqual([{ key: "DATABASE_URI", value: "postgresql://localhost/db" }]);
    expect(config.ignoredCount).toBe(0);
  });

  test("省略 mcpServers 外层包裹", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      firecrawl: { command: "npx", args: ["-y", "firecrawl-mcp"] },
    })));
    expect(config.name).toBe("firecrawl");
    expect(config.command).toBe("npx -y firecrawl-mcp");
  });

  test("远程条目切换类型并回填请求头", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer real-token" },
        },
      },
    })));
    expect(config.type).toBe("remote");
    expect(config.url).toBe("https://mcp.example.com/mcp");
    expect(config.headers).toEqual([{ key: "Authorization", value: "Bearer real-token" }]);
  });

  test("serverUrl 也识别为远程", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: { remote: { type: "sse", serverUrl: "http://localhost:8000/sse" } },
    })));
    expect(config.type).toBe("remote");
    expect(config.url).toBe("http://localhost:8000/sse");
  });

  test("占位符值被清空并标记待填", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: {
        x: { command: "npx", args: ["-y", "x"], env: { API_KEY: "<YOUR_API_KEY>", REAL: "abc123" } },
      },
    })));
    expect(config.environment).toEqual([
      { key: "API_KEY", value: "" },
      { key: "REAL", value: "abc123" },
    ]);
    expect(config.placeholderKeys).toEqual(["API_KEY"]);
  });

  test("多条目只取首条并记录忽略数", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: {
        first: { command: "a" },
        second: { command: "b" },
        third: { command: "c" },
      },
    })));
    expect(config.name).toBe("first");
    expect(config.ignoredCount).toBe(2);
  });

  test("command 为数组时与 args 合并", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: { x: { command: ["uvx", "postgres-mcp"], args: ["--access-mode=restricted"] } },
    })));
    expect(config.command).toBe("uvx postgres-mcp --access-mode=restricted");
  });

  test("带空格的参数被还原为引号形式", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: { x: { command: "npx", args: ["--dsn", "postgres://a b"] } },
    })));
    expect(config.command).toBe('npx --dsn "postgres://a b"');
  });

  test("timeout 被回填为字符串", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: { x: { command: "foo", timeout: 60000 } },
    })));
    expect(config.timeout).toBe("60000");
  });

  test("非法 timeout 不回填", () => {
    for (const timeout of [0, -1, "60000", null]) {
      const config = unwrap(parseMcpServersJson(JSON.stringify({
        mcpServers: { x: { command: "foo", timeout } },
      })));
      expect(config.timeout).toBe("");
    }
  });

  test("cwd 被回填", () => {
    const config = unwrap(parseMcpServersJson(JSON.stringify({
      mcpServers: { x: { command: "foo", cwd: "/tmp/work" } },
    })));
    expect(config.cwd).toBe("/tmp/work");
  });

  test("非法 JSON 返回 invalid_json", () => {
    const result = parseMcpServersJson("{ not json ");
    expect(result).toEqual({ ok: false, error: "invalid_json" });
  });

  test("空文本返回 invalid_json", () => {
    expect(parseMcpServersJson("   ")).toEqual({ ok: false, error: "invalid_json" });
  });

  test("数组顶层返回 unsupported_shape", () => {
    expect(parseMcpServersJson("[]")).toEqual({ ok: false, error: "unsupported_shape" });
  });

  test("无 server 条目返回 no_server", () => {
    expect(parseMcpServersJson(JSON.stringify({ mcpServers: {} }))).toEqual({
      ok: false,
      error: "no_server",
    });
  });
});

describe("isPlaceholderValue", () => {
  test.each([
    "<YOUR_API_KEY>",
    "{{token}}",
    "${API_KEY}",
    "$API_KEY",
    "xxx",
    "****",
    "your-api-key",
    "YOUR_TOKEN_HERE".replace("_HERE", "").toLowerCase(),
    "",
    "   ",
  ])("%s 判为占位符", (value) => {
    expect(isPlaceholderValue(value)).toBe(true);
  });

  test.each([
    "postgresql://localhost/db",
    "fc-1234567890",
    "Bearer real-token",
    "sk-abcdef",
  ])("%s 判为真实值", (value) => {
    expect(isPlaceholderValue(value)).toBe(false);
  });
});
