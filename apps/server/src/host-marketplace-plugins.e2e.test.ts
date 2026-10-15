import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type ServerLogger } from "./server.js";
import type { ServeResult } from "./serve-node.js";
import type { AuditEntry, ServerConfig } from "./types.js";

const roots: string[] = [];
const servers: ServeResult[] = [];
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
});

async function fixture(options: {
  managed?: boolean;
  readOnly?: boolean;
  auditWriter?: (workspaceRoot: string, entry: AuditEntry) => Promise<void>;
  logger?: ServerLogger;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-host-marketplace-routes-"));
  roots.push(root);
  process.env.OPENCODE_CONFIG_DIR = join(root, "opencode-global");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "marketplace-client",
    hostToken: "marketplace-host",
    approval: { mode: "auto", timeoutMs: 100 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: options.readOnly ?? false,
    managedRuntime: options.managed ?? true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config, { auditWriter: options.auditWriter, logger: options.logger });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, config };
}

const scope = {
  controlPlaneOrigin: "https://work.example.test/path-is-normalized",
  userId: "user-a",
  organizationId: "org-a",
};

function clientHeaders(config: ServerConfig): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
}

function hostHeaders(config: ServerConfig): Record<string, string> {
  return { "x-jugglework-host-token": config.hostToken, "content-type": "application/json" };
}

function hostPackage(pluginId: string) {
  return {
    pluginId,
    marketplaceId: "marketplace",
    name: "Planning Suite",
    revision: "v1",
    components: [{ id: "skill", type: "skill", title: "Planner", versionId: "v1", source: "# Planner", delivery: "desktop" }],
  };
}

async function activateHostScope(base: string, config: ServerConfig): Promise<void> {
  const response = await fetch(`${base}/host/marketplace-plugins/scope`, {
    method: "PUT",
    headers: hostHeaders(config),
    body: JSON.stringify({ scope, active: true, expectedRevision: 0, idempotencyKey: "activate" }),
  });
  expect(response.status).toBe(200);
}

async function installWorkspacePlugin(base: string, config: ServerConfig, pluginId: string, cloudOnly: boolean): Promise<Response> {
  return fetch(`${base}/workspace/ws_1/cloud-plugins`, {
    method: "POST",
    headers: clientHeaders(config),
    body: JSON.stringify({
      marketplaceId: "marketplace",
      resolved: {
        plugin: { id: pluginId, name: "Planning Suite", description: null, updatedAt: "v1" },
        memberships: [{
          configObjectId: cloudOnly ? "cloud-mcp" : "skill",
          configObject: cloudOnly
            ? {
                id: "cloud-mcp",
                objectType: "mcp",
                title: "Cloud Search",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: "v1",
                latestVersion: { id: "cloud-v1", rawSourceText: null, normalizedPayloadJson: { mcp: { search: { url: "https://example.test/mcp" } } } },
              }
            : {
                id: "skill",
                objectType: "skill",
                title: "Planner",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: "v1",
                latestVersion: { id: "skill-v1", rawSourceText: "# Planner", normalizedPayloadJson: null },
              },
        }],
      },
    }),
  });
}

async function installHostPlugin(base: string, config: ServerConfig, pluginId: string): Promise<Response> {
  return fetch(`${base}/host/marketplace-plugins/${pluginId}`, {
    method: "PUT",
    headers: hostHeaders(config),
    body: JSON.stringify({
      scope,
      expectedRevision: 1,
      idempotencyKey: `install-${pluginId}`,
      package: hostPackage(pluginId),
    }),
  });
}

describe("host Marketplace plugin routes", () => {
  test("advertises a stable environment to clients and gates write capability", async () => {
    const { base, config } = await fixture();
    const unauthenticated = await fetch(`${base}/host/marketplace-plugins/environment`);
    expect(unauthenticated.status).toBe(401);

    const client = await fetch(`${base}/host/marketplace-plugins/environment`, { headers: clientHeaders(config) });
    expect(client.status).toBe(401);
    const first = await fetch(`${base}/host/marketplace-plugins/environment`, { headers: hostHeaders(config) });
    const second = await fetch(`${base}/host/marketplace-plugins/environment`, { headers: hostHeaders(config) });
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await (await fetch(`${base}/capabilities`, { headers: clientHeaders(config) })).json()).toMatchObject({
      hostMarketplacePlugins: { read: true, write: true },
    });

    const unsupported = await fixture({ managed: false });
    const environment = await (await fetch(`${unsupported.base}/host/marketplace-plugins/environment`, {
      headers: hostHeaders(unsupported.config),
    })).json();
    expect(environment).toMatchObject({ managed: false, capability: { read: true, write: false } });
  });

  test("requires host or owner auth for every host Marketplace endpoint", async () => {
    const { base, config } = await fixture();
    const mutation = { scope, active: true, expectedRevision: 0, idempotencyKey: "activate-a" };
    const collaborator = await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: clientHeaders(config),
      body: JSON.stringify(mutation),
    });
    expect(collaborator.status).toBe(401);

    const activated = await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify(mutation),
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({ operation: "activate", registryRevision: 1 });

    const query = new URLSearchParams(scope);
    const unauthenticatedRead = await fetch(`${base}/host/marketplace-plugins?${query}`);
    expect(unauthenticatedRead.status).toBe(401);
    const clientRead = await fetch(`${base}/host/marketplace-plugins?${query}`, { headers: clientHeaders(config) });
    expect(clientRead.status).toBe(401);
    const listed = await fetch(`${base}/host/marketplace-plugins?${query}`, { headers: hostHeaders(config) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ active: true, registryRevision: 1, installations: [] });
  });

  test("rejects unknown fields and a package whose plugin id differs from the route", async () => {
    const { base, config } = await fixture();
    const activate = await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, active: true, expectedRevision: 0, idempotencyKey: "activate" }),
    });
    expect(activate.status).toBe(200);

    const mismatch = await fetch(`${base}/host/marketplace-plugins/route-id`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({
        scope,
        expectedRevision: 1,
        idempotencyKey: "install",
        package: {
          pluginId: "body-id",
          marketplaceId: "marketplace",
          name: "Plugin",
          revision: "v1",
          components: [{ id: "skill", type: "skill", title: "Skill", versionId: "v1", source: "# Skill", delivery: "desktop" }],
        },
      }),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "host_marketplace_plugin_id_mismatch" });

    const unknown = await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, active: false, expectedRevision: 1, idempotencyKey: "deactivate", extra: true }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "invalid_host_marketplace_payload" });

    const missingDelivery = await fetch(`${base}/host/marketplace-plugins/route-id`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({
        scope,
        expectedRevision: 1,
        idempotencyKey: "missing-delivery",
        package: {
          pluginId: "route-id",
          marketplaceId: "marketplace",
          name: "Plugin",
          revision: "v1",
          components: [{ id: "skill", type: "skill", title: "Skill", versionId: "v1", source: "# Skill" }],
        },
      }),
    });
    expect(missingDelivery.status).toBe(400);
    expect(await missingDelivery.json()).toMatchObject({ code: "invalid_host_marketplace_payload" });
  });

  test("installs, lists, and removes a package through the root endpoint", async () => {
    const { base, config } = await fixture();
    const activate = await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, active: true, expectedRevision: 0, idempotencyKey: "activate" }),
    });
    expect(activate.status).toBe(200);

    const packageInput = {
      pluginId: "planning-suite",
      marketplaceId: "marketplace",
      name: "Planning Suite",
      revision: "v1",
      components: [{ id: "skill", type: "skill", title: "Planner", versionId: "v1", source: "# Planner", delivery: "desktop" }],
    };
    const installed = await fetch(`${base}/host/marketplace-plugins/planning-suite`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, expectedRevision: 1, idempotencyKey: "install", package: packageInput }),
    });
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({
      operation: "install",
      changed: true,
      registryRevision: 2,
      installation: { pluginId: "planning-suite", packageRevision: "v1" },
    });

    const replayed = await fetch(`${base}/host/marketplace-plugins/planning-suite`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, expectedRevision: 1, idempotencyKey: "install", package: packageInput }),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ operation: "install", registryRevision: 2 });

    const query = new URLSearchParams(scope);
    const listed = await fetch(`${base}/host/marketplace-plugins?${query}`, { headers: hostHeaders(config) });
    expect(await listed.json()).toMatchObject({
      active: true,
      installations: [{ pluginId: "planning-suite" }],
    });

    const removed = await fetch(`${base}/host/marketplace-plugins/planning-suite`, {
      method: "DELETE",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, expectedRevision: 2, idempotencyKey: "remove" }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ operation: "remove", registryRevision: 3, installation: null });
  });

  test("annotates host and workspace plugin skill provenance without hiding runtime inventory", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const hostInstall = await installHostPlugin(base, config, "host-skill-plugin");
    expect(hostInstall.status).toBe(200);
    const installed = await hostInstall.json() as { installation: { resources: Array<{ kind: string; target: string }> } };
    const hostTarget = installed.installation.resources.find((resource) => resource.kind === "file")!.target;
    const hostSkillName = hostTarget.split("/").at(-2)!;
    await writeFile(join(process.env.OPENCODE_CONFIG_DIR!, hostTarget), `---\nname: ${hostSkillName}\ndescription: Host plugin\n---\nHost plugin\n`);
    expect((await installWorkspacePlugin(base, config, "workspace-skill-plugin", false)).status).toBe(200);

    const globalStandalone = join(process.env.OPENCODE_CONFIG_DIR!, "skills", "planner", "SKILL.md");
    await mkdir(join(globalStandalone, ".."), { recursive: true });
    await writeFile(globalStandalone, "---\nname: planner\ndescription: Standalone\n---\nStandalone\n");

    const response = await fetch(`${base}/workspace/ws_1/skills?includeGlobal=true`, {
      headers: clientHeaders(config),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ name: string; path: string; ownerPluginId?: string; sourceKind: string }> };

    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerPluginId: "host-skill-plugin", sourceKind: "plugin" }),
      expect.objectContaining({ ownerPluginId: "workspace-skill-plugin", sourceKind: "plugin" }),
      expect.objectContaining({ path: globalStandalone, sourceKind: "standalone" }),
    ]));
    expect(body.items.filter((item) => item.name === "planner")).toHaveLength(2);
  });

  test("PUT dematerializes an installed package that becomes pure cloud", async () => {
    const { base, config } = await fixture();
    await fetch(`${base}/host/marketplace-plugins/scope`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, active: true, expectedRevision: 0, idempotencyKey: "activate" }),
    });
    const desktopPackage = {
      pluginId: "transitioning-plugin",
      marketplaceId: "marketplace",
      name: "Transitioning Plugin",
      revision: "desktop-v1",
      components: [{ id: "skill", type: "skill", title: "Planner", versionId: "v1", source: "# Planner", delivery: "desktop" }],
    };
    const installed = await fetch(`${base}/host/marketplace-plugins/transitioning-plugin`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, expectedRevision: 1, idempotencyKey: "install", package: desktopPackage }),
    });
    expect(installed.status).toBe(200);

    const cloudPackage = {
      ...desktopPackage,
      revision: "cloud-v2",
      components: [{
        id: "cloud",
        type: "mcp",
        title: "Cloud",
        versionId: "v2",
        payload: { mcp: { cloud: { url: "https://example.test/mcp" } } },
        delivery: "cloud",
      }],
    };
    const dematerialized = await fetch(`${base}/host/marketplace-plugins/transitioning-plugin`, {
      method: "PUT",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, expectedRevision: 2, idempotencyKey: "cloud-only", package: cloudPackage }),
    });

    expect(dematerialized.status).toBe(200);
    expect(await dematerialized.json()).toMatchObject({
      operation: "cloud_only",
      changed: true,
      registryRevision: 3,
      installation: null,
      mcpOverlay: {},
    });
    const query = new URLSearchParams(scope);
    const listed = await fetch(`${base}/host/marketplace-plugins?${query}`, { headers: hostHeaders(config) });
    expect(await listed.json()).toMatchObject({ active: true, registryRevision: 3, installations: [] });
  });

  test("allows a host install when the workspace record is cloud-only", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const workspace = await installWorkspacePlugin(base, config, "cloud-ready-plugin", true);
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      item: {
        pluginId: "cloud-ready-plugin",
        files: [expect.objectContaining({ delivery: "cloud", outcome: "available_cloud" })],
      },
    });

    const host = await installHostPlugin(base, config, "cloud-ready-plugin");
    expect(host.status).toBe(200);
    expect(await host.json()).toMatchObject({ operation: "install", installation: { pluginId: "cloud-ready-plugin" } });
  });

  test("allows a cloud-only workspace record when the host owns local materialization", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const host = await installHostPlugin(base, config, "host-owned-cloud-ready-plugin");
    expect(host.status).toBe(200);

    const workspace = await installWorkspacePlugin(base, config, "host-owned-cloud-ready-plugin", true);
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      item: {
        pluginId: "host-owned-cloud-ready-plugin",
        files: [expect.objectContaining({ delivery: "cloud", outcome: "available_cloud" })],
      },
    });
  });

  test("blocks a host install when the workspace record owns local materialization", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const workspace = await installWorkspacePlugin(base, config, "workspace-owned-plugin", false);
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      item: {
        pluginId: "workspace-owned-plugin",
        files: [expect.objectContaining({ delivery: "local_file", outcome: "installed_local" })],
      },
    });

    const host = await installHostPlugin(base, config, "workspace-owned-plugin");
    expect(host.status).toBe(409);
    expect(await host.json()).toMatchObject({
      code: "host_marketplace_workspace_copy_conflict",
      details: { workspaces: ["ws_1"] },
    });
  });

  test("plans and explicitly migrates a workspace copy to host ownership", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const pluginId = "explicit-migration";
    expect((await installWorkspacePlugin(base, config, pluginId, false)).status).toBe(200);
    const packageInput = hostPackage(pluginId);

    const unauthenticated = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migration-plan`, {
      method: "POST",
      headers: clientHeaders(config),
      body: JSON.stringify({ scope, package: packageInput }),
    });
    expect(unauthenticated.status).toBe(401);

    const planned = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migration-plan`, {
      method: "POST",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, package: packageInput }),
    });
    expect(planned.status).toBe(200);
    const plan = await planned.json() as {
      registryRevision: number;
      fingerprint: string;
      migrationToken: string;
      migratable: boolean;
      workspaces: Array<{ workspaceId: string; label: string; path: string; recordDigest: string; resources: unknown[]; blockers: unknown[] }>;
    };
    expect(plan).toMatchObject({
      registryRevision: 1,
      migratable: true,
      workspaces: [{ workspaceId: "ws_1", label: "Workspace", path: expect.any(String), blockers: [], resources: expect.any(Array) }],
    });

    const migrated = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migrate-workspace-copies`, {
      method: "POST",
      headers: hostHeaders(config),
      body: JSON.stringify({
        scope,
        package: packageInput,
        expectedRevision: plan.registryRevision,
        idempotencyKey: "explicit-migration",
        workspaceCopies: plan.workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
        confirmed: true,
        fingerprint: plan.fingerprint,
        migrationToken: plan.migrationToken,
      }),
    });
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({
      operation: "migrate_workspace_copies",
      migratedWorkspaces: ["ws_1"],
      host: { installation: { pluginId } },
    });

    const workspaceState = await (await fetch(`${base}/workspace/ws_1/cloud-plugins`, { headers: clientHeaders(config) })).json() as { plugins: Record<string, unknown> };
    expect(workspaceState.plugins[pluginId]).toBeUndefined();
    const hostState = await (await fetch(`${base}/host/marketplace-plugins?${new URLSearchParams(scope)}`, { headers: hostHeaders(config) })).json() as { installations: Array<{ pluginId: string }> };
    expect(hostState.installations.map((installation) => installation.pluginId)).toContain(pluginId);
  });

  test("keeps migration success and idempotency stable when audit append fails", async () => {
    const logs: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
    const { base, config } = await fixture({
      auditWriter: async () => { throw new Error("secret plugin source"); },
      logger: { log: (level, message, attributes) => logs.push({ level, message, attributes }) },
    });
    await activateHostScope(base, config);
    const pluginId = "audit-failure-migration";
    expect((await installWorkspacePlugin(base, config, pluginId, false)).status).toBe(200);
    const packageInput = hostPackage(pluginId);
    const planResponse = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migration-plan`, {
      method: "POST",
      headers: hostHeaders(config),
      body: JSON.stringify({ scope, package: packageInput }),
    });
    const plan = await planResponse.json() as {
      registryRevision: number;
      fingerprint: string;
      migrationToken: string;
      workspaces: Array<{ workspaceId: string; recordDigest: string }>;
    };
    const request = {
      scope,
      package: packageInput,
      expectedRevision: plan.registryRevision,
      idempotencyKey: "audit-failure-migration",
      workspaceCopies: plan.workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
      confirmed: true,
      fingerprint: plan.fingerprint,
      migrationToken: plan.migrationToken,
    };

    const migrated = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migrate-workspace-copies`, {
      method: "POST",
      headers: hostHeaders(config),
      body: JSON.stringify(request),
    });
    expect(migrated.status).toBe(200);
    const first = await migrated.json();
    expect(first).toMatchObject({
      operation: "migrate_workspace_copies",
      migratedWorkspaces: ["ws_1"],
      host: { registryRevision: 2, installation: { pluginId } },
      auditWarnings: ["ws_1"],
    });

    const replayed = await fetch(`${base}/host/marketplace-plugins/${pluginId}/migrate-workspace-copies`, {
      method: "POST",
      headers: hostHeaders(config),
      body: JSON.stringify(request),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(first);
    const auditWarnings = logs.filter((entry) => entry.message === "host-marketplace-migration:audit-append-failed");
    expect(auditWarnings).toEqual([
      { level: "warn", message: "host-marketplace-migration:audit-append-failed", attributes: { workspaceId: "ws_1" } },
      { level: "warn", message: "host-marketplace-migration:audit-append-failed", attributes: { workspaceId: "ws_1" } },
    ]);
    expect(JSON.stringify(auditWarnings)).not.toContain("secret plugin source");
    expect(JSON.stringify(auditWarnings)).not.toContain(pluginId);
    expect(JSON.stringify(auditWarnings)).not.toContain("# Planner");
  });

  test("serializes concurrent workspace and host claims for the same plugin", async () => {
    const { base, config } = await fixture();
    await activateHostScope(base, config);
    const pluginId = "concurrent-plugin";
    const [workspace, host] = await Promise.all([
      installWorkspacePlugin(base, config, pluginId, false),
      installHostPlugin(base, config, pluginId),
    ]);

    expect([workspace.status, host.status].sort()).toEqual([200, 409]);
    const rejected = workspace.status === 409 ? workspace : host;
    expect(await rejected.json()).toMatchObject({
      code: workspace.status === 409
        ? "cloud_plugin_host_copy_conflict"
        : "host_marketplace_workspace_copy_conflict",
    });

    const workspaceState = await (await fetch(`${base}/workspace/ws_1/cloud-plugins`, {
      headers: clientHeaders(config),
    })).json() as { plugins: Record<string, unknown> };
    const hostState = await (await fetch(`${base}/host/marketplace-plugins?${new URLSearchParams(scope)}`, {
      headers: hostHeaders(config),
    })).json() as { installations: Array<{ pluginId: string }> };
    expect(Boolean(workspaceState.plugins[pluginId])).not.toBe(
      hostState.installations.some((installation) => installation.pluginId === pluginId),
    );
  });
});
