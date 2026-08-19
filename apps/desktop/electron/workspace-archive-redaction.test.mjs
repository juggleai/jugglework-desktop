import assert from "node:assert/strict";
import test from "node:test";

import {
  REDACTED_PLACEHOLDER,
  isCredentialBearingArg,
  needsRedaction,
  redactOpencodeConfigText,
} from "./workspace-archive-redaction.mjs";

function redact(config) {
  const result = redactOpencodeConfigText(JSON.stringify(config, null, 2));
  return { config: JSON.parse(result.text), removed: result.removed };
}

test("剥离云端 MCP 的 Bearer 令牌", () => {
  const { config, removed } = redact({
    mcp: {
      "jugglework-cloud": {
        type: "remote",
        url: "http://127.0.0.1:18020/jwork/api/mcp/agent",
        headers: { Authorization: "Bearer jwmcp_secret_value_here" },
        oauth: false,
        enabled: true,
      },
    },
  });
  assert.equal(config.mcp["jugglework-cloud"].headers.Authorization, REDACTED_PLACEHOLDER);
  assert.equal(config.mcp["jugglework-cloud"].url, "http://127.0.0.1:18020/jwork/api/mcp/agent");
  assert.equal(config.mcp["jugglework-cloud"].oauth, false);
  assert.deepEqual(removed, ["jugglework-cloud.headers.Authorization"]);
});

test("剥离环境变量的值但保留键名", () => {
  const { config, removed } = redact({
    mcp: {
      mysql: {
        type: "local",
        command: ["npx", "-y", "@benborla29/mcp-server-mysql"],
        environment: { MYSQL_HOST: "localhost", MYSQL_PASS: "Abc@2026!", MYSQL_DB: "jwork_db" },
        enabled: true,
      },
    },
  });
  const environment = config.mcp.mysql.environment;
  assert.deepEqual(Object.keys(environment), ["MYSQL_HOST", "MYSQL_PASS", "MYSQL_DB"]);
  for (const value of Object.values(environment)) assert.equal(value, REDACTED_PLACEHOLDER);
  assert.equal(removed.length, 3);
});

test("剥离命令行里内嵌的连接串密码，保留其余参数", () => {
  const { config, removed } = redact({
    mcp: {
      postgres: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://alice:s3cret@localhost:5432/mydb"],
        enabled: true,
      },
    },
  });
  assert.deepEqual(config.mcp.postgres.command.slice(0, 3), [
    "npx", "-y", "@modelcontextprotocol/server-postgres",
  ]);
  assert.equal(
    config.mcp.postgres.command[3],
    `postgresql://alice:${REDACTED_PLACEHOLDER}@localhost:5432/mydb`,
  );
  assert.deepEqual(removed, ["postgres.command"]);
});

test("剥离 OAuth client secret，保留 client id", () => {
  const { config, removed } = redact({
    mcp: {
      remote: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        oauth: { clientId: "public-client-id", clientSecret: "shhh", scope: "read" },
      },
    },
  });
  assert.equal(config.mcp.remote.oauth.clientId, "public-client-id");
  assert.equal(config.mcp.remote.oauth.scope, "read");
  assert.equal(config.mcp.remote.oauth.clientSecret, REDACTED_PLACEHOLDER);
  assert.deepEqual(removed, ["remote.oauth.clientSecret"]);
});

test("非凭据请求头保持原样", () => {
  const { config, removed } = redact({
    mcp: { remote: { type: "remote", url: "https://x/mcp", headers: { "X-Trace-Id": "abc", Accept: "application/json" } } },
  });
  assert.deepEqual(config.mcp.remote.headers, { "X-Trace-Id": "abc", Accept: "application/json" });
  assert.deepEqual(removed, []);
});

test("无凭据时原文不变", () => {
  const text = JSON.stringify({ mcp: { x: { type: "local", command: ["npx", "y"], enabled: true } } }, null, 2);
  const result = redactOpencodeConfigText(text);
  assert.equal(result.text, text);
  assert.deepEqual(result.removed, []);
});

test("mcpServers 键名同样处理", () => {
  const { config, removed } = redact({
    mcpServers: { x: { command: ["npx", "y"], env: {}, headers: { "x-api-key": "abc" } } },
  });
  assert.equal(config.mcpServers.x.headers["x-api-key"], REDACTED_PLACEHOLDER);
  assert.equal(removed.length, 1);
});

test("解析失败时原样返回，不让导出整体失败", () => {
  const text = "{ // 手写注释\n  \"mcp\": {} }";
  const result = redactOpencodeConfigText(text);
  assert.equal(result.text, text);
  assert.deepEqual(result.removed, []);
});

test("没有 mcp 段的配置不改动", () => {
  const text = JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "x" }, null, 2);
  assert.equal(redactOpencodeConfigText(text).text, text);
});

test("isCredentialBearingArg 只认 URL 内嵌凭据", () => {
  assert.equal(isCredentialBearingArg("postgresql://u:p@h/db"), true);
  assert.equal(isCredentialBearingArg("mysql://root:pw@127.0.0.1:3306/db"), true);
  assert.equal(isCredentialBearingArg("postgresql://localhost/mydb"), false);
  assert.equal(isCredentialBearingArg("https://mcp.example.com/mcp"), false);
  assert.equal(isCredentialBearingArg("--access-mode=restricted"), false);
  assert.equal(isCredentialBearingArg("/Users/me/Desktop"), false);
  assert.equal(isCredentialBearingArg(undefined), false);
});

test("needsRedaction 覆盖 opencode 配置文件", () => {
  assert.equal(needsRedaction("opencode.json"), true);
  assert.equal(needsRedaction("opencode.jsonc"), true);
  assert.equal(needsRedaction(".opencode/skills/a/SKILL.md"), false);
});
