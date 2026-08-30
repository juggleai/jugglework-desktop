import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCloudPluginDeliveryPlan, installCloudPlugin, readCloudPluginResolved, readInstalledCloudPlugins, removeCloudPlugin, type CloudPluginResolved } from "./cloud-plugins.js";
import { addMcp, setMcpEnabled } from "./mcp.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_cloud_plugin_test";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-plugin-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    await fn({ root, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}

function makeLegacyLedger(root: string, pluginId: string): void {
  const database = new Database(join(root, "runtime.sqlite"));
  try {
    const row = database.query("SELECT config_json AS configJson FROM cloud_plugin_install_configs WHERE workspace_id = ?").get(WORKSPACE_ID) as { configJson: string };
    const config = JSON.parse(row.configJson) as { plugins: Record<string, { files: Array<Record<string, unknown>> }> };
    for (const file of config.plugins[pluginId]!.files) {
      delete file.ownerPluginId;
      delete file.ownerConfigObjectId;
      delete file.digest;
    }
    database.query("UPDATE cloud_plugin_install_configs SET config_json = ? WHERE workspace_id = ?").run(JSON.stringify(config), WORKSPACE_ID);
  } finally {
    database.close();
  }
}

function mixedPlugin(version: "v1" | "v2" = "v1"): CloudPluginResolved {
  const components: CloudPluginResolved["memberships"] = [
    {
      configObjectId: "skill",
      configObject: {
        id: "skill", objectType: "skill", title: version === "v1" ? "Planner" : "Planner Next", description: "Plan work",
        currentRelativePath: null, status: "active", updatedAt: version, latestVersion: { id: `skill-${version}`, rawSourceText: `# ${version}`, normalizedPayloadJson: null },
      },
    },
    {
      configObjectId: "command",
      configObject: {
        id: "command", objectType: "command", title: "Run Plan", description: "Run work",
        currentRelativePath: null, status: "active", updatedAt: version, latestVersion: { id: `command-${version}`, rawSourceText: "Execute.", normalizedPayloadJson: null },
      },
    },
    {
      configObjectId: "agent",
      configObject: {
        id: "agent", objectType: "agent", title: "Planner Agent", description: "Plan work",
        currentRelativePath: null, status: "active", updatedAt: version, latestVersion: { id: `agent-${version}`, rawSourceText: "Plan.", normalizedPayloadJson: null },
      },
    },
    {
      configObjectId: "local-mcp",
      configObject: {
        id: "local-mcp", objectType: "mcp", title: "Local Search", description: null,
        currentRelativePath: null, status: "active", updatedAt: version,
        latestVersion: { id: `local-mcp-${version}`, rawSourceText: null, normalizedPayloadJson: { mcp: { search: { command: ["bunx", "search-mcp"] } } } },
      },
    },
    {
      configObjectId: "cloud-mcp",
      configObject: {
        id: "cloud-mcp", objectType: "mcp", title: "Cloud Search", description: null,
        currentRelativePath: null, status: "active", updatedAt: version,
        latestVersion: { id: `cloud-mcp-${version}`, rawSourceText: null, normalizedPayloadJson: { mcp: { cloud: { url: "https://example.com/mcp" } } } },
      },
    },
  ];
  return {
    plugin: { id: "mixed-plugin", name: "Mixed Plugin", description: "Mixed delivery", updatedAt: version },
    memberships: version === "v1" ? components : components.filter((entry) => entry.configObjectId !== "command" && entry.configObjectId !== "agent"),
  };
}

function identifiedPlugin(id: string, name: string): CloudPluginResolved {
  const resolved = mixedPlugin();
  return { ...resolved, plugin: { ...resolved.plugin, id, name } };
}

function duplicateFilePlugin(version: "v1" | "v2", duplicate: boolean): CloudPluginResolved {
  const membership = (id: string): CloudPluginResolved["memberships"][number] => ({
    configObjectId: id,
    configObject: {
      id,
      objectType: "skill",
      title: "Shared Skill",
      description: "Shared destination",
      currentRelativePath: null,
      status: "active",
      updatedAt: version,
      latestVersion: { id: `${id}-${version}`, rawSourceText: `# ${id} ${version}`, normalizedPayloadJson: null },
    },
  });
  return {
    plugin: { id: "duplicate-file-plugin", name: "Duplicate File Plugin", description: null, updatedAt: version },
    memberships: duplicate ? [membership("skill-a"), membership("skill-b")] : [membership("skill-a")],
  };
}

function duplicateMcpPlugin(version: "v1" | "v2", duplicate: boolean): CloudPluginResolved {
  const membership = (id: string): CloudPluginResolved["memberships"][number] => ({
    configObjectId: id,
    configObject: {
      id,
      objectType: "mcp",
      title: `${id} MCP`,
      description: null,
      currentRelativePath: null,
      status: "active",
      updatedAt: version,
      latestVersion: {
        id: `${id}-${version}`,
        rawSourceText: null,
        normalizedPayloadJson: { mcp: { search: { command: [id, version] } } },
      },
    },
  });
  return {
    plugin: { id: "duplicate-mcp-plugin", name: "Duplicate MCP Plugin", description: null, updatedAt: version },
    memberships: duplicate ? [membership("mcp-a"), membership("mcp-b")] : [membership("mcp-a")],
  };
}

describe("cloud plugin installs", () => {
  test("stores installed plugin state in the server DB and projects runtime resources", async () => {
    await withWorkspace(async ({ root, config }) => {
      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: "marketplace_1",
        marketplace: { id: "marketplace_1", name: "Team Marketplace", updatedAt: "2026-06-01T00:00:00.000Z" },
        // 组织云端插件：远程 MCP 由 Connect 网关承载，不落本地配置。
        cloudGatewayHosted: true,
        resolved: {
          plugin: {
            id: "plugin_1",
            name: "Creative Brief Plugin",
            description: "Brief writing workflow",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
          memberships: [
            {
              configObjectId: "config_skill_1",
              configObject: {
                id: "config_skill_1",
                objectType: "skill",
                title: "Brief Builder",
                description: "Use for creative briefs",
                currentRelativePath: null,
                status: "active",
                updatedAt: "2026-06-02T00:00:00.000Z",
                latestVersion: {
                  id: "version_skill_1",
                  rawSourceText: "# Brief Builder\n\nWhen asked for OWP_BRIEF_TEST_TOKEN, reply with the installed plugin token.",
                  normalizedPayloadJson: null,
                },
              },
            },
            {
              configObjectId: "config_mcp_1",
              configObject: {
                id: "config_mcp_1",
                objectType: "mcp",
                title: "Brief MCP",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: "2026-06-02T00:00:00.000Z",
                latestVersion: {
                  id: "version_mcp_1",
                  rawSourceText: JSON.stringify({ mcpServers: { brief: { url: "https://example.com/mcp" } } }),
                  normalizedPayloadJson: { mcpServers: { brief: { url: "https://example.com/mcp" } } },
                },
              },
            },
            {
              configObjectId: "config_mcp_2",
              configObject: {
                id: "config_mcp_2",
                objectType: "mcp",
                title: "Vision MCP",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: "2026-06-02T00:00:00.000Z",
                latestVersion: {
                  id: "version_mcp_2",
                  rawSourceText: JSON.stringify({ mcp: { vision: { type: "local", command: ["npx", "-y", "vision-mcp"] } } }),
                  normalizedPayloadJson: { mcp: { vision: { type: "local", command: ["npx", "-y", "vision-mcp"] } } },
                },
              },
            },
          ],
        },
      });
      const imported = result.item;

      expect(imported.pluginId).toBe("plugin_1");
      expect(result.warnings).toEqual([]);
      // Cloud 组件也进入 ledger，但不写本地配置。
      expect(imported.files.map((file) => file.objectType).sort()).toEqual(["mcp", "mcp", "skill"]);
      expect(imported.files.find((file) => file.title === "Brief MCP")).toMatchObject({
        delivery: "cloud",
        outcome: "available_cloud",
      });

      const installed = await readInstalledCloudPlugins(config, WORKSPACE_ID);
      expect(installed.plugins.plugin_1?.name).toBe("Creative Brief Plugin");
      expect(installed.marketplaces.marketplace_1?.pluginIds).toEqual(["plugin_1"]);

      const skillPath = join(root, ".opencode", "skills", "creative-brief-plugin", "brief-builder", "SKILL.md");
      expect(await readFile(skillPath, "utf8")).toContain("OWP_BRIEF_TEST_TOKEN");
      const runtimeConfig = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
      // 远程组件不落地：组织统一的凭据不该被复制成每台机器各自持有的本地配置。
      expect(runtimeConfig.mcp?.brief).toBeUndefined();
      expect(runtimeConfig.mcp?.["creative-brief-plugin-vision"]).toMatchObject({
        type: "local",
        command: ["npx", "-y", "vision-mcp"],
      });

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "plugin_1" });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins.plugin_1).toBeUndefined();
      // 卸载时缺少远程组件的本地文件不应导致失败或残留。
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["creative-brief-plugin-vision"]).toBeUndefined();
      await expectMissing(skillPath);
    });
  });

  test("translates Claude agent and command frontmatter and removes every installed file", async () => {
    await withWorkspace(async ({ root, config }) => {
      const agentSource = [
        "---",
        "name: Code-Reviewer",
        "description: Reviews pull requests",
        "tools: Read, Grep, Bash",
        "model: sonnet",
        "---",
        "",
        "Review the diff carefully.",
      ].join("\n");
      const commandSource = [
        "---",
        "description: Generate release notes",
        "model: opus",
        "allowed-tools: Bash(git log:*)",
        "---",
        "",
        "Summarize commits since the last tag.",
      ].join("\n");

      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: {
          plugin: {
            id: "plugin_2",
            name: "Review Plugin",
            description: "Review workflow",
            updatedAt: null,
          },
          memberships: [
            {
              configObjectId: "config_agent_1",
              configObject: {
                id: "config_agent_1",
                objectType: "agent",
                title: "Fancy Code Reviewer!",
                description: "Agent that reviews code",
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_agent_1", rawSourceText: agentSource, normalizedPayloadJson: null },
              },
            },
            {
              configObjectId: "config_command_1",
              configObject: {
                id: "config_command_1",
                objectType: "command",
                title: "Release Notes",
                description: "Writes release notes",
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_command_1", rawSourceText: commandSource, normalizedPayloadJson: null },
              },
            },
            {
              configObjectId: "config_context_1",
              configObject: {
                id: "config_context_1",
                objectType: "context",
                title: "Style Guide",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_context_1", rawSourceText: "# Style Guide", normalizedPayloadJson: null },
              },
            },
          ],
        },
      });
      const imported = result.item;

      const agentPath = join(root, ".opencode", "agents", "review-plugin", "fancy-code-reviewer.md");
      const commandPath = join(root, ".opencode", "commands", "review-plugin", "release-notes.md");
      const contextPath = join(root, ".opencode", "context", "review-plugin", "style-guide.md");
      expect(imported.files.map((file) => file.path).sort()).toEqual([
        ".opencode/agents/review-plugin/fancy-code-reviewer.md",
        ".opencode/commands/review-plugin/release-notes.md",
        ".opencode/context/review-plugin/style-guide.md",
      ]);
      expect(result.warnings).toEqual([]);

      const agentContent = await readFile(agentPath, "utf8");
      expect(agentContent).toContain("description: Reviews pull requests");
      expect(agentContent).toContain("tools:");
      expect(agentContent).toContain("read: true");
      expect(agentContent).toContain("grep: true");
      expect(agentContent).toContain("bash: true");
      expect(agentContent).not.toContain("model:");
      expect(agentContent).not.toContain("Read, Grep, Bash");
      expect(agentContent).toContain("Review the diff carefully.");

      const commandContent = await readFile(commandPath, "utf8");
      expect(commandContent).toContain("name: release-notes");
      expect(commandContent).toContain("description: Generate release notes");
      expect(commandContent).not.toContain("model:");
      expect(commandContent).not.toContain("allowed-tools");
      expect(commandContent).toContain("Summarize commits since the last tag.");

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "plugin_2" });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins.plugin_2).toBeUndefined();
      await expectMissing(agentPath);
      await expectMissing(commandPath);
      await expectMissing(contextPath);
    });
  });

  test("keeps fully qualified model ids and tool lists when translating agent frontmatter", async () => {
    await withWorkspace(async ({ root, config }) => {
      const agentSource = [
        "---",
        "description: Triage agent",
        "model: opencode/claude-haiku-4-5",
        "tools:",
        "  - Read",
        "  - WebFetch",
        "---",
        "",
        "Triage issues.",
      ].join("\n");

      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: {
          plugin: { id: "plugin_3", name: "Triage Plugin", description: null, updatedAt: null },
          memberships: [
            {
              configObjectId: "config_agent_2",
              configObject: {
                id: "config_agent_2",
                objectType: "agent",
                title: "Triage",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_agent_2", rawSourceText: agentSource, normalizedPayloadJson: null },
              },
            },
          ],
        },
      });
      expect(result.warnings).toEqual([]);

      const agentPath = join(root, ".opencode", "agents", "triage-plugin", "triage.md");
      const agentContent = await readFile(agentPath, "utf8");
      expect(agentContent).toContain("model: opencode/claude-haiku-4-5");
      expect(agentContent).toContain("read: true");
      expect(agentContent).toContain("webfetch: true");
    });
  });

  test("delivers every MCP field the console can author", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: "marketplace_1",
        marketplace: { id: "marketplace_1", name: "Team Marketplace", updatedAt: "2026-06-01T00:00:00.000Z" },
        // 本地插件：远程组件也落盘，用来验证 transport / oauth / timeout 的搬运。
        cloudGatewayHosted: false,
        resolved: {
          plugin: { id: "plugin_fields", name: "Field Coverage", description: null, updatedAt: "2026-06-02T00:00:00.000Z" },
          memberships: [{
            configObjectId: "config_mcp_fields",
            configObject: {
              id: "config_mcp_fields",
              objectType: "mcp",
              title: "Field Coverage MCP",
              description: null,
              currentRelativePath: null,
              status: "active",
              updatedAt: "2026-06-02T00:00:00.000Z",
              latestVersion: {
                id: "version_fields",
                rawSourceText: null,
                normalizedPayloadJson: {
                  mcp: {
                    local_one: { type: "local", command: ["npx", "-y", "pkg"], cwd: "packages/api", timeout: 30000 },
                    remote_one: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      transport: "sse",
                      timeout: 20000,
                      oauth: { clientId: "cid", scope: "read" },
                    },
                  },
                },
              },
            },
          }],
        },
      });

      const runtime = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
      // 控制台能填的字段必须都到达成员机器，否则「填了没生效」只会在别人机器上暴露。
      expect(runtime.mcp?.["field-coverage-plugin-local_one"]).toMatchObject({ cwd: "packages/api", timeout: 30000 });
      expect(runtime.mcp?.["field-coverage-plugin-remote_one"]).toMatchObject({
        transport: "sse",
        timeout: 20000,
        oauth: { clientId: "cid", scope: "read" },
      });
    });
  });

  test("a member's MCP enable state survives plugin re-delivery", async () => {
    await withWorkspace(async ({ root, config }) => {
      const deliver = (enabled: boolean, versionId: string) => installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: "marketplace_1",
        marketplace: { id: "marketplace_1", name: "Team Marketplace", updatedAt: "2026-06-01T00:00:00.000Z" },
        cloudGatewayHosted: true,
        resolved: {
          plugin: {
            id: "plugin_enabled_state",
            name: "Vision Plugin",
            description: null,
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
          memberships: [{
            configObjectId: "config_mcp_vision",
            configObject: {
              id: "config_mcp_vision",
              objectType: "mcp",
              title: "Vision MCP",
              description: null,
              currentRelativePath: null,
              status: "active",
              updatedAt: "2026-06-02T00:00:00.000Z",
              latestVersion: {
                id: versionId,
                rawSourceText: null,
                normalizedPayloadJson: {
                  mcp: { vision: { type: "local", command: ["npx", "-y", "vision-mcp"], enabled } },
                },
              },
            },
          }],
        },
      });

      // 首次投递：作者写的 enabled 就是初始默认值。
      await deliver(true, "version_1");
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["vision-plugin-vision"]).toMatchObject({ enabled: true });

      await setMcpEnabled(config, WORKSPACE_ID, "vision-plugin-vision", false);
      // 版本更新（作者那边仍写着 enabled: true）不得把成员关掉的组件重新打开。
      await deliver(true, "version_2");
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["vision-plugin-vision"]).toMatchObject({
        enabled: false,
        command: ["npx", "-y", "vision-mcp"],
      });
    });
  });

  test("builds a deterministic mixed delivery plan", () => {
    const first = buildCloudPluginDeliveryPlan({ resolved: mixedPlugin(), runtimeMcps: {}, cloudGatewayHosted: true });
    const second = buildCloudPluginDeliveryPlan({
      resolved: { ...mixedPlugin(), memberships: [...mixedPlugin().memberships].reverse() },
      runtimeMcps: {},
      cloudGatewayHosted: true,
    });

    expect(second).toEqual(first);
    expect(first.fileWrites.map((entry) => entry.path)).toEqual([
      ".opencode/agents/mixed-plugin/planner-agent.md",
      ".opencode/commands/mixed-plugin/run-plan.md",
      ".opencode/skills/mixed-plugin/planner/SKILL.md",
    ]);
    expect(first.mcpUpserts.map((entry) => entry.name)).toEqual(["mixed-plugin-search"]);
    expect(first.outcomes.find((entry) => entry.configObjectId === "cloud-mcp")).toMatchObject({ outcome: "available_cloud" });
  });

  test("accounts for a pure Cloud plugin as installed without local resources", async () => {
    await withWorkspace(async ({ root, config }) => {
      const cloud = mixedPlugin();
      cloud.memberships = cloud.memberships.filter((entry) => entry.configObjectId === "cloud-mcp");
      const result = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: cloud, cloudGatewayHosted: true,
      });

      expect(result.status).toBe("installed");
      expect(result.item.files).toHaveLength(1);
      expect(result.item.files[0]).toMatchObject({ delivery: "cloud", outcome: "available_cloud" });
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp).toBeUndefined();
    });
  });

  test("preserves resolved Cloud readiness and persists member/admin component outcomes as partial", async () => {
    await withWorkspace(async ({ root, config }) => {
      for (const state of ["needs_signin", "needs_admin_setup"] as const) {
        const cloud = mixedPlugin();
        cloud.plugin = { ...cloud.plugin, id: `cloud-${state}`, name: `Cloud ${state}` };
        cloud.memberships = cloud.memberships.filter((entry) => entry.configObjectId === "cloud-mcp");
        const connectionId = state === "needs_signin" ? "connection-1" : null;
        const resolved = readCloudPluginResolved({
          ...cloud,
          plugin: {
            ...cloud.plugin,
            cloudReadiness: {
              state,
              hasInstructional: false,
              connections: [],
              components: [{
                configObjectId: "cloud-mcp",
                serverName: "cloud",
                delivery: "cloud",
                url: "https://example.com/mcp",
                connectionId,
                ...(state === "needs_signin" ? { credentialMode: "per_member", connectedForMe: false } : {}),
              }],
            },
          },
        });

        expect(resolved.plugin.cloudReadiness).toMatchObject({ state, components: [expect.objectContaining({ connectionId })] });
        const result = await installCloudPlugin({
          serverConfig: config,
          workspaceId: WORKSPACE_ID,
          workspaceRoot: root,
          marketplaceId: null,
          resolved,
          cloudGatewayHosted: true,
        });

        expect(result.status).toBe("partial");
        expect(result.item.files).toEqual([
          expect.objectContaining({ delivery: "cloud", outcome: state }),
        ]);
        expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins[`cloud-${state}`]).toMatchObject({
          status: "partial",
          files: [expect.objectContaining({ outcome: state })],
        });
      }
    });
  });

  test("persists a structured partial outcome while delivering valid components", async () => {
    await withWorkspace(async ({ root, config }) => {
      const partial = mixedPlugin();
      partial.memberships.push({ configObjectId: "missing-component" });
      const result = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: partial, cloudGatewayHosted: true,
      });

      expect(result.status).toBe("partial");
      expect(result.outcomes.find((entry) => entry.configObjectId === "missing-component")).toMatchObject({
        outcome: "failed",
        errorCode: "component_missing",
      });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]?.status).toBe("partial");
      expect(await readFile(join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md"), "utf8")).toContain("# v1");
    });
  });

  test("installs, retries idempotently, cleans obsolete mixed resources, and removes owned resources", async () => {
    await withWorkspace(async ({ root, config }) => {
      const install = (resolved: CloudPluginResolved) => installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved, cloudGatewayHosted: true,
      });
      const first = await install(mixedPlugin("v1"));
      const repeated = await install(mixedPlugin("v1"));
      expect(repeated.item.files).toEqual(first.item.files);
      expect(Object.keys((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp ?? {})).toEqual(["mixed-plugin-search"]);

      const oldSkill = join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md");
      const newSkill = join(root, ".opencode", "skills", "mixed-plugin", "planner-next", "SKILL.md");
      const command = join(root, ".opencode", "commands", "mixed-plugin", "run-plan.md");
      const agent = join(root, ".opencode", "agents", "mixed-plugin", "planner-agent.md");
      await install(mixedPlugin("v2"));
      await expectMissing(oldSkill);
      await expectMissing(command);
      await expectMissing(agent);
      expect(await readFile(newSkill, "utf8")).toContain("# v2");

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "mixed-plugin" });
      await expectMissing(newSkill);
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["mixed-plugin-search"]).toBeUndefined();
    });
  });

  test("rejects user-owned MCP conflicts without mutation", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "mixed-plugin-search", { type: "local", command: ["user-server"], enabled: true });
      const before = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
      const result = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });

      expect(result.status).toBe("failed");
      expect(result.conflicts).toEqual([expect.objectContaining({ code: "mcp_ownership_conflict", resource: "mixed-plugin-search" })]);
      expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual(before);
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toBeUndefined();
    });
  });

  test("rejects duplicate normalized file destinations before a fresh install mutates the workspace", async () => {
    await withWorkspace(async ({ root, config }) => {
      let engineSyncCalls = 0;
      const resolved = duplicateFilePlugin("v1", true);
      expect(buildCloudPluginDeliveryPlan({ resolved, runtimeMcps: {} })).toEqual(buildCloudPluginDeliveryPlan({
        resolved: { ...resolved, memberships: [...resolved.memberships].reverse() },
        runtimeMcps: {},
      }));
      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved,
        synchronizeEngine: async () => {
          engineSyncCalls += 1;
        },
      });

      const path = join(root, ".opencode", "skills", "duplicate-file-plugin", "shared-skill", "SKILL.md");
      expect(result.status).toBe("failed");
      expect(result.conflicts).toEqual([
        expect.objectContaining({ code: "file_ownership_conflict", resource: ".opencode/skills/duplicate-file-plugin/shared-skill/SKILL.md" }),
      ]);
      expect(result.outcomes.filter((entry) => entry.errorCode === "duplicate_file_destination").map((entry) => entry.configObjectId)).toEqual([
        "skill-a",
        "skill-b",
      ]);
      expect(engineSyncCalls).toBe(0);
      await expectMissing(path);
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-file-plugin"]).toBeUndefined();
    });
  });

  test("preserves the previous installed file when an update contains a duplicate normalized destination", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: duplicateFilePlugin("v1", false),
      });
      const path = join(root, ".opencode", "skills", "duplicate-file-plugin", "shared-skill", "SKILL.md");
      const contentBefore = await readFile(path, "utf8");
      const installedBefore = (await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-file-plugin"];
      let engineSyncCalls = 0;

      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: duplicateFilePlugin("v2", true),
        synchronizeEngine: async () => {
          engineSyncCalls += 1;
        },
      });

      expect(result.status).toBe("failed");
      expect(result.conflicts[0]?.message).toContain("multiple plugin components");
      expect(await readFile(path, "utf8")).toBe(contentBefore);
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-file-plugin"]).toEqual(installedBefore);
      expect(engineSyncCalls).toBe(0);
    });
  });

  test("rejects duplicate normalized MCP names before a fresh install mutates runtime configuration", async () => {
    await withWorkspace(async ({ root, config }) => {
      let engineSyncCalls = 0;
      const resolved = duplicateMcpPlugin("v1", true);
      expect(buildCloudPluginDeliveryPlan({ resolved, runtimeMcps: {} })).toEqual(buildCloudPluginDeliveryPlan({
        resolved: { ...resolved, memberships: [...resolved.memberships].reverse() },
        runtimeMcps: {},
      }));
      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved,
        synchronizeEngine: async () => {
          engineSyncCalls += 1;
        },
      });

      expect(result.status).toBe("failed");
      expect(result.conflicts).toEqual([
        expect.objectContaining({ code: "mcp_ownership_conflict", resource: "duplicate-mcp-plugin-search" }),
      ]);
      expect(result.outcomes.filter((entry) => entry.errorCode === "duplicate_mcp_destination").map((entry) => entry.configObjectId)).toEqual([
        "mcp-a",
        "mcp-b",
      ]);
      expect(engineSyncCalls).toBe(0);
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp).toBeUndefined();
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-mcp-plugin"]).toBeUndefined();
    });
  });

  test("preserves the previous installed MCP when an update contains a duplicate normalized name", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: duplicateMcpPlugin("v1", false),
      });
      const runtimeBefore = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
      const installedBefore = (await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-mcp-plugin"];
      let engineSyncCalls = 0;

      const result = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: duplicateMcpPlugin("v2", true),
        synchronizeEngine: async () => {
          engineSyncCalls += 1;
        },
      });

      expect(result.status).toBe("failed");
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.message).toContain("multiple plugin components");
      expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual(runtimeBefore);
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["duplicate-mcp-plugin"]).toEqual(installedBefore);
      expect(engineSyncCalls).toBe(0);
    });
  });

  test("reports a conflict and retains the ledger when a valid-owned MCP was modified", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });
      await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
        ...current,
        mcp: { ...current.mcp, "mixed-plugin-search": { type: "local", command: ["member-server"] } },
      }));

      await expect(removeCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        pluginId: "mixed-plugin",
      })).rejects.toMatchObject({
        code: "cloud_plugin_ownership_conflict",
        details: expect.objectContaining({
          status: "repair_required",
          conflicts: [expect.objectContaining({ code: "mcp_ownership_conflict", resource: "mixed-plugin-search" })],
        }),
      });

      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["mixed-plugin-search"]).toEqual({
        type: "local",
        command: ["member-server"],
      });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toMatchObject({
        status: "repair_required",
        files: expect.arrayContaining([expect.objectContaining({ path: "opencode.jsonc#mcp.mixed-plugin-search" })]),
      });
    });
  });

  test("reports a conflict and retains the ledger when a valid-owned file was modified", async () => {
    await withWorkspace(async ({ root, config }) => {
      const skillOnly = mixedPlugin();
      skillOnly.memberships = skillOnly.memberships.filter((entry) => entry.configObjectId === "skill");
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: skillOnly,
        cloudGatewayHosted: true,
      });
      const skillPath = join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md");
      await writeFile(skillPath, "member edit\n", "utf8");

      await expect(removeCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        pluginId: "mixed-plugin",
      })).rejects.toMatchObject({
        code: "cloud_plugin_ownership_conflict",
        details: expect.objectContaining({
          status: "repair_required",
          conflicts: [expect.objectContaining({ code: "file_ownership_conflict" })],
        }),
      });

      expect(await readFile(skillPath, "utf8")).toBe("member edit\n");
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toMatchObject({
        status: "repair_required",
        files: [expect.objectContaining({ path: ".opencode/skills/mixed-plugin/planner/SKILL.md" })],
      });
    });
  });

  test("rejects an unowned destination file without overwriting it", async () => {
    await withWorkspace(async ({ root, config }) => {
      const path = join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md");
      await mkdir(join(root, ".opencode", "skills", "mixed-plugin", "planner"), { recursive: true });
      await writeFile(path, "user content\n", "utf8");

      const result = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });

      expect(result.status).toBe("failed");
      expect(result.conflicts).toContainEqual(expect.objectContaining({ code: "file_ownership_conflict" }));
      expect(await readFile(path, "utf8")).toBe("user content\n");
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toBeUndefined();
    });
  });

  test("rejects intermediate symlinks for writes and removals", async () => {
    await withWorkspace(async ({ root, config }) => {
      const external = await mkdtemp(join(tmpdir(), "jugglework-cloud-plugin-external-"));
      try {
        await mkdir(join(root, ".opencode", "skills"), { recursive: true });
        await symlink(external, join(root, ".opencode", "skills", "mixed-plugin"));
        await expect(installCloudPlugin({
          serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
          resolved: { ...mixedPlugin(), memberships: mixedPlugin().memberships.filter((entry) => entry.configObjectId === "skill") },
          cloudGatewayHosted: true,
        })).rejects.toMatchObject({ code: "invalid_cloud_plugin_path" });
        await expectMissing(join(external, "planner", "SKILL.md"));

        await rm(join(root, ".opencode", "skills", "mixed-plugin"), { force: true });
        await installCloudPlugin({
          serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
          resolved: { ...mixedPlugin(), memberships: mixedPlugin().memberships.filter((entry) => entry.configObjectId === "skill") },
          cloudGatewayHosted: true,
        });
        await rm(join(root, ".opencode", "skills", "mixed-plugin"), { recursive: true, force: true });
        await mkdir(join(external, "planner"), { recursive: true });
        await writeFile(join(external, "planner", "SKILL.md"), "external\n", "utf8");
        await symlink(external, join(root, ".opencode", "skills", "mixed-plugin"));

        await expect(removeCloudPlugin({
          serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "mixed-plugin",
        })).rejects.toMatchObject({ code: "invalid_cloud_plugin_path" });
        expect(await readFile(join(external, "planner", "SKILL.md"), "utf8")).toBe("external\n");
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });

  test("preserves sidecars during update, rollback, and removal", async () => {
    await withWorkspace(async ({ root, config }) => {
      const install = (resolved: CloudPluginResolved, failAfterStage?: "files") => installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved, cloudGatewayHosted: true, failAfterStage,
      });
      await install(mixedPlugin("v1"));
      const oldDirectory = join(root, ".opencode", "skills", "mixed-plugin", "planner");
      const oldSkill = join(oldDirectory, "SKILL.md");
      const oldSidecar = join(oldDirectory, "notes.txt");
      const oldCommand = join(root, ".opencode", "commands", "mixed-plugin", "run-plan.md");
      const oldAgent = join(root, ".opencode", "agents", "mixed-plugin", "planner-agent.md");
      const commandBefore = await readFile(oldCommand, "utf8");
      const agentBefore = await readFile(oldAgent, "utf8");
      await writeFile(oldSidecar, "keep old sidecar\n", "utf8");

      await expect(install(mixedPlugin("v2"), "files")).rejects.toMatchObject({ code: "cloud_plugin_install_failed" });
      expect(await readFile(oldSkill, "utf8")).toContain("# v1");
      expect(await readFile(oldSidecar, "utf8")).toBe("keep old sidecar\n");
      expect(await readFile(oldCommand, "utf8")).toBe(commandBefore);
      expect(await readFile(oldAgent, "utf8")).toBe(agentBefore);
      await expectMissing(join(root, ".opencode", "skills", "mixed-plugin", "planner-next", "SKILL.md"));

      await install(mixedPlugin("v2"));
      await expectMissing(oldSkill);
      expect(await readFile(oldSidecar, "utf8")).toBe("keep old sidecar\n");
      const newDirectory = join(root, ".opencode", "skills", "mixed-plugin", "planner-next");
      const newSidecar = join(newDirectory, "README.md");
      await writeFile(newSidecar, "keep new sidecar\n", "utf8");

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "mixed-plugin" });
      await expectMissing(join(newDirectory, "SKILL.md"));
      expect(await readFile(newSidecar, "utf8")).toBe("keep new sidecar\n");
      expect(await readFile(oldSidecar, "utf8")).toBe("keep old sidecar\n");
    });
  });

  test("preserves and reports legacy resources with uncertain ownership", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });
      makeLegacyLedger(root, "mixed-plugin");
      const skillPath = join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md");
      await writeFile(skillPath, "legacy user edit\n", "utf8");
      const runtimeBefore = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);

      const update = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });
      expect(update.status).toBe("failed");
      expect(update.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "file_ownership_conflict" }),
        expect.objectContaining({ code: "mcp_ownership_conflict" }),
      ]));
      expect(await readFile(skillPath, "utf8")).toBe("legacy user edit\n");
      expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual(runtimeBefore);

      await expect(removeCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "mixed-plugin",
      })).rejects.toMatchObject({
        code: "cloud_plugin_ownership_conflict",
        details: expect.objectContaining({ status: "repair_required" }),
      });
      expect(await readFile(skillPath, "utf8")).toBe("legacy user edit\n");
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]?.status).toBe("repair_required");
    });
  });

  test("keeps the previous working component when a partial update lacks its replacement", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin("v1"), cloudGatewayHosted: true,
      });
      const partial = mixedPlugin("v2");
      partial.memberships = partial.memberships.map((membership) => membership.configObjectId === "skill"
        ? { configObjectId: "skill" }
        : membership);

      const result = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: partial, cloudGatewayHosted: true,
      });
      const oldSkill = join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md");
      expect(result.status).toBe("partial");
      expect(result.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ configObjectId: "skill", outcome: "failed", errorCode: "component_missing" }),
        expect.objectContaining({ configObjectId: "skill", path: ".opencode/skills/mixed-plugin/planner/SKILL.md", outcome: "installed_local" }),
      ]));
      expect(await readFile(oldSkill, "utf8")).toContain("# v1");
      await expectMissing(join(root, ".opencode", "skills", "mixed-plugin", "planner-next", "SKILL.md"));
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]?.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".opencode/skills/mixed-plugin/planner/SKILL.md" }),
      ]));
    });
  });

  test("rolls back each mutation stage and allows retry", async () => {
    await withWorkspace(async ({ root, config }) => {
      const unrelatedPath = join(root, ".opencode", "unrelated.txt");
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(unrelatedPath, "keep\n", "utf8");
      await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({ mcp: { user: { type: "local", command: ["user"] } } }));

      for (const failAfterStage of ["files", "mcp", "record"] as const) {
        await expect(installCloudPlugin({
          serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
          resolved: mixedPlugin(), cloudGatewayHosted: true, failAfterStage,
        })).rejects.toMatchObject({ code: "cloud_plugin_install_failed", details: expect.objectContaining({ status: "failed" }) });
        expect(Object.keys((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp ?? {})).toEqual(["user"]);
        expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toBeUndefined();
        await expectMissing(join(root, ".opencode", "commands", "mixed-plugin", "run-plan.md"));
        expect(await readFile(unrelatedPath, "utf8")).toBe("keep\n");
      }

      const retried = await installCloudPlugin({
        serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, marketplaceId: null,
        resolved: mixedPlugin(), cloudGatewayHosted: true,
      });
      expect(retried.status).toBe("installed");
    });
  });

  test("serializes concurrent plugin mutations for the same workspace", async () => {
    await withWorkspace(async ({ root, config }) => {
      let releaseFirst!: () => void;
      const firstEngineSync = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstReachedEngine = false;
      let secondReachedEngine = false;
      const first = installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: identifiedPlugin("plugin-a", "Plugin A"),
        cloudGatewayHosted: true,
        synchronizeEngine: async () => {
          firstReachedEngine = true;
          await firstEngineSync;
        },
      });
      while (!firstReachedEngine) await Bun.sleep(1);

      const second = installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: identifiedPlugin("plugin-b", "Plugin B"),
        cloudGatewayHosted: true,
        synchronizeEngine: async () => {
          secondReachedEngine = true;
        },
      });
      await Bun.sleep(20);
      expect(secondReachedEngine).toBe(false);

      releaseFirst();
      await Promise.all([first, second]);
      expect(secondReachedEngine).toBe(true);
      expect(Object.keys((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins).sort()).toEqual([
        "plugin-a",
        "plugin-b",
      ]);
      expect(Object.keys((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp ?? {}).sort()).toEqual([
        "plugin-a-plugin-search",
        "plugin-b-plugin-search",
      ]);
    });
  });

  test("does not let a concurrent install restore a plugin being removed", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: identifiedPlugin("plugin-a", "Plugin A"),
        cloudGatewayHosted: true,
      });

      let releaseRemoval!: () => void;
      const removalEngineSync = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      let removalReachedEngine = false;
      let installReachedEngine = false;
      const removal = removeCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        pluginId: "plugin-a",
        synchronizeEngine: async () => {
          removalReachedEngine = true;
          await removalEngineSync;
        },
      });
      while (!removalReachedEngine) await Bun.sleep(1);

      const install = installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: identifiedPlugin("plugin-b", "Plugin B"),
        cloudGatewayHosted: true,
        synchronizeEngine: async () => {
          installReachedEngine = true;
        },
      });
      await Bun.sleep(20);
      expect(installReachedEngine).toBe(false);

      releaseRemoval();
      await Promise.all([removal, install]);
      expect(installReachedEngine).toBe(true);
      expect(Object.keys((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins)).toEqual(["plugin-b"]);
      expect(Object.keys((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp ?? {})).toEqual([
        "plugin-b-plugin-search",
      ]);
    });
  });

  test("does not report installed when engine synchronization fails", async () => {
    await withWorkspace(async ({ root, config }) => {
      let syncCalls = 0;
      await expect(installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: mixedPlugin(),
        cloudGatewayHosted: true,
        synchronizeEngine: async () => {
          syncCalls += 1;
          if (syncCalls === 1) throw new Error("engine rejected plugin MCP");
        },
      })).rejects.toMatchObject({
        code: "cloud_plugin_install_failed",
        details: expect.objectContaining({ status: "failed", cause: "engine rejected plugin MCP" }),
      });

      expect(syncCalls).toBe(2);
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toBeUndefined();
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["mixed-plugin-search"]).toBeUndefined();
      await expectMissing(join(root, ".opencode", "skills", "mixed-plugin", "planner", "SKILL.md"));
    });
  });

  test("install rollback restores only affected MCP names and preserves unrelated concurrent changes", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({
        mcp: { existing: { type: "local", command: ["existing"] } },
      }));
      let syncCalls = 0;

      await expect(installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: mixedPlugin(),
        cloudGatewayHosted: true,
        synchronizeEngine: async () => {
          syncCalls += 1;
          if (syncCalls !== 1) return;
          await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
            ...current,
            mcp: { ...current.mcp, concurrent: { type: "local", command: ["concurrent"] } },
          }));
          throw new Error("engine rejected plugin MCP");
        },
      })).rejects.toMatchObject({ code: "cloud_plugin_install_failed" });

      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp).toEqual({
        existing: { type: "local", command: ["existing"] },
        concurrent: { type: "local", command: ["concurrent"] },
      });
    });
  });

  test("removal rollback restores only affected MCP names and preserves unrelated concurrent changes", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: mixedPlugin(),
        cloudGatewayHosted: true,
      });
      let syncCalls = 0;

      await expect(removeCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        pluginId: "mixed-plugin",
        synchronizeEngine: async () => {
          syncCalls += 1;
          if (syncCalls !== 1) return;
          await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
            ...current,
            mcp: { ...current.mcp, concurrent: { type: "local", command: ["concurrent"] } },
          }));
          throw new Error("engine rejected plugin removal");
        },
      })).rejects.toMatchObject({ code: "cloud_plugin_remove_failed" });

      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp).toEqual({
        "mixed-plugin-search": expect.objectContaining({ command: ["bunx", "search-mcp"] }),
        concurrent: { type: "local", command: ["concurrent"] },
      });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"]).toBeDefined();
    });
  });

  test("persists removal rollback failures as repair required with details", async () => {
    await withWorkspace(async ({ root, config }) => {
      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: mixedPlugin(),
        cloudGatewayHosted: true,
      });

      await expect(removeCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        pluginId: "mixed-plugin",
        failAfterStage: "record",
        failRollbackStage: "files",
      })).rejects.toMatchObject({
        code: "cloud_plugin_repair_required",
        details: expect.objectContaining({
          status: "repair_required",
          rollbackFailures: expect.arrayContaining([
            expect.objectContaining({ stage: expect.stringMatching(/^files:/) }),
          ]),
        }),
      });

      const repaired = (await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins["mixed-plugin"];
      expect(repaired).toMatchObject({
        status: "repair_required",
        repair: {
          operation: "remove",
          cause: "Injected cloud plugin removal record stage failure",
          rollbackFailures: expect.arrayContaining([
            expect.objectContaining({ stage: expect.stringMatching(/^files:/) }),
          ]),
        },
      });
    });
  });
});
