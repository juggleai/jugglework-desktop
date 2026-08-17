import { describe, expect, test } from "bun:test";

import {
  extractEnvKeysFromReadme,
  packageNameFromCommand,
  rankEnvHints,
} from "../src/react-app/domains/connections/mcp-env-hints";

// 取自真实 README 的片段形状（notion / slack / firecrawl）。
const NOTION_README = `
## Installation
\`\`\`json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "ntn_****" }
    }
  }
}
\`\`\`
`;

const SLACK_README = `
\`\`\`json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token",
        "SLACK_TEAM_ID": "T01234567",
        "SLACK_CHANNEL_IDS": "C01234567, C76543210"
      }
    }
  }
}
\`\`\`
`;

describe("extractEnvKeysFromReadme", () => {
  test("从 JSON 代码块提取单个键", () => {
    expect(extractEnvKeysFromReadme(NOTION_README)).toEqual(["NOTION_TOKEN"]);
  });

  test("提取多个键并保持出现顺序", () => {
    expect(extractEnvKeysFromReadme(SLACK_README)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_TEAM_ID",
      "SLACK_CHANNEL_IDS",
    ]);
  });

  test("无 env 块时返回空", () => {
    const readme = "```json\n{\"mcpServers\":{\"pg\":{\"command\":\"npx\"}}}\n```";
    expect(extractEnvKeysFromReadme(readme)).toEqual([]);
  });

  test("跨多个代码块去重", () => {
    const readme = `${NOTION_README}\n${NOTION_README}`;
    expect(extractEnvKeysFromReadme(readme)).toEqual(["NOTION_TOKEN"]);
  });

  test("过滤通用噪音变量", () => {
    const readme = '```json\n{"env":{"NODE_ENV":"production","FIRECRAWL_API_KEY":"fc-x"}}\n```';
    expect(extractEnvKeysFromReadme(readme)).toEqual(["FIRECRAWL_API_KEY"]);
  });

  test("忽略非大写下划线形式的键", () => {
    const readme = '```json\n{"env":{"apiKey":"x","REAL_KEY":"y"}}\n```';
    expect(extractEnvKeysFromReadme(readme)).toEqual(["REAL_KEY"]);
  });

  test("空 README 返回空", () => {
    expect(extractEnvKeysFromReadme("")).toEqual([]);
  });
});

describe("rankEnvHints", () => {
  test("README 键置顶并标注来源", () => {
    expect(rankEnvHints(["FIRECRAWL_API_KEY"], "firecrawl-mcp")).toEqual([
      { key: "FIRECRAWL_API_KEY", source: "readme-json" },
    ]);
  });

  test("前缀匹配包名的额外键作为次级来源", () => {
    const hints = rankEnvHints(["FIRECRAWL_API_KEY"], "firecrawl-mcp", [
      "FIRECRAWL_API_URL",
      "FASTMCP_PORT",
      "KEYLESS_PROXY_SECRET",
    ]);
    expect(hints).toEqual([
      { key: "FIRECRAWL_API_KEY", source: "readme-json" },
      { key: "FIRECRAWL_API_URL", source: "name-prefix" },
    ]);
  });

  test("scope 名也参与前缀匹配", () => {
    const hints = rankEnvHints([], "@browserbasehq/mcp-server-browserbase", [
      "BROWSERBASE_API_KEY",
      "GEMINI_API_KEY",
    ]);
    expect(hints).toEqual([{ key: "BROWSERBASE_API_KEY", source: "name-prefix" }]);
  });

  test("额外键与 README 键重复时不重复产出", () => {
    const hints = rankEnvHints(["NOTION_TOKEN"], "@notionhq/notion-mcp-server", ["NOTION_TOKEN"]);
    expect(hints).toEqual([{ key: "NOTION_TOKEN", source: "readme-json" }]);
  });
});

describe("packageNameFromCommand", () => {
  test.each([
    [["npx", "-y", "firecrawl-mcp"], "firecrawl-mcp"],
    [["npx", "-y", "@modelcontextprotocol/server-postgres"], "@modelcontextprotocol/server-postgres"],
    [["npx", "-y", "@mcp_hub_org/cli@latest", "run", "@benborla29/mcp-server-mysql"], "@benborla29/mcp-server-mysql"],
    [["npx", "-y", "@smithery/cli", "exec", "some-mcp"], "some-mcp"],
    [["npx", "-y", "@mcp_hub_org/cli@latest", "run"], "@mcp_hub_org/cli"],
    [["npx", "-y", "@mcp_hub_org/cli@latest", "run", "--key", "abc"], "@mcp_hub_org/cli"],
    [["bunx", "some-mcp@1.2.3"], "some-mcp"],
    [["uvx", "postgres-mcp", "--access-mode=restricted"], "postgres-mcp"],
    [["pnpm", "dlx", "foo-mcp"], "foo-mcp"],
  ])("%o → %s", (argv, expected) => {
    expect(packageNameFromCommand(argv as string[])).toBe(expected);
  });

  test("空命令返回空字符串", () => {
    expect(packageNameFromCommand([])).toBe("");
  });

  test("全是选项时返回空字符串", () => {
    expect(packageNameFromCommand(["npx", "-y"])).toBe("");
  });

  test("绝对路径命令不误判为包名", () => {
    expect(packageNameFromCommand(["/usr/local/bin/my-server", "--flag"])).toBe("");
  });

  test("转发动词后没有合法包名时回退到启动器本身", () => {
    expect(packageNameFromCommand(["npx", "-y", "@some/cli", "run", "/abs/path"])).toBe("@some/cli");
  });

  test("非转发动词的尾随参数不被误认为目标包", () => {
    expect(packageNameFromCommand(["uvx", "postgres-mcp", "restricted"])).toBe("postgres-mcp");
  });
});
