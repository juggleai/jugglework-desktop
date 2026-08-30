import { describe, expect, test } from "bun:test";

import {
  isClaudePluginMutationSuccessful,
  isCloudPluginMutationSuccessful,
  isWorkspacePluginLoadCurrent,
  isWorkspacePluginOperationCurrent,
  resolveClaudePluginMutationWarnings,
  resolveCloudPluginMutationStatus,
  resolveWorkspacePluginAccess,
} from "../src/react-app/domains/settings/state/extensions-store";
import {
  readCloudImportedPlugin,
  readWorkspaceCloudImports,
  type CloudImportedPlugin,
} from "../src/app/cloud/import-state";
import {
  JuggleWorkServerError,
  readJuggleWorkCloudPluginMutationError,
  type JuggleWorkServerCapabilities,
} from "../src/app/lib/jugglework-server";

const writableCapabilities: JuggleWorkServerCapabilities = {
  skills: { read: true, write: true, source: "jugglework" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

const installedPlugin: CloudImportedPlugin = {
  pluginId: "plugin-1",
  marketplaceId: null,
  name: "Plugin 1",
  description: null,
  updatedAt: null,
  files: [],
  importedAt: 1,
};

describe("workspace marketplace plugin access", () => {
  test("rejects direct remote OpenCode before mutation", () => {
    expect(resolveWorkspacePluginAccess({
      workspaceType: "remote",
      supported: false,
      connected: true,
      capabilities: writableCapabilities,
    })).toEqual({ allowed: false, reason: "unsupported" });
  });

  test("rejects read-only runtimes", () => {
    expect(resolveWorkspacePluginAccess({
      workspaceType: "remote",
      supported: true,
      connected: true,
      capabilities: { ...writableCapabilities, plugins: { read: true, write: false } },
    })).toEqual({ allowed: false, reason: "read_only" });
  });

  test("allows a connected writable runtime", () => {
    expect(resolveWorkspacePluginAccess({
      workspaceType: "local",
      supported: true,
      connected: true,
      capabilities: writableCapabilities,
    })).toEqual({ allowed: true, reason: null });
  });

  test("rejects a late workspace A response after workspace B starts loading", () => {
    expect(isWorkspacePluginLoadCurrent({
      loadKey: "workspace-a:1",
      latestLoadKey: "workspace-b:2",
      operationContextKey: "workspace-a",
      currentContextKey: "workspace-b",
    })).toBeFalse();
    expect(isWorkspacePluginLoadCurrent({
      loadKey: "workspace-b:2",
      latestLoadKey: "workspace-b:2",
      operationContextKey: "workspace-b",
      currentContextKey: "workspace-b",
    })).toBeTrue();
  });

  test("keeps two workspace operation identities isolated", () => {
    const workspaceA = "local:workspace-a:/a:runtime-a";
    const workspaceB = "local:workspace-b:/b:runtime-b";
    expect(isWorkspacePluginLoadCurrent({
      loadKey: `${workspaceA}:7`,
      latestLoadKey: `${workspaceA}:7`,
      operationContextKey: workspaceA,
      currentContextKey: workspaceA,
    })).toBeTrue();
    expect(isWorkspacePluginLoadCurrent({
      loadKey: `${workspaceA}:7`,
      latestLoadKey: `${workspaceB}:8`,
      operationContextKey: workspaceA,
      currentContextKey: workspaceB,
    })).toBeFalse();
  });

  test("accepts operation state writes only for the captured workspace and latest plugin sequence", () => {
    expect(isWorkspacePluginOperationCurrent({
      operationContextKey: "workspace-a",
      currentContextKey: "workspace-a",
      operationSequence: 4,
      latestSequence: 4,
    })).toBeTrue();
    expect(isWorkspacePluginOperationCurrent({
      operationContextKey: "workspace-a",
      currentContextKey: "workspace-b",
      operationSequence: 4,
      latestSequence: 4,
    })).toBeFalse();
    expect(isWorkspacePluginOperationCurrent({
      operationContextKey: "workspace-a",
      currentContextKey: "workspace-a",
      operationSequence: 3,
      latestSequence: 4,
    })).toBeFalse();
  });

  test("does not report failed, repair-required, or conflicting installs as successful", () => {
    for (const status of ["failed", "repair_required"] as const) {
      const result = { item: installedPlugin, status, conflicts: [] };
      expect(resolveCloudPluginMutationStatus(result)).toBe(status);
      expect(isCloudPluginMutationSuccessful(result)).toBeFalse();
    }

    const conflict = {
      item: installedPlugin,
      status: "installed" as const,
      conflicts: [{
        code: "file_ownership_conflict" as const,
        configObjectId: "object-1",
        resource: ".opencode/skills/example/SKILL.md",
        message: "Already owned",
      }],
    };
    expect(resolveCloudPluginMutationStatus(conflict)).toBe("installed");
    expect(isCloudPluginMutationSuccessful(conflict)).toBeFalse();
  });

  test("accepts installed and partial responses only when there are no conflicts", () => {
    expect(isCloudPluginMutationSuccessful({ item: installedPlugin, status: "installed", conflicts: [] })).toBeTrue();
    expect(isCloudPluginMutationSuccessful({ item: installedPlugin, status: "partial", conflicts: [] })).toBeTrue();
  });

  test("reports Claude installs as successful only when every component is cleanly installed", () => {
    const cleanResult = {
      item: installedPlugin,
      status: "installed" as const,
      warnings: [],
      outcomes: [],
      conflicts: [],
    };
    expect(isClaudePluginMutationSuccessful(cleanResult)).toBeTrue();
    expect(isClaudePluginMutationSuccessful({ ...cleanResult, status: "partial" })).toBeFalse();
    expect(isClaudePluginMutationSuccessful({ ...cleanResult, warnings: ["Skipped a component."] })).toBeFalse();
    expect(isClaudePluginMutationSuccessful({
      ...cleanResult,
      outcomes: [{
        configObjectId: "mcp-1",
        versionId: null,
        objectType: "mcp",
        title: "Example MCP",
        path: "cloud:example",
        updatedAt: null,
        outcome: "needs_signin",
      }],
    })).toBeFalse();
  });

  test("preserves skipped-component warnings from Claude plugin preview and installation", () => {
    expect(resolveClaudePluginMutationWarnings({
      preview: { warnings: ["Skipped an unsupported hook.", "Shared warning."] },
      warnings: ["Shared warning.", "Skipped an unsupported MCP server."],
    })).toEqual([
      "Skipped an unsupported hook.",
      "Shared warning.",
      "Skipped an unsupported MCP server.",
    ]);
  });

  test("parses additive plugin ledger fields while retaining legacy records", () => {
    const legacy = readWorkspaceCloudImports({
      cloudImports: {
        plugins: {
          legacy: {
            name: "Legacy",
            files: [{
              configObjectId: "legacy-skill",
              objectType: "skill",
              title: "Legacy skill",
              path: ".opencode/skills/legacy/SKILL.md",
            }],
          },
        },
      },
    }).plugins.legacy;
    expect(legacy).toMatchObject({ pluginId: "legacy", name: "Legacy" });

    const current = readCloudImportedPlugin({
      ...installedPlugin,
      status: "installed",
      resolvedRevision: "revision-2",
      repair: {
        operation: "install",
        cause: "rollback incomplete",
        conflicts: [],
        rollbackFailures: [{ stage: "engine", message: "offline" }],
        recordedAt: 42,
      },
      files: [{
        configObjectId: "mcp-1",
        componentKey: "mcp-1:search",
        serverName: "search",
        objectType: "mcp",
        title: "Search",
        path: "opencode.jsonc#mcp.search",
      }],
    });
    expect(current).toMatchObject({
      status: "installed",
      resolvedRevision: "revision-2",
      files: [{ componentKey: "mcp-1:search", serverName: "search" }],
      repair: { operation: "install", rollbackFailures: [{ stage: "engine", message: "offline" }] },
    });
  });

  test("parses structured persisted mutation errors without dropping additive fields", () => {
    const current = {
      ...installedPlugin,
      status: "repair_required" as const,
      resolvedRevision: "revision-3",
      files: [{
        configObjectId: "mcp-1",
        componentKey: "mcp-1:docs",
        serverName: "docs",
        versionId: null,
        objectType: "mcp",
        title: "Docs",
        path: "opencode.jsonc#mcp.docs",
        updatedAt: null,
      }],
    };
    const parsed = readJuggleWorkCloudPluginMutationError(new JuggleWorkServerError(
      409,
      "cloud_plugin_ownership_conflict",
      "Repair required",
      {
        status: "repair_required",
        changed: true,
        current,
        outcomes: current.files,
        mutations: {
          filesWritten: [],
          filesRemoved: [],
          mcpUpserted: [],
          mcpRemoved: [],
          installationRecordChanged: true,
          engineSynchronized: false,
        },
        repair: {
          operation: "remove",
          cause: "modified",
          conflicts: [],
          rollbackFailures: [],
          recordedAt: 10,
        },
        resolvedRevision: "revision-3",
      },
    ));
    expect(parsed).toMatchObject({
      status: "repair_required",
      changed: true,
      item: { pluginId: "plugin-1", resolvedRevision: "revision-3" },
      outcomes: [{ componentKey: "mcp-1:docs", serverName: "docs" }],
      mutations: { installationRecordChanged: true, engineSynchronized: false },
      repair: { operation: "remove", cause: "modified" },
      resolvedRevision: "revision-3",
    });
  });
});
