import { describe, expect, test } from "bun:test";

import type { DenOrgPluginResolved } from "../src/app/lib/den-types";
import type {
  JuggleWorkHostMarketplaceEnvironment,
  JuggleWorkHostMarketplaceIdentityScope,
  JuggleWorkHostMarketplaceInstallation,
  JuggleWorkHostMarketplaceMigrationCommitInput,
  JuggleWorkHostMarketplaceMigrationPlan,
  JuggleWorkHostMarketplaceMigrationResult,
  JuggleWorkHostMarketplaceMutationInput,
  JuggleWorkHostMarketplaceMutationResult,
  JuggleWorkHostMarketplacePackage,
  JuggleWorkHostMarketplaceRegistryList,
  JuggleWorkServerCapabilities,
} from "../src/app/lib/jugglework-server";
import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import {
  HostMarketplacePluginsController,
  HostMarketplaceMigrationRequiredError,
  hostMarketplacePluginsKey,
  normalizeHostMarketplaceIdentityScope,
  supportsHostMarketplaceWorkspace,
} from "../src/react-app/domains/settings/state/host-marketplace-plugins";

const origin = "https://work.example.test";

function scope(organizationId: string): JuggleWorkHostMarketplaceIdentityScope {
  return { controlPlaneOrigin: origin, userId: "user-1", organizationId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function capabilities(hostMarketplacePlugins: { read: boolean; write: boolean } | null = { read: true, write: true }): JuggleWorkServerCapabilities {
  return {
    skills: { read: true, write: true, source: "jugglework" },
    plugins: { read: true, write: true },
    mcp: { read: true, write: true },
    commands: { read: true, write: true },
    config: { read: true, write: true },
    ...(hostMarketplacePlugins ? { hostMarketplacePlugins } : {}),
  };
}

function resolvedPlugin(input: {
  cloudOnly?: boolean;
  revision?: string;
  pluginId?: string;
  skillDelivery?: "cloud" | "desktop";
} = {}): DenOrgPluginResolved {
  const cloudOnly = input.cloudOnly === true;
  const pluginId = input.pluginId ?? (cloudOnly ? "cloud-plugin" : "plugin-1");
  return {
    plugin: {
      id: pluginId,
      name: cloudOnly ? "Cloud plugin" : "Host plugin",
      description: "A package",
      status: "active",
      memberCount: 1,
      updatedAt: input.revision ?? "revision-1",
      componentCounts: cloudOnly ? { mcp: 1 } : { skill: 1, mcp: 1 },
      extension: {
        id: pluginId,
        name: cloudOnly ? "Cloud plugin" : "Host plugin",
        description: "A package",
        sourceFormat: "claude-plugin",
        manifest: null,
      },
      cloudReadiness: {
        state: "ready",
        hasInstructional: !cloudOnly,
        connections: [],
        components: [{
          configObjectId: "mcp-1",
          serverName: "service",
          delivery: cloudOnly ? "cloud" : "desktop",
          ...(cloudOnly ? { url: "https://service.example.test/mcp" } : { command: ["node", "server.js"] }),
        }],
      },
    },
    memberships: [
      ...(!cloudOnly ? [{
        id: "membership-skill",
        pluginId,
        configObjectId: "skill-1",
        ...(input.skillDelivery ? { delivery: input.skillDelivery } : {}),
        configObject: {
          id: "skill-1",
          objectType: "skill" as const,
          title: "Skill",
          description: null,
          currentFileName: "SKILL.md",
          currentFileExtension: "md",
          currentRelativePath: ".opencode/skills/example/SKILL.md",
          status: "active",
          updatedAt: null,
          latestVersion: {
            id: "skill-version-1",
            rawSourceText: "# Skill",
            normalizedPayloadJson: null,
            sourceRevisionRef: null,
            createdAt: null,
          },
        },
      }] : []),
      {
        id: "membership-mcp",
        pluginId,
        configObjectId: "mcp-1",
        configObject: {
          id: "mcp-1",
          objectType: "mcp",
          title: "Service",
          description: null,
          currentFileName: "mcp.json",
          currentFileExtension: "json",
          currentRelativePath: ".opencode/mcp.json",
          status: "active",
          updatedAt: null,
          latestVersion: {
            id: "mcp-version-1",
            rawSourceText: null,
            normalizedPayloadJson: cloudOnly
              ? { mcp: { service: { url: "https://service.example.test/mcp" } } }
              : { mcp: { service: { command: ["node", "server.js"] } } },
            sourceRevisionRef: null,
            createdAt: null,
          },
        },
      },
    ],
  };
}

type ScopeMutation = JuggleWorkHostMarketplaceMutationInput & { active: boolean };
type PutMutation = JuggleWorkHostMarketplaceMutationInput & { package: JuggleWorkHostMarketplacePackage };

function migrationPlan(packageInput: JuggleWorkHostMarketplacePackage): JuggleWorkHostMarketplaceMigrationPlan {
  return {
    pluginId: packageInput.pluginId,
    packageDigest: `digest:${packageInput.revision}`,
    registryRevision: 1,
    workspaces: [
      { workspaceId: "ws-a", label: "Alpha", path: "/alpha", recordDigest: "record-a", resources: [{ kind: "file", target: ".opencode/a", digest: "a" }], blockers: [], migratable: true },
      { workspaceId: "ws-b", label: "Beta", path: "/beta", recordDigest: "record-b", resources: [{ kind: "mcp", target: "service", digest: "b" }], blockers: [], migratable: true },
    ],
    blockers: [],
    migratable: true,
    fingerprint: "fingerprint-1",
    migrationToken: "token-1",
  };
}

class FakeHostMarketplaceClient {
  readonly baseUrl = "http://127.0.0.1:7777/";
  readonly environment: JuggleWorkHostMarketplaceEnvironment = {
    schemaVersion: 1,
    environmentId: "host-1",
    managed: true,
    readOnly: false,
    capability: { read: true, write: true },
  };
  advertisedCapabilities = capabilities();
  registryRevision = 0;
  activeOrganizationId: string | null = null;
  inventories = new Map<string, JuggleWorkHostMarketplaceInstallation[]>();
  events: string[] = [];
  scopeMutations: ScopeMutation[] = [];
  putMutations: PutMutation[] = [];
  planMutations: Array<{ scope: JuggleWorkHostMarketplaceIdentityScope; package: JuggleWorkHostMarketplacePackage }> = [];
  migrationMutations: JuggleWorkHostMarketplaceMigrationCommitInput[] = [];
  deleteMutations: Array<{ pluginId: string; input: JuggleWorkHostMarketplaceMutationInput }> = [];
  listOverride: ((requestedScope: JuggleWorkHostMarketplaceIdentityScope) => Promise<JuggleWorkHostMarketplaceRegistryList>) | null = null;
  scopeMutationGate: Promise<void> | null = null;
  scopeMutationStarted: ((input: ScopeMutation) => void) | null = null;
  scopeMutationError: Error | null = null;
  putError: Error | null = null;
  migrationError: Error | null = null;
  environmentError: Error | null = null;

  capabilities = async () => this.advertisedCapabilities;
  getHostMarketplaceEnvironment = async () => {
    if (this.environmentError) throw this.environmentError;
    return this.environment;
  };

  listHostMarketplacePlugins = async (requestedScope: JuggleWorkHostMarketplaceIdentityScope) => {
    this.events.push(`list:${requestedScope.organizationId}`);
    if (this.listOverride) return this.listOverride(requestedScope);
    return this.registry(requestedScope);
  };

  setHostMarketplaceScope = async (input: ScopeMutation): Promise<JuggleWorkHostMarketplaceMutationResult> => {
    this.events.push(`${input.active ? "activate" : "deactivate"}:${input.scope.organizationId}`);
    this.scopeMutations.push(input);
    this.scopeMutationStarted?.(input);
    const gate = this.scopeMutationGate;
    if (gate) await gate;
    this.assertRevision(input.expectedRevision);
    if (this.scopeMutationError) throw this.scopeMutationError;
    const changed = input.active
      ? this.activeOrganizationId !== input.scope.organizationId
      : this.activeOrganizationId === input.scope.organizationId;
    if (changed) {
      this.activeOrganizationId = input.active ? input.scope.organizationId : null;
      this.registryRevision += 1;
    }
    return this.result(input.active ? "activate" : "deactivate", changed, null);
  };

  putHostMarketplacePlugin = async (input: PutMutation): Promise<JuggleWorkHostMarketplaceMutationResult> => {
    this.events.push(`put:${input.package.pluginId}`);
    this.putMutations.push(input);
    this.assertRevision(input.expectedRevision);
    if (this.putError) throw this.putError;
    const inventory = this.inventories.get(input.scope.organizationId) ?? [];
    const previous = inventory.find((entry) => entry.pluginId === input.package.pluginId);
    if (input.package.components.every((component) => component.delivery === "cloud")) {
      const changed = Boolean(previous);
      if (changed) {
        this.inventories.set(input.scope.organizationId, inventory.filter((entry) => entry.pluginId !== input.package.pluginId));
        this.registryRevision += 1;
      }
      return this.result("cloud_only", changed, null);
    }
    const changed = !previous || previous.packageRevision !== input.package.revision;
    const installation = this.installation(input.package, previous);
    this.inventories.set(input.scope.organizationId, [
      ...inventory.filter((entry) => entry.pluginId !== input.package.pluginId),
      installation,
    ]);
    if (changed) this.registryRevision += 1;
    return this.result(previous ? "update" : "install", changed, installation);
  };

  planHostMarketplacePluginMigration = async (input: { scope: JuggleWorkHostMarketplaceIdentityScope; package: JuggleWorkHostMarketplacePackage }) => {
    this.events.push(`plan:${input.package.pluginId}`);
    this.planMutations.push(input);
    return migrationPlan(input.package);
  };

  migrateHostMarketplacePluginWorkspaceCopies = async (input: JuggleWorkHostMarketplaceMigrationCommitInput): Promise<JuggleWorkHostMarketplaceMigrationResult> => {
    this.events.push(`migrate:${input.package.pluginId}`);
    this.migrationMutations.push(input);
    if (this.migrationError) throw this.migrationError;
    const installation = this.installation(input.package);
    this.inventories.set(input.scope.organizationId, [installation]);
    this.registryRevision += 1;
    return {
      operation: "migrate_workspace_copies",
      changed: true,
      migratedWorkspaces: input.workspaceCopies.map((copy) => copy.workspaceId),
      host: this.result("install", true, installation),
    };
  };

  deleteHostMarketplacePlugin = async (
    pluginId: string,
    input: JuggleWorkHostMarketplaceMutationInput,
  ): Promise<JuggleWorkHostMarketplaceMutationResult> => {
    this.events.push(`delete:${pluginId}`);
    this.deleteMutations.push({ pluginId, input });
    this.assertRevision(input.expectedRevision);
    const inventory = this.inventories.get(input.scope.organizationId) ?? [];
    this.inventories.set(input.scope.organizationId, inventory.filter((entry) => entry.pluginId !== pluginId));
    this.registryRevision += 1;
    return this.result("remove", true, null);
  };

  registry(requestedScope: JuggleWorkHostMarketplaceIdentityScope): JuggleWorkHostMarketplaceRegistryList {
    return {
      schemaVersion: 1,
      registryRevision: this.registryRevision,
      scope: { ...requestedScope, environmentId: this.environment.environmentId },
      active: this.activeOrganizationId === requestedScope.organizationId,
      installations: [...(this.inventories.get(requestedScope.organizationId) ?? [])],
    };
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.registryRevision) {
      throw new Error(`expected revision ${this.registryRevision}, received ${expectedRevision}`);
    }
  }

  private result(
    operation: JuggleWorkHostMarketplaceMutationResult["operation"],
    changed: boolean,
    installation: JuggleWorkHostMarketplaceInstallation | null,
  ): JuggleWorkHostMarketplaceMutationResult {
    const active = this.activeOrganizationId ? scope(this.activeOrganizationId) : null;
    return {
      operation,
      changed,
      registryRevision: this.registryRevision,
      activeScope: active ? { ...active, environmentId: this.environment.environmentId } : null,
      installation,
      mcpOverlay: {},
    };
  }

  private installation(
    packageInput: JuggleWorkHostMarketplacePackage,
    previous?: JuggleWorkHostMarketplaceInstallation,
  ): JuggleWorkHostMarketplaceInstallation {
    return {
      pluginId: packageInput.pluginId,
      marketplaceId: packageInput.marketplaceId,
      name: packageInput.name,
      description: packageInput.description ?? null,
      packageRevision: packageInput.revision,
      packageDigest: `digest:${packageInput.revision}`,
      status: "installed",
      resources: packageInput.components
        .filter((component) => component.delivery === "desktop")
        .map((component) => ({
          kind: component.type === "mcp" ? "mcp" as const : "file" as const,
          componentId: component.id,
          target: component.id,
          digest: `digest:${component.versionId}`,
        })),
      installedAt: previous?.installedAt ?? 1,
      updatedAt: previous ? previous.updatedAt + 1 : 1,
    };
  }
}

function createController(client = new FakeHostMarketplaceClient()) {
  return { client, controller: new HostMarketplacePluginsController(client) };
}

describe("host Marketplace plugin state", () => {
  test("supports local and remote JuggleWork hosts but rejects direct remote OpenCode", () => {
    expect(supportsHostMarketplaceWorkspace({ workspaceType: "local", remoteType: null })).toBe(true);
    expect(supportsHostMarketplaceWorkspace({ workspaceType: "remote", remoteType: "jugglework" })).toBe(true);
    expect(supportsHostMarketplaceWorkspace({ workspaceType: "remote", remoteType: "opencode" })).toBe(false);
    expect(supportsHostMarketplaceWorkspace({ workspaceType: "remote", remoteType: null })).toBe(false);
    expect(supportsHostMarketplaceWorkspace(null)).toBe(false);
  });

  test("normalizes an identity-only key without a workspace dimension", () => {
    const normalized = normalizeHostMarketplaceIdentityScope({
      controlPlaneOrigin: "https://work.example.test/path/",
      userId: " user-1 ",
      organizationId: " org-1 ",
    });
    expect(normalized).toEqual(scope("org-1"));
    expect(hostMarketplacePluginsKey("http://127.0.0.1:7777/", normalized)).toBe(
      "http://127.0.0.1:7777\0https://work.example.test\0user-1\0org-1",
    );
  });

  test("ensures an inactive scope, then lists the activated registry", async () => {
    const { client, controller } = createController();
    const snapshot = await controller.ensureScope(scope("org-1"));

    expect(client.events).toEqual(["list:org-1", "activate:org-1", "list:org-1"]);
    expect(client.scopeMutations[0]).toMatchObject({ active: true, expectedRevision: 0, scope: scope("org-1") });
    expect(client.scopeMutations[0]?.idempotencyKey).toBeString();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.writable).toBe(true);
    expect(snapshot.registry).toMatchObject({ active: true, registryRevision: 1, installations: [] });
  });

  test("loads an inactive scope without activating it", async () => {
    const { client, controller } = createController();

    const snapshot = await controller.loadScope(scope("org-1"));

    expect(client.events).toEqual(["list:org-1"]);
    expect(client.scopeMutations).toHaveLength(0);
    expect(snapshot).toMatchObject({ status: "ready", writable: true, registry: { active: false } });
  });

  test("preserves discovery-only state when the host environment rejects the credential", async () => {
    const { client, controller } = createController();
    client.environmentError = new JuggleWorkServerError(401, "unauthorized", "Invalid host token");

    await expect(controller.loadScope(scope("org-1"))).rejects.toMatchObject({ status: 401 });

    expect(client.events).toEqual([]);
    expect(client.scopeMutations).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", writable: false, registry: null });
  });

  test("atomically switches organizations with one activation and no deactivation", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-a"));
    client.events.length = 0;
    const mutationCount = client.scopeMutations.length;

    await controller.ensureScope(scope("org-b"));

    expect(client.events).toEqual([
      "list:org-b",
      "activate:org-b",
      "list:org-b",
    ]);
    expect(client.scopeMutations.slice(mutationCount).map((input) => [input.scope.organizationId, input.active, input.expectedRevision]))
      .toEqual([["org-b", true, 1]]);
    expect(client.activeOrganizationId).toBe("org-b");
  });

  test("keeps the old projection active when atomic replacement fails", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-a"));
    client.events.length = 0;
    client.scopeMutationError = new Error("activation failed");

    await expect(controller.ensureScope(scope("org-b"))).rejects.toThrow("activation failed");

    expect(client.events).toEqual(["list:org-b", "activate:org-b"]);
    expect(client.scopeMutations.at(-1)).toMatchObject({ scope: scope("org-b"), active: true, expectedRevision: 1 });
    expect(client.scopeMutations.some((input) => input.active === false)).toBe(false);
    expect(client.activeOrganizationId).toBe("org-a");
    expect(client.registry(scope("org-a")).active).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", scope: scope("org-b") });
  });

  test("never activates a stale organization ensure after a newer switch", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-a"));
    const oldList = deferred<JuggleWorkHostMarketplaceRegistryList>();
    client.listOverride = async (requestedScope) => requestedScope.organizationId === "org-b"
      ? oldList.promise
      : client.registry(requestedScope);
    client.events.length = 0;

    const stale = controller.ensureScope(scope("org-b"));
    await Promise.resolve();
    await Promise.resolve();
    const current = controller.ensureScope(scope("org-c"));
    oldList.resolve(client.registry(scope("org-b")));
    await Promise.all([stale, current]);

    expect(client.events).not.toContain("activate:org-b");
    expect(client.events.filter((event) => event.startsWith("activate:")).at(-1)).toBe("activate:org-c");
    expect(client.events.some((event) => event.startsWith("deactivate:"))).toBe(false);
    expect(controller.getSnapshot().scope?.organizationId).toBe("org-c");
  });

  test("abandons an in-flight host probe before it can list or mutate", async () => {
    const { client, controller } = createController();
    const environment = deferred<JuggleWorkHostMarketplaceEnvironment>();
    client.getHostMarketplaceEnvironment = () => environment.promise;

    const loading = controller.loadScope(scope("org-1"));
    await Promise.resolve();
    controller.abandon();
    environment.resolve(client.environment);
    await loading;

    expect(client.events).toEqual([]);
    expect(client.scopeMutations).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ key: null, scope: null, status: "idle" });
  });

  test("processes the latest scope immediately after a superseded activation completes", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-a"));
    const activationGate = deferred<void>();
    const activationStarted = deferred<void>();
    client.scopeMutationGate = activationGate.promise;
    client.scopeMutationStarted = (input) => {
      if (input.scope.organizationId === "org-b") activationStarted.resolve();
    };
    client.events.length = 0;
    const mutationCount = client.scopeMutations.length;

    const stale = controller.ensureScope(scope("org-b"));
    await activationStarted.promise;
    const current = controller.ensureScope(scope("org-c"));
    client.scopeMutationGate = null;
    activationGate.resolve();
    await Promise.all([stale, current]);

    expect(client.events).toEqual([
      "list:org-b",
      "activate:org-b",
      "list:org-c",
      "activate:org-c",
      "list:org-c",
    ]);
    expect(client.scopeMutations.slice(mutationCount).map((input) => [input.scope.organizationId, input.active, input.expectedRevision]))
      .toEqual([["org-b", true, 1], ["org-c", true, 2]]);
    expect(client.activeOrganizationId).toBe("org-c");
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", scope: scope("org-c") });
  });

  test("clear hides signed-out state immediately and deactivates only the known active scope", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    const clearList = deferred<JuggleWorkHostMarketplaceRegistryList>();
    client.listOverride = async (requestedScope) => clearList.promise;

    const clearing = controller.clear();
    expect(controller.getSnapshot()).toMatchObject({
      key: null,
      scope: null,
      environment: null,
      registry: null,
      status: "idle",
      operation: null,
      error: null,
    });
    clearList.resolve(client.registry(scope("org-1")));
    await clearing;

    expect(client.scopeMutations.at(-1)).toMatchObject({ active: false, scope: scope("org-1"), expectedRevision: 1 });
    expect(client.activeOrganizationId).toBeNull();
    expect(controller.getSnapshot().status).toBe("idle");
    await controller.clear();
    expect(client.scopeMutations).toHaveLength(2);
  });

  test("materializes only the desktop MCP from a mixed cloud-skill package", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));

    const first = await controller.put("marketplace-1", resolvedPlugin(), { confirmExecutable: true });
    const second = await controller.put("marketplace-1", resolvedPlugin(), { confirmExecutable: true });

    expect(first?.packageRevision).toBe("revision-1");
    expect(second?.packageRevision).toBe("revision-1");
    expect(client.putMutations.map((input) => input.expectedRevision)).toEqual([1, 2]);
    expect(new Set(client.putMutations.map((input) => input.idempotencyKey)).size).toBe(2);
    expect(client.putMutations[0]?.package).toMatchObject({
      pluginId: "plugin-1",
      marketplaceId: "marketplace-1",
      revision: "revision-1",
      confirmedExecutableRevision: "revision-1",
    });
    expect(client.putMutations[0]?.package.components).toEqual([
      { id: "skill-1", type: "skill", title: "Skill", versionId: "skill-version-1", source: "# Skill", delivery: "cloud" },
      {
        id: "mcp-1",
        type: "mcp",
        title: "Service",
        versionId: "mcp-version-1",
        payload: { mcp: { service: { command: ["node", "server.js"] } } },
        delivery: "desktop",
      },
    ]);
    expect(first?.resources.map((resource) => resource.componentId)).toEqual(["mcp-1"]);
    expect(controller.getSnapshot().registry).toMatchObject({ registryRevision: 2, installations: [second] });
  });

  test("materializes an explicitly desktop-delivered skill", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));

    const installation = await controller.put("marketplace-1", resolvedPlugin({ skillDelivery: "desktop" }));

    expect(client.putMutations[0]?.package.components[0]).toMatchObject({
      id: "skill-1",
      type: "skill",
      delivery: "desktop",
    });
    expect(installation?.resources.map((resource) => resource.componentId).sort()).toEqual(["mcp-1", "skill-1"]);
  });

  test("plans a workspace-copy conflict with the exact resolved package and commits every planned copy", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    client.putError = new JuggleWorkServerError(409, "host_marketplace_workspace_copy_conflict", "workspace copies exist");

    let migration: HostMarketplaceMigrationRequiredError | null = null;
    try {
      await controller.put("marketplace-1", resolvedPlugin(), { confirmExecutable: true });
    } catch (error) {
      if (error instanceof HostMarketplaceMigrationRequiredError) migration = error;
      else throw error;
    }

    expect(migration).not.toBeNull();
    expect(client.planMutations).toHaveLength(1);
    expect(client.planMutations[0]).toEqual({
      scope: scope("org-1"),
      package: client.putMutations[0]!.package,
    });
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", operation: null, error: null });

    client.putError = null;
    const installation = await controller.migrate(migration!.request);

    expect(client.migrationMutations).toHaveLength(1);
    expect(client.migrationMutations[0]).toEqual({
      scope: scope("org-1"),
      package: client.putMutations[0]!.package,
      expectedRevision: 1,
      idempotencyKey: expect.any(String),
      workspaceCopies: [
        { workspaceId: "ws-a", recordDigest: "record-a" },
        { workspaceId: "ws-b", recordDigest: "record-b" },
      ],
      confirmed: true,
      fingerprint: "fingerprint-1",
      migrationToken: "token-1",
    });
    expect(client.events.slice(-2)).toEqual(["migrate:plugin-1", "list:org-1"]);
    expect(installation?.pluginId).toBe("plugin-1");
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", registry: { registryRevision: 2 } });
  });

  test("retains the authoritative pre-migration inventory when a migration plan becomes stale", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    const packageInput = resolvedPlugin();
    client.putError = new JuggleWorkServerError(409, "host_marketplace_workspace_copy_conflict", "workspace copies exist");
    let request: HostMarketplaceMigrationRequiredError["request"] | null = null;
    try {
      await controller.put("marketplace-1", packageInput);
    } catch (error) {
      if (error instanceof HostMarketplaceMigrationRequiredError) request = error.request;
      else throw error;
    }
    const before = controller.getSnapshot().registry;
    client.migrationError = new JuggleWorkServerError(409, "host_marketplace_migration_plan_stale", "stale");

    await expect(controller.migrate(request!)).rejects.toMatchObject({ code: "host_marketplace_migration_plan_stale" });

    expect(client.inventories.get("org-1") ?? []).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", registry: before });
    expect(client.events.at(-1)).toBe("migrate:plugin-1");
  });

  test("deletes with the latest revision and refreshes the remaining inventory", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    await controller.put("marketplace-1", resolvedPlugin());

    await controller.delete("plugin-1");

    expect(client.deleteMutations).toHaveLength(1);
    expect(client.deleteMutations[0]).toMatchObject({
      pluginId: "plugin-1",
      input: { scope: scope("org-1"), expectedRevision: 2 },
    });
    expect(client.deleteMutations[0]?.input.idempotencyKey).toBeString();
    expect(controller.getSnapshot().registry).toMatchObject({ registryRevision: 3, installations: [] });
  });

  test("treats an absent advertised capability as discovery-only", async () => {
    const { client, controller } = createController();
    client.advertisedCapabilities = capabilities(null);

    const snapshot = await controller.ensureScope(scope("org-1"));

    expect(snapshot.status).toBe("ready");
    expect(snapshot.writable).toBe(false);
    expect(snapshot.registry?.active).toBe(false);
    expect(client.scopeMutations).toHaveLength(0);
    await expect(controller.put("marketplace-1", resolvedPlugin())).rejects.toThrow(
      "does not support changing host Marketplace plugins",
    );
    expect(controller.getSnapshot().registry).toEqual(client.registry(scope("org-1")));
  });

  test("enforces explicit read/write capability and retains same-scope known inventory on errors", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    await controller.put("marketplace-1", resolvedPlugin());
    const known = controller.getSnapshot().registry;

    client.advertisedCapabilities = capabilities({ read: true, write: false });
    await expect(controller.put("marketplace-1", resolvedPlugin({ revision: "revision-2" }))).rejects.toThrow(
      "does not support changing host Marketplace plugins",
    );
    expect(controller.getSnapshot()).toMatchObject({ status: "error", registry: known, writable: false });

    client.advertisedCapabilities = capabilities();
    client.putError = new Error("write failed");
    await expect(controller.put("marketplace-1", resolvedPlugin({ revision: "revision-2" }))).rejects.toThrow("write failed");
    expect(controller.getSnapshot()).toMatchObject({ status: "error", registry: known });

    client.advertisedCapabilities = capabilities({ read: false, write: true });
    await expect(controller.refresh()).rejects.toThrow("does not support reading host Marketplace plugins");
    expect(controller.getSnapshot()).toMatchObject({ status: "error", registry: known });
  });

  test("returns null and leaves inventory unchanged for a pure-cloud package", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    const beforeRevision = client.registryRevision;

    const installation = await controller.put("marketplace-cloud", resolvedPlugin({ cloudOnly: true }));

    expect(installation).toBeNull();
    expect(client.putMutations[0]?.package.components).toEqual([{
      id: "mcp-1",
      type: "mcp",
      title: "Service",
      versionId: "mcp-version-1",
      payload: { mcp: { service: { url: "https://service.example.test/mcp" } } },
      delivery: "cloud",
    }]);
    expect(client.registryRevision).toBe(beforeRevision);
    expect(controller.getSnapshot().registry).toMatchObject({ installations: [], registryRevision: beforeRevision });
  });

  test("removes an installed host projection when an update becomes pure cloud", async () => {
    const { client, controller } = createController();
    await controller.ensureScope(scope("org-1"));
    await controller.put("marketplace-1", resolvedPlugin({ skillDelivery: "desktop" }));
    const beforeRevision = client.registryRevision;

    const installation = await controller.put("marketplace-1", resolvedPlugin({
      cloudOnly: true,
      pluginId: "plugin-1",
      revision: "cloud-revision",
    }));

    expect(installation).toBeNull();
    expect(client.registryRevision).toBe(beforeRevision + 1);
    expect(controller.getSnapshot().registry).toMatchObject({
      registryRevision: beforeRevision + 1,
      installations: [],
    });
  });
});
