import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  createGlobalMcp,
  formatConfigWithMcpEnabled,
  formatConfigWithMcpEntry,
  formatConfigWithoutMcpEntry,
  globalMcpConfigFromDirectory,
  mergeGlobalMcpEntries,
  parseGlobalMcpEntries,
  readGlobalMcpEntries,
  removeGlobalMcp,
  setGlobalMcpEnabled,
  upsertGlobalMcp,
} from "../src/react-app/domains/settings/state/global-mcp-config";
import type { GlobalConfigTarget } from "../src/react-app/domains/settings/state/global-opencode-config";
import { getMcpServerName, type McpDirectoryInfo } from "../src/app/constants";
import { matchPublicConnector, resolveConnectorCatalogSource } from "../src/react-app/domains/settings/pages/connector-catalog-source";

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

describe("mergeGlobalMcpEntries", () => {
  test("补入引擎已识别但文件读取暂未返回的全局 MCP", () => {
    const merged = mergeGlobalMcpEntries([], [
      { name: "global-db", source: "config.global", config: { type: "remote", url: "https://global.test/mcp" } },
      { name: "workspace-db", source: "config.remote", config: { type: "remote", url: "https://workspace.test/mcp" } },
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(["global-db"]);
  });

  test("同名时保留可写配置文件中的值", () => {
    const merged = mergeGlobalMcpEntries(
      [{ name: "context7", config: { type: "remote", url: "https://configured.test/mcp" } }],
      [{ name: "context7", source: "config.global", config: { type: "remote", url: "https://runtime.test/mcp" } }],
    );
    expect(merged[0]?.config.url).toBe("https://configured.test/mcp");
  });
});

describe("globalMcpConfigFromDirectory", () => {
  test("保留远程 OAuth 配置", () => {
    expect(globalMcpConfigFromDirectory({
      name: "Notion",
      serverName: "notion",
      description: "Notion",
      type: "remote",
      url: "https://mcp.notion.com/mcp",
      oauth: true,
    })).toEqual({
      name: "notion",
      config: { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true, oauth: {} },
    });
  });

  test("保留本地 MCP 完整命令而不是按空格重切", () => {
    expect(globalMcpConfigFromDirectory({
      name: "Local",
      serverName: "local",
      description: "Local",
      type: "local",
      command: ["node", "server.js", "--name", "My MCP"],
      environment: { MODE: "test" },
      oauth: false,
    }).config).toEqual({
      type: "local",
      command: ["node", "server.js", "--name", "My MCP"],
      environment: { MODE: "test" },
      enabled: true,
    });
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

describe("MCP provenance comments", () => {
  const config = { type: "remote" as const, url: "https://mcp.notion.com/mcp" };

  test("explicit personal provenance wins even for a legacy public catalog identity", () => {
    const { name, config: catalogConfig } = globalMcpConfigFromDirectory({
      name: "Notion", serverName: "notion", description: "Notion", ...config,
    });
    const legacy = formatConfigWithMcpEntry(SAMPLE, name, catalogConfig);
    expect(parseGlobalMcpEntries(legacy).find((entry) => entry.name === name)?.catalogSource)
      .toBeUndefined();
    const raw = formatConfigWithMcpEntry(legacy, name, catalogConfig, { source: "personal" });
    expect(parseGlobalMcpEntries(raw).find((entry) => entry.name === name)).toEqual({
      name, config: catalogConfig, catalogSource: "personal",
    });
    expect(parse(raw)).toEqual(parse(legacy));
  });

  test("raw JSONC roundtrip adds only a header, with no identity or auth plaintext", () => {
    const remote = {
      type: "remote" as const,
      url: "https://private.test/mcp?token=url-secret",
      headers: { Authorization: "Bearer header-secret" },
      oauth: { clientSecret: "oauth-secret" },
    };
    const local = {
      type: "local" as const,
      command: ["private-command", "--token", "command-secret"],
      environment: { TOKEN: "env-secret" },
    };
    const raw = formatConfigWithMcpEntry(
      formatConfigWithMcpEntry(SAMPLE, "remote", remote, { source: "public", catalogId: "catalog-1" }),
      "local", local, { source: "personal" },
    );
    const header = raw.split("\n")[0]!;
    expect(header.startsWith("// jugglework-connector-sources: ")).toBe(true);
    const metadata = JSON.parse(header.slice("// jugglework-connector-sources: ".length));
    expect(metadata).toEqual({
      remote: { source: "public", catalogId: "catalog-1", identity: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/) },
      local: { source: "personal", identity: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/) },
    });
    for (const secret of [remote.url, "header-secret", "oauth-secret", ...local.command, "env-secret"]) {
      expect(header).not.toContain(secret);
    }
    expect(parse(raw)).toEqual({
      ...parse(SAMPLE), mcp: { ...parse(SAMPLE).mcp, remote, local },
    });
    expect(raw).toContain("// 用户备注");
    expect(parseGlobalMcpEntries(raw).find((entry) => entry.name === "remote")).toEqual({
      name: "remote", config: remote, catalogSource: "public", catalogId: "catalog-1",
    });
  });

  test("enable and auth changes preserve the hash; app endpoint edits retain source and refresh it", () => {
    const original = formatConfigWithMcpEntry(SAMPLE, "notion", config, { source: "public", catalogId: "notion" });
    const disabled = formatConfigWithMcpEnabled(original, "notion", false);
    expect(disabled.split("\n")[0]).toBe(original.split("\n")[0]);
    const authenticated = formatConfigWithMcpEntry(disabled, "notion", {
      ...config, enabled: true, headers: { Authorization: "new-secret" }, oauth: false,
    });
    expect(authenticated.split("\n")[0]).toBe(original.split("\n")[0]);
    const editedConfig = { type: "local" as const, command: ["node", "custom.js"] };
    const edited = formatConfigWithMcpEntry(authenticated, "notion", editedConfig);
    expect(edited.split("\n")[0]).not.toBe(original.split("\n")[0]);
    expect(parseGlobalMcpEntries(edited).find((entry) => entry.name === "notion")).toEqual({
      name: "notion", config: editedConfig, catalogSource: "public", catalogId: "notion",
    });
    expect(formatConfigWithMcpEntry(edited, "notion", editedConfig)).toBe(edited);
    const overridden = formatConfigWithMcpEntry(edited, "notion", editedConfig, { source: "personal" });
    expect(parseGlobalMcpEntries(overridden).find((entry) => entry.name === "notion")?.catalogId).toBeUndefined();
    expect(parseGlobalMcpEntries(overridden).find((entry) => entry.name === "notion")?.catalogSource).toBe("personal");
  });

  test("removal clears only that source and removes an empty header", () => {
    const one = formatConfigWithMcpEntry(SAMPLE, "context7", config, { source: "public" });
    const both = formatConfigWithMcpEntry(one, "local-tool", {
      type: "local", command: ["npx", "-y", "tool"],
    }, { source: "personal" });
    const remaining = formatConfigWithoutMcpEntry(both, "context7");
    expect(remaining.split("\n")[0]).not.toContain("context7");
    expect(parseGlobalMcpEntries(remaining)[0]?.catalogSource).toBe("personal");
    expect(formatConfigWithoutMcpEntry(remaining, "local-tool")).not.toContain("jugglework-connector-sources");
    const missingConfig = both.replace('"context7":', '"renamed":');
    expect(formatConfigWithoutMcpEntry(missingConfig, "context7").split("\n")[0]).not.toContain("context7");
  });

  test("external URL changes invalidate provenance and are not revived by app edits", () => {
    const original = formatConfigWithMcpEntry("", "notion", config, { source: "public", catalogId: "notion" });
    const stale = original.replace(config.url, "https://different.test/mcp");
    expect(parseGlobalMcpEntries(stale)[0]?.catalogSource).toBeUndefined();
    expect(parseGlobalMcpEntries(stale)[0]?.catalogId).toBeUndefined();
    const enabled = formatConfigWithMcpEnabled(stale, "notion", false);
    expect(parseGlobalMcpEntries(enabled)[0]?.catalogSource).toBeUndefined();
    const edited = formatConfigWithMcpEntry(stale, "notion", config);
    expect(parseGlobalMcpEntries(edited)[0]?.catalogSource).toBeUndefined();
    expect(edited).not.toContain("jugglework-connector-sources");
    const authOnly = original.replace('"type": "remote"', '"headers": {"Authorization":"changed"}, "type": "remote"');
    expect(parseGlobalMcpEntries(authOnly)[0]?.catalogSource).toBe("public");
  });

  test("identity is deterministic, trims URL edges, and distinguishes command argument boundaries", () => {
    const raw = formatConfigWithMcpEntry("", "mcp", config, { source: "personal" });
    expect(formatConfigWithMcpEntry("", "mcp", { ...config, url: ` ${config.url} ` }, { source: "personal" })
      .split("\n")[0]).toBe(raw.split("\n")[0]);
    const local = formatConfigWithMcpEntry("", "mcp", {
      type: "local", command: ["node", "a b"],
    }, { source: "personal" });
    const changed = local.replace('"a b"', '"a", "b"');
    expect(parseGlobalMcpEntries(changed)[0]?.catalogSource).toBeUndefined();
    const edited = formatConfigWithMcpEntry(local, "mcp", { type: "local", command: ["node", "a", "b"] });
    expect(parseGlobalMcpEntries(edited)[0]?.catalogSource).toBe("personal");
    expect(edited.split("\n")[0]).not.toBe(local.split("\n")[0]);
  });

  test("malformed, multiline, non-header, and invalid metadata fall back to legacy entries", () => {
    const raw = formatConfigWithMcpEntry("", "mcp", config, { source: "personal" });
    const body = raw.slice(raw.indexOf("\n") + 1);
    for (const payload of ["not json", "null", "[]", '{"mcp":null}',
      '{"mcp":{"source":"other","identity":"fnv1a32:00000000"}}',
      '{"mcp":{"source":"public","catalogId":1,"identity":"fnv1a32:00000000"}}',
      '{"mcp":{"source":"personal","identity":"https://secret.test"}}',
      '{"mcp":{"source":"public","identity":"fnv1a32:00000000","url":"secret"}}',
      '{\n// "mcp":{}}',
    ]) {
      const malformed = `// jugglework-connector-sources: ${payload}\n${body}`;
      expect(parseGlobalMcpEntries(malformed)[0]?.catalogSource).toBeUndefined();
    }
    expect(parseGlobalMcpEntries(`${body}${raw.split("\n")[0]}\n`)[0]?.catalogSource).toBeUndefined();
    expect(parseGlobalMcpEntries(`/*\n${raw.split("\n")[0]}\n*/\n${body}`)[0]?.catalogSource).toBeUndefined();
    expect(parseGlobalMcpEntries(raw.replace(/\n/g, "\r\n"))[0]?.catalogSource).toBe("personal");
  });

  test("connector names matching inherited object properties roundtrip safely", () => {
    const raw = formatConfigWithMcpEntry("", "constructor", config, { source: "personal" });
    expect(parseGlobalMcpEntries(raw)[0]?.catalogSource).toBe("personal");
    expect(formatConfigWithoutMcpEntry(raw, "constructor")).not.toContain("jugglework-connector-sources");
  });
});

describe("global MCP persistence", () => {
  function memoryTarget(initial = SAMPLE) {
    let raw = initial;
    const writes: string[] = [];
    const target: GlobalConfigTarget = {
      workspaceId: "test-workspace", workspaceRoot: "/unused", isLocalWorkspace: false,
      juggleworkClient: {
        async readOpencodeConfigFile(workspaceId: string, scope: string) {
          expect(workspaceId).toBe("test-workspace");
          expect(scope).toBe("global");
          return { content: raw };
        },
        async writeOpencodeConfigFile(workspaceId: string, scope: string, content: string) {
          expect(workspaceId).toBe("test-workspace");
          expect(scope).toBe("global");
          writes.push(content);
          raw = content;
          return { ok: true };
        },
      } as GlobalConfigTarget["juggleworkClient"],
    };
    return { target, writes };
  }

  test("create, read, enable, upsert, and remove retain raw comment provenance", async () => {
    const { target, writes } = memoryTarget();
    await createGlobalMcp(target, "added", { type: "remote", url: "https://new.test" }, { source: "personal" });
    await setGlobalMcpEnabled(target, "added", false);
    await upsertGlobalMcp(target, "added", { type: "remote", url: "https://edited.test" });
    expect((await readGlobalMcpEntries(target)).find((entry) => entry.name === "added")?.catalogSource).toBe("personal");
    await upsertGlobalMcp(target, "added", { type: "local", command: ["node", "mcp.js"] }, { source: "public", catalogId: "catalog" });
    expect((await readGlobalMcpEntries(target)).find((entry) => entry.name === "added")?.catalogId).toBe("catalog");
    await removeGlobalMcp(target, "added");
    expect(writes).toHaveLength(5);
    expect(writes.at(-1)).not.toContain("jugglework-connector-sources");
    expect(writes.every((raw) => raw.includes("// 用户备注"))).toBe(true);
  });

  test("create checks persisted names including non-object entries without overwriting", async () => {
    for (const raw of [SAMPLE, '{"mcp":{"context7":false}}']) {
      const { target, writes } = memoryTarget(raw);
      await expect(createGlobalMcp(target, "context7", { type: "local", command: ["replacement"] }, { source: "personal" }))
        .rejects.toThrow('Global MCP connector "context7" already exists.');
      expect(writes).toEqual([]);
    }
    const { target, writes } = memoryTarget('{"mcp":{"__proto__":{"type":"remote","url":"https://existing.test"}}}');
    await expect(createGlobalMcp(target, "__proto__", { type: "local", command: ["replacement"] }))
      .rejects.toThrow('Global MCP connector "__proto__" already exists.');
    expect(writes).toEqual([]);
  });

  test.each([undefined, "stable-catalog-id"])("legacy public edits persist inferred provenance with catalog ID %s", async (id) => {
    const directory: McpDirectoryInfo = {
      id, name: "Public connector", serverName: "public-server", description: "Public fixture",
      type: "remote", url: "https://public.example/mcp", oauth: true,
    };
    const legacy = globalMcpConfigFromDirectory(directory);
    const { target, writes } = memoryTarget(formatConfigWithMcpEntry(SAMPLE, legacy.name, legacy.config));
    const previous = (await readGlobalMcpEntries(target)).find((entry) => entry.name === legacy.name)!;
    expect(previous.catalogSource).toBeUndefined();
    const inferredPublic = matchPublicConnector(previous, [directory])!;
    const config = { ...legacy.config, url: "https://edited.example/mcp" };
    const catalogId = inferredPublic.id ?? getMcpServerName(inferredPublic);
    await upsertGlobalMcp(target, legacy.name, config, { source: "public", catalogId });
    const persisted = (await readGlobalMcpEntries(target)).find((entry) => entry.name === legacy.name)!;
    expect(persisted).toEqual({ name: legacy.name, config, catalogSource: "public", catalogId });
    expect(matchPublicConnector(persisted, [directory])).toEqual(directory);
    expect(resolveConnectorCatalogSource(persisted, [])).toBe("public");
    expect(writes[0]).toContain("// jugglework-connector-sources:");
    expect(writes[0]).toContain("// 用户备注");
    await upsertGlobalMcp(target, legacy.name, { ...config, url: "https://edited-again.example/mcp" });
    await setGlobalMcpEnabled(target, legacy.name, false);
    expect((await readGlobalMcpEntries(target)).find((entry) => entry.name === legacy.name)).toMatchObject({
      catalogSource: "public", catalogId, config: { enabled: false },
    });
  });

  test("concurrent creates cannot overwrite each other, and rejection does not block later mutations", async () => {
    const { target, writes } = memoryTarget();
    const results = await Promise.allSettled([
      createGlobalMcp(target, "new", { type: "remote", url: "https://first.test" }, { source: "public" }),
      createGlobalMcp(target, "new", { type: "remote", url: "https://second.test" }, { source: "personal" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(writes).toHaveLength(1);
    expect((await readGlobalMcpEntries(target)).find((entry) => entry.name === "new")).toEqual({
      name: "new", config: { type: "remote", url: "https://first.test" }, catalogSource: "public",
    });
    await createGlobalMcp(target, "next", { type: "local", command: ["node"] });
    expect(writes).toHaveLength(2);
  });
});
