import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createHostMarketplacePluginRegistry,
  HostMarketplaceFailStopError,
  type HostMarketplaceMutationContext,
  type HostMarketplacePackage,
  type HostMarketplacePluginRegistry,
  type HostMarketplaceScope,
} from "./host-marketplace-plugins.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(options: Parameters<typeof createHostMarketplacePluginRegistry>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-host-marketplace-"));
  roots.push(root);
  const globalOpenCodeDirectory = join(root, "opencode");
  const registry = await createHostMarketplacePluginRegistry({
    databasePath: join(root, "runtime.sqlite"),
    storageDirectory: join(root, "runtime"),
    globalOpenCodeDirectory,
    ...options,
  });
  return { root, globalOpenCodeDirectory, registry };
}

const scopeA: HostMarketplaceScope = {
  environmentId: "desktop-a",
  controlPlaneOrigin: "https://work.example.test",
  userId: "user-a",
  organizationId: "org-a",
};

const scopeB: HostMarketplaceScope = {
  environmentId: "desktop-a",
  controlPlaneOrigin: "https://work.example.test",
  userId: "user-a",
  organizationId: "org-b",
};

function context(scope: HostMarketplaceScope, expectedRevision: number, idempotencyKey: string): HostMarketplaceMutationContext {
  return { scope, expectedRevision, idempotencyKey, authority: "owner" };
}

function packageRevision(revision: "v1" | "v2" = "v1"): HostMarketplacePackage {
  return {
    pluginId: "planning-suite",
    marketplaceId: "team-marketplace",
    name: "Planning Suite",
    description: "Host-level planning tools",
    revision,
    confirmedExecutableRevision: revision,
    components: [
      { id: "skill", type: "skill", title: "Planner", versionId: `skill-${revision}`, source: `# Planner ${revision}`, delivery: "desktop" },
      { id: "agent", type: "agent", title: "Planner", versionId: `agent-${revision}`, source: `Plan ${revision}`, delivery: "desktop" },
      { id: "command", type: "command", title: "Planner", versionId: `command-${revision}`, source: `Run ${revision}`, delivery: "desktop" },
      { id: "context", type: "context", title: "Planner", versionId: `context-${revision}`, source: `Context ${revision}`, delivery: "desktop" },
      { id: "hook", type: "hook", title: "Planner", versionId: `hook-${revision}`, source: `{\"revision\":\"${revision}\"}`, delivery: "desktop" },
      { id: "tool", type: "tool", title: "Planner", versionId: `tool-${revision}`, source: `export default ${JSON.stringify(revision)}`, delivery: "desktop" },
      {
        id: "mcp",
        type: "mcp",
        title: "Search",
        versionId: `mcp-${revision}`,
        delivery: "desktop",
        payload: { mcp: { search: { command: ["search-mcp", revision], timeout: 10_000 } } },
      },
      {
        id: "cloud",
        type: "mcp",
        title: "Cloud",
        versionId: `cloud-${revision}`,
        delivery: "cloud",
        payload: { mcp: { cloud: { url: "https://cloud.example.test/mcp" } } },
      },
    ],
  };
}

async function activate(registry: HostMarketplacePluginRegistry, scope = scopeA, expectedRevision = 0, key = `activate-${scope.organizationId}`) {
  return registry.activateScope(context(scope, expectedRevision, key));
}

async function missing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}

describe("host Marketplace plugin registry", () => {
  test("replays the ordered schema v1 migration over a populated registry", async () => {
    const { root, registry } = await fixture();
    let result = await activate(registry);
    result = await registry.install(context(scopeA, result.registryRevision, "migration-populated"), packageRevision());
    registry.close();

    const databasePath = join(root, "runtime.sqlite");
    const seeded = new Database(databasePath);
    seeded.run("DELETE FROM host_marketplace_schema_migrations WHERE version = 1");
    seeded.close();

    const reopened = await createHostMarketplacePluginRegistry({
      databasePath,
      storageDirectory: join(root, "runtime"),
      globalOpenCodeDirectory: join(root, "opencode"),
    });
    try {
      expect((await reopened.list(scopeA)).installations).toHaveLength(1);
      await reopened.install(context(scopeA, result.registryRevision, "migration-busy-timeout"), packageRevision());
      const inspected = new Database(databasePath);
      try {
        expect(inspected.query("SELECT version FROM host_marketplace_schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }]);
      } finally {
        inspected.close();
      }
    } finally {
      reopened.close();
    }
  });

  test("startup deletes legacy terminal operation journals", async () => {
    const { root, registry } = await fixture();
    registry.close();
    const databasePath = join(root, "runtime.sqlite");
    const seeded = new Database(databasePath);
    seeded.run(`INSERT INTO host_marketplace_operation_journal(
      operation_id, operation, phase, before_json, desired_json, created_at, updated_at
    ) VALUES ('legacy-completed', 'install', 'completed', ?, ?, 1, 1)`, [
      JSON.stringify({ secret: "before-secret" }),
      JSON.stringify({ secret: "desired-secret" }),
    ]);
    seeded.run(`INSERT INTO host_marketplace_operation_journal(
      operation_id, operation, phase, before_json, desired_json, created_at, updated_at
    ) VALUES ('legacy-rolled-back', 'update', 'rolled_back', ?, ?, 2, 2)`, [
      JSON.stringify({ secret: "rollback-secret" }),
      JSON.stringify({ secret: "rollback-desired-secret" }),
    ]);
    seeded.close();

    const reopened = await createHostMarketplacePluginRegistry({
      databasePath,
      storageDirectory: join(root, "runtime"),
      globalOpenCodeDirectory: join(root, "opencode"),
    });
    try {
      const inspected = new Database(databasePath);
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_operation_journal").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      reopened.close();
    }
  });

  test("reads one authoritative active registry snapshot across scope switches", async () => {
    const { registry } = await fixture();
    try {
      let result = await activate(registry, scopeA);
      result = await registry.install(context(scopeA, result.registryRevision, "install-a"), packageRevision());
      expect(await registry.getActiveRegistry()).toMatchObject({
        active: true,
        scope: scopeA,
        installations: [{ pluginId: "planning-suite" }],
      });

      await registry.activateScope(context(scopeB, result.registryRevision, "activate-b"));
      expect(await registry.getActiveRegistry()).toMatchObject({
        active: true,
        scope: scopeB,
        installations: [],
      });
    } finally {
      registry.close();
    }
  });

  test("installs all supported host resources, returns the MCP overlay, and replays idempotently", async () => {
    const { root, globalOpenCodeDirectory, registry } = await fixture();
    try {
      const active = await activate(registry);
      const input = context(scopeA, active.registryRevision, "install-planner");
      const installed = await registry.install(input, packageRevision());
      const replayed = await registry.install(input, packageRevision());

      expect(replayed).toEqual(installed);
      expect(installed.installation?.resources.map((resource) => resource.kind)).toEqual([
        "file", "file", "file", "file", "file", "file", "mcp",
      ]);
      expect(Object.keys(installed.mcpOverlay)).toHaveLength(1);
      expect(Object.values(installed.mcpOverlay)[0]).toMatchObject({ type: "local", command: ["search-mcp", "v1"] });
      expect((await registry.list(scopeA)).installations).toHaveLength(1);
      const skill = installed.installation!.resources.find((resource) => resource.componentId === "skill")!;
      expect(skill.target).toMatch(/^skills\/jw-planning-suite-[a-f0-9]{12}\//);
      expect(await readFile(join(globalOpenCodeDirectory, skill.target), "utf8")).toBe("# Planner v1\n");
      const inspected = new Database(join(root, "runtime.sqlite"));
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_operation_journal").all()).toEqual([]);
        expect(inspected.query("SELECT response_json FROM host_marketplace_idempotency WHERE idempotency_key = 'install-planner'").all()).toHaveLength(1);
      } finally {
        inspected.close();
      }
    } finally {
      registry.close();
    }
  });

  test("rejects literal host MCP environment values before cache or registry persistence", async () => {
    const { root, registry } = await fixture();
    try {
      const active = await activate(registry);
      const literalSecret: HostMarketplacePackage = {
        pluginId: "literal-secret",
        marketplaceId: "team-marketplace",
        name: "Literal Secret",
        revision: "v1",
        confirmedExecutableRevision: "v1",
        components: [{
          id: "mcp",
          type: "mcp",
          title: "Secret MCP",
          versionId: "v1",
          delivery: "desktop",
          payload: { mcp: { secret: { command: ["secret-mcp"], environment: { API_KEY: "sk-literal-secret" } } } },
        }],
      };

      await expect(registry.install(context(scopeA, active.registryRevision, "literal-secret"), literalSecret)).rejects.toMatchObject({
        code: "host_marketplace_mcp_environment_reference_required",
      });
      expect((await registry.list(scopeA)).installations).toEqual([]);
      await missing(join(root, "runtime", "host-marketplace", "packages"));
      const inspected = new Database(join(root, "runtime.sqlite"));
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_operation_journal").all()).toEqual([]);
        expect(inspected.query("SELECT * FROM host_marketplace_idempotency WHERE idempotency_key = 'literal-secret'").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      registry.close();
    }
  });

  test("accepts exact environment references in host MCP packages", async () => {
    const { registry } = await fixture();
    try {
      const active = await activate(registry);
      const referenced: HostMarketplacePackage = {
        pluginId: "referenced-secret",
        marketplaceId: "team-marketplace",
        name: "Referenced Secret",
        revision: "v1",
        confirmedExecutableRevision: "v1",
        components: [{
          id: "mcp",
          type: "mcp",
          title: "Referenced MCP",
          versionId: "v1",
          delivery: "desktop",
          payload: { mcp: { referenced: { command: ["referenced-mcp"], env: { API_KEY: "{env:MARKETPLACE_API_KEY}" } } } },
        }],
      };

      const installed = await registry.install(context(scopeA, active.registryRevision, "referenced-secret"), referenced);
      expect(Object.values(installed.mcpOverlay)[0]?.environment).toEqual({ API_KEY: "{env:MARKETPLACE_API_KEY}" });
    } finally {
      registry.close();
    }
  });

  test("materializes only the desktop MCP from a mixed cloud-skill package", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      const active = await activate(registry);
      const input: HostMarketplacePackage = {
        pluginId: "mixed-delivery",
        marketplaceId: "team-marketplace",
        name: "Mixed Delivery",
        revision: "v1",
        confirmedExecutableRevision: "v1",
        components: [
          { id: "cloud-skill", type: "skill", title: "Cloud Guidance", versionId: "skill-v1", source: "# Cloud only", delivery: "cloud" },
          { id: "desktop-mcp", type: "mcp", title: "Local Runtime", versionId: "mcp-v1", payload: { mcp: { local: { command: ["local-mcp"] } } }, delivery: "desktop" },
        ],
      };

      const result = await registry.install(context(scopeA, active.registryRevision, "mixed-delivery"), input);

      expect(result.installation?.resources).toEqual([
        expect.objectContaining({ kind: "mcp", componentId: "desktop-mcp" }),
      ]);
      expect(Object.values(result.mcpOverlay)[0]?.command).toEqual(["local-mcp"]);
      await expect(readdir(join(globalOpenCodeDirectory, "skills"))).rejects.toThrow();
    } finally {
      registry.close();
    }
  });

  test("materializes an explicitly desktop-delivered skill", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      const active = await activate(registry);
      const input: HostMarketplacePackage = {
        pluginId: "desktop-skill",
        marketplaceId: "team-marketplace",
        name: "Desktop Skill",
        revision: "v1",
        components: [
          { id: "desktop-skill", type: "skill", title: "Desktop Skill", versionId: "skill-v1", source: "# Desktop", delivery: "desktop" },
        ],
      };

      const result = await registry.install(context(scopeA, active.registryRevision, "desktop-skill"), input);
      const resource = result.installation?.resources[0];

      expect(resource).toMatchObject({ kind: "file", componentId: "desktop-skill" });
      expect(await readFile(join(globalOpenCodeDirectory, resource!.target), "utf8")).toBe("# Desktop\n");
    } finally {
      registry.close();
    }
  });

  test("updates and removes owned resources", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-v1"), packageRevision("v1"));
      result = await registry.update(context(scopeA, result.registryRevision, "update-v2"), packageRevision("v2"));
      const skill = result.installation!.resources.find((resource) => resource.componentId === "skill")!;
      expect(await readFile(join(globalOpenCodeDirectory, skill.target), "utf8")).toBe("# Planner v2\n");
      expect(Object.values(result.mcpOverlay)[0]?.command).toEqual(["search-mcp", "v2"]);

      const removed = await registry.remove(context(scopeA, result.registryRevision, "remove-v2"), "planning-suite");
      expect(removed.installation).toBeNull();
      expect(removed.mcpOverlay).toEqual({});
      expect((await registry.list(scopeA)).installations).toEqual([]);
      await missing(join(globalOpenCodeDirectory, skill.target));
    } finally {
      registry.close();
    }
  });

  test("replays PUT idempotency after the initial install becomes an update candidate", async () => {
    const { registry } = await fixture();
    try {
      const active = await activate(registry);
      const input = context(scopeA, active.registryRevision, "put-v1");
      const installed = await registry.install(input, packageRevision("v1"));
      const replayed = await registry.update(input, packageRevision("v1"));
      expect(replayed).toEqual(installed);
    } finally {
      registry.close();
    }
  });

  test("canonical PUT updates an existing installation even through install", async () => {
    const { registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "put-v1"), packageRevision("v1"));
      result = await registry.install(context(scopeA, result.registryRevision, "put-v2"), packageRevision("v2"));
      expect(result.operation).toBe("update");
      expect(result.installation?.packageRevision).toBe("v2");
    } finally {
      registry.close();
    }
  });

  test("rejects an existing nonowned target without changing it", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      const active = await activate(registry);
      const expected = packageRevision();
      const probe = await registry.install(context(scopeA, active.registryRevision, "probe"), {
        ...expected,
        pluginId: "temporary-probe",
        components: [{ id: "probe", type: "skill", title: "Probe", versionId: "1", source: "probe", delivery: "desktop" }],
      });
      await registry.remove(context(scopeA, probe.registryRevision, "remove-probe"), "temporary-probe");

      // Derive the deterministic target from a separate disposable registry record.
      const disposable = await registry.install(context(scopeA, (await registry.list(scopeA)).registryRevision, "derive"), expected);
      const target = disposable.installation!.resources.find((resource) => resource.componentId === "skill")!.target;
      await registry.remove(context(scopeA, disposable.registryRevision, "remove-derived"), expected.pluginId);
      await mkdir(join(globalOpenCodeDirectory, target, ".."), { recursive: true });
      await writeFile(join(globalOpenCodeDirectory, target), "user-owned\n", "utf8");

      const revision = (await registry.list(scopeA)).registryRevision;
      await expect(registry.install(context(scopeA, revision, "conflict"), expected)).rejects.toMatchObject({
        code: "host_marketplace_ownership_conflict",
      });
      expect(await readFile(join(globalOpenCodeDirectory, target), "utf8")).toBe("user-owned\n");
      expect((await registry.list(scopeA)).installations).toEqual([]);
    } finally {
      registry.close();
    }
  });

  test("rejects a symlink in a generated global resource path", async () => {
    const { root, globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "derive-symlink-target"), packageRevision());
      const target = result.installation!.resources.find((resource) => resource.componentId === "skill")!.target;
      result = await registry.remove(context(scopeA, result.registryRevision, "remove-before-symlink"), "planning-suite");
      const external = join(root, "external");
      await mkdir(external);
      await mkdir(join(globalOpenCodeDirectory, target.split("/")[0]!), { recursive: true });
      const namespaceDirectory = join(globalOpenCodeDirectory, target.split("/").slice(0, 2).join("/"));
      await symlink(external, namespaceDirectory);

      await expect(registry.install(context(scopeA, result.registryRevision, "symlink-conflict"), packageRevision())).rejects.toMatchObject({
        code: "host_marketplace_unsafe_path",
      });
      await missing(join(external, target.split("/").at(-2)!, "SKILL.md"));
    } finally {
      registry.close();
    }
  });

  test("restores file, registry, and MCP snapshots when a mutation fails", async () => {
    let fail = false;
    const applied: Array<Record<string, Record<string, unknown>>> = [];
    const { root, globalOpenCodeDirectory, registry } = await fixture({
      applyMcpOverlay: async (overlay) => { applied.push(structuredClone(overlay)); },
      faultInjector: (stage) => {
        if (fail && stage === "after_registry") throw new Error("injected failure");
      },
    });
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-rollback"), packageRevision("v1"));
      const before = await registry.list(scopeA);
      const skill = result.installation!.resources.find((resource) => resource.componentId === "skill")!;
      fail = true;
      await expect(registry.update(context(scopeA, result.registryRevision, "failed-update"), packageRevision("v2"))).rejects.toMatchObject({
        code: "host_marketplace_mutation_failed",
      });
      expect(await readFile(join(globalOpenCodeDirectory, skill.target), "utf8")).toBe("# Planner v1\n");
      expect(await registry.list(scopeA)).toEqual(before);
      expect(Object.values(await registry.getMcpOverlay())[0]?.command).toEqual(["search-mcp", "v1"]);
      expect(Object.values(applied.at(-1) ?? {})[0]?.command).toEqual(["search-mcp", "v1"]);
      const inspected = new Database(join(root, "runtime.sqlite"));
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_operation_journal").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      registry.close();
    }
  });

  test("preserves modified owned resources and marks removal repair-required", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-for-edit"), packageRevision());
      const skill = result.installation!.resources.find((resource) => resource.componentId === "skill")!;
      await writeFile(join(globalOpenCodeDirectory, skill.target), "member edit\n", "utf8");

      await expect(registry.remove(context(scopeA, result.registryRevision, "remove-modified"), "planning-suite")).rejects.toMatchObject({
        code: "host_marketplace_repair_required",
      });
      expect(await readFile(join(globalOpenCodeDirectory, skill.target), "utf8")).toBe("member edit\n");
      expect((await registry.list(scopeA)).installations[0]?.status).toBe("repair_required");
    } finally {
      registry.close();
    }
  });

  test("preserves a modified owned MCP overlay and marks removal repair-required", async () => {
    let liveOverlay: Record<string, Record<string, unknown>> = {};
    const { registry } = await fixture({
      readMcpOverlay: async () => structuredClone(liveOverlay),
      applyMcpOverlay: async (overlay) => { liveOverlay = structuredClone(overlay); },
    });
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-for-mcp-edit"), packageRevision());
      const name = Object.keys(liveOverlay)[0]!;
      liveOverlay[name] = { ...liveOverlay[name], command: ["member-edited-command"] };

      await expect(registry.remove(context(scopeA, result.registryRevision, "remove-modified-mcp"), "planning-suite")).rejects.toMatchObject({
        code: "host_marketplace_repair_required",
      });
      expect(liveOverlay[name]?.command).toEqual(["member-edited-command"]);
      expect((await registry.list(scopeA)).installations[0]?.status).toBe("repair_required");
    } finally {
      registry.close();
    }
  });

  test("keeps same-title components distinct and isolates active identity scopes", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry, scopeA);
      const sameNames: HostMarketplacePackage = {
        pluginId: "same-name",
        marketplaceId: "team-marketplace",
        name: "Same Name",
        revision: "a1",
        components: [
          { id: "first", type: "command", title: "Run", versionId: "1", source: "first", delivery: "desktop" },
          { id: "second", type: "command", title: "Run", versionId: "1", source: "second", delivery: "desktop" },
        ],
      };
      result = await registry.install(context(scopeA, result.registryRevision, "same-name-a"), sameNames);
      const targets = result.installation!.resources.map((resource) => resource.target);
      expect(new Set(targets).size).toBe(2);
      expect(await readFile(join(globalOpenCodeDirectory, targets[0]!), "utf8")).not.toBe(await readFile(join(globalOpenCodeDirectory, targets[1]!), "utf8"));

      result = await activate(registry, scopeB, result.registryRevision, "activate-b");
      expect((await registry.list(scopeA)).active).toBe(false);
      expect((await registry.list(scopeA)).installations).toHaveLength(1);
      expect((await registry.list(scopeB)).installations).toHaveLength(0);
      for (const target of targets) await missing(join(globalOpenCodeDirectory, target));

      const packageB: HostMarketplacePackage = {
        ...sameNames,
        revision: "b1",
        components: [{ id: "first", type: "command", title: "Run", versionId: "b1", source: "organization b", delivery: "desktop" }],
      };
      result = await registry.install(context(scopeB, result.registryRevision, "same-name-b"), packageB);
      const targetB = result.installation!.resources[0]!.target;
      expect(await readFile(join(globalOpenCodeDirectory, targetB), "utf8")).toBe("organization b\n");

      result = await activate(registry, scopeA, result.registryRevision, "reactivate-a");
      expect((await registry.list(scopeA)).active).toBe(true);
      expect(await readFile(join(globalOpenCodeDirectory, targets[0]!), "utf8")).toMatch(/first|second/);
      expect(await readFile(join(globalOpenCodeDirectory, targets[1]!), "utf8")).toMatch(/first|second/);
    } finally {
      registry.close();
    }
  });

  test("deactivates the active projection on sign-out while retaining scoped records", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-signout"), packageRevision());
      const target = result.installation!.resources.find((resource) => resource.kind === "file")!.target;
      result = await registry.deactivateScope(context(scopeA, result.registryRevision, "signout"));

      expect(result.activeScope).toBeNull();
      expect(result.mcpOverlay).toEqual({});
      expect(await registry.getActiveScope()).toBeNull();
      expect((await registry.list(scopeA)).installations).toHaveLength(1);
      await missing(join(globalOpenCodeDirectory, target));
    } finally {
      registry.close();
    }
  });

  test("replays deactivation after the scope is inactive", async () => {
    const { registry } = await fixture();
    try {
      let result = await activate(registry);
      const input = context(scopeA, result.registryRevision, "deactivate-replay");
      result = await registry.deactivateScope(input);
      expect(await registry.deactivateScope(input)).toEqual(result);
    } finally {
      registry.close();
    }
  });

  test("deactivates a repair-required modified hook, clears its overlay, and quarantines the edit", async () => {
    let liveOverlay: Record<string, Record<string, unknown>> = {};
    const { root, globalOpenCodeDirectory, registry } = await fixture({
      readMcpOverlay: async () => structuredClone(liveOverlay),
      applyMcpOverlay: async (overlay) => { liveOverlay = structuredClone(overlay); },
    });
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-hook-edit"), packageRevision());
      const hook = result.installation!.resources.find((resource) => resource.componentId === "hook")!;
      await writeFile(join(globalOpenCodeDirectory, hook.target), "member hook edit\n", "utf8");

      await expect(registry.remove(context(scopeA, result.registryRevision, "remove-modified-hook"), "planning-suite")).rejects.toMatchObject({
        code: "host_marketplace_repair_required",
      });
      const repairRevision = (await registry.list(scopeA)).registryRevision;
      const deactivated = await registry.deactivateScope(context(scopeA, repairRevision, "deactivate-repair-hook"));

      expect(deactivated.activeScope).toBeNull();
      expect(deactivated.mcpOverlay).toEqual({});
      expect(await registry.getActiveScope()).toBeNull();
      expect(liveOverlay).toEqual({});
      await missing(join(globalOpenCodeDirectory, hook.target));

      const installation = (await registry.list(scopeA)).installations[0]!;
      expect(installation.status).toBe("repair_required");
      expect(installation.repair?.operation).toBe("deactivate");
      expect(installation.repair?.resources).toContain(hook.target);
      const quarantineEntry = installation.repair?.quarantine?.entries.find((entry) => entry.resource === hook.target);
      expect(quarantineEntry).toMatchObject({ kind: "file" });
      expect(await readFile(join(root, "runtime", quarantineEntry!.path), "utf8")).toBe("member hook edit\n");
    } finally {
      registry.close();
    }
  });

  test("quarantines a previous repair while atomically activating a new scope", async () => {
    const { root, globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-repair-switch"), packageRevision());
      const hook = result.installation!.resources.find((resource) => resource.componentId === "hook")!;
      await writeFile(join(globalOpenCodeDirectory, hook.target), "organization a edit\n", "utf8");
      await expect(registry.remove(context(scopeA, result.registryRevision, "mark-repair-before-switch"), "planning-suite")).rejects.toMatchObject({
        code: "host_marketplace_repair_required",
      });

      result = await registry.activateScope(context(scopeB, (await registry.list(scopeA)).registryRevision, "activate-b-after-repair"));

      expect(result.activeScope).toEqual(scopeB);
      expect((await registry.list(scopeA)).active).toBe(false);
      expect((await registry.list(scopeA)).installations[0]?.status).toBe("repair_required");
      await missing(join(globalOpenCodeDirectory, hook.target));
      const repair = (await registry.list(scopeA)).installations[0]!.repair!;
      const quarantineEntry = repair.quarantine?.entries.find((entry) => entry.resource === hook.target);
      expect(await readFile(join(root, "runtime", quarantineEntry!.path), "utf8")).toBe("organization a edit\n");
    } finally {
      registry.close();
    }
  });

  test("does not follow an unsafe symlink while deactivating its scope", async () => {
    let liveOverlay: Record<string, Record<string, unknown>> = {};
    const { root, globalOpenCodeDirectory, registry } = await fixture({
      readMcpOverlay: async () => structuredClone(liveOverlay),
      applyMcpOverlay: async (overlay) => { liveOverlay = structuredClone(overlay); },
    });
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-unsafe-deactivate"), packageRevision());
      const hook = result.installation!.resources.find((resource) => resource.componentId === "hook")!;
      const namespace = hook.target.split("/").slice(0, 2).join("/");
      const external = join(root, "external-hooks");
      await mkdir(external);
      await rm(join(globalOpenCodeDirectory, namespace), { recursive: true });
      await writeFile(join(external, hook.target.split("/").at(-1)!), "external content\n", "utf8");
      await symlink(external, join(globalOpenCodeDirectory, namespace));

      const deactivated = await registry.deactivateScope(context(scopeA, result.registryRevision, "deactivate-unsafe-hook"));

      expect(deactivated.activeScope).toBeNull();
      expect(liveOverlay).toEqual({});
      expect(await readFile(join(external, hook.target.split("/").at(-1)!), "utf8")).toBe("external content\n");
      const repair = (await registry.list(scopeA)).installations[0]!.repair!;
      expect(repair.resources).toContain(hook.target);
      const marker = repair.quarantine?.entries.find((entry) => entry.resource === hook.target);
      expect(marker).toMatchObject({ kind: "unsafe" });
      expect(await readFile(join(root, "runtime", marker!.path), "utf8")).toContain(hook.target);
    } finally {
      registry.close();
    }
  });

  test("startup deactivation quarantines modified resources, clears overlay and active scope", async () => {
    let liveOverlay: Record<string, Record<string, unknown>> = {};
    const { root, globalOpenCodeDirectory, registry } = await fixture({
      readMcpOverlay: async () => structuredClone(liveOverlay),
      applyMcpOverlay: async (overlay) => { liveOverlay = structuredClone(overlay); },
    });
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-before-restart"), packageRevision());
      const skill = result.installation!.resources.find((resource) => resource.componentId === "skill")!;
      await writeFile(join(globalOpenCodeDirectory, skill.target), "member edit\n", "utf8");
      const mcpName = Object.keys(liveOverlay)[0]!;
      liveOverlay[mcpName] = { command: ["member-edited"] };

      await registry.startupDeactivateAndRecover();

      expect(await registry.getActiveScope()).toBeNull();
      expect(liveOverlay).toEqual({});
      await missing(join(globalOpenCodeDirectory, skill.target));
      const installation = (await registry.list(scopeA)).installations[0]!;
      expect(installation.status).toBe("repair_required");
      expect(installation.repair?.resources).toContain(skill.target);
      expect(installation.repair?.resources).toContain(`mcp:${mcpName}`);
      const quarantineRoot = join(root, "runtime", "host-marketplace", "quarantine");
      const quarantineRuns = await readdir(quarantineRoot);
      expect(quarantineRuns).toHaveLength(1);
      expect(await readFile(join(quarantineRoot, quarantineRuns[0]!, "files", skill.target), "utf8")).toBe("member edit\n");
    } finally {
      registry.close();
    }
  });

  for (const stage of ["after_files", "after_registry", "after_engine"] as const) {
    test(`recovers a fail-stop at ${stage} when the registry reopens`, async () => {
      let fail = false;
      let liveOverlay: Record<string, Record<string, unknown>> = {};
      const root = await mkdtemp(join(tmpdir(), "jugglework-host-marketplace-crash-"));
      roots.push(root);
      const options = {
        databasePath: join(root, "runtime.sqlite"),
        storageDirectory: join(root, "runtime"),
        globalOpenCodeDirectory: join(root, "opencode"),
        readMcpOverlay: async () => structuredClone(liveOverlay),
        applyMcpOverlay: async (overlay: Record<string, Record<string, unknown>>) => { liveOverlay = structuredClone(overlay); },
        faultInjector: (candidate: string) => {
          if (fail && candidate === stage) throw new HostMarketplaceFailStopError();
        },
      };
      const first = await createHostMarketplacePluginRegistry(options);
      let result = await activate(first);
      result = await first.install(context(scopeA, result.registryRevision, "install-before-crash"), packageRevision("v1"));
      const target = result.installation!.resources.find((resource) => resource.componentId === "skill")!.target;
      fail = true;
      await expect(first.update(context(scopeA, result.registryRevision, `crash-${stage}`), packageRevision("v2"))).rejects.toBeInstanceOf(HostMarketplaceFailStopError);
      first.close();

      fail = false;
      const reopened = await createHostMarketplacePluginRegistry(options);
      try {
        await reopened.startupDeactivateAndRecover();
        expect(await reopened.getActiveScope()).toBeNull();
        expect(liveOverlay).toEqual({});
        expect((await reopened.list(scopeA)).installations[0]?.packageRevision).toBe("v1");
        await missing(join(root, "opencode", target));
      } finally {
        reopened.close();
      }
    });
  }

  test("replays a nonterminal journal only once across repeated startup recovery", async () => {
    let fail = false;
    let liveOverlay: Record<string, Record<string, unknown>> = {};
    const root = await mkdtemp(join(tmpdir(), "jugglework-host-marketplace-journal-idempotency-"));
    roots.push(root);
    const options = {
      databasePath: join(root, "runtime.sqlite"),
      storageDirectory: join(root, "runtime"),
      globalOpenCodeDirectory: join(root, "opencode"),
      readMcpOverlay: async () => structuredClone(liveOverlay),
      applyMcpOverlay: async (overlay: Record<string, Record<string, unknown>>) => { liveOverlay = structuredClone(overlay); },
      faultInjector: (stage: string) => {
        if (fail && stage === "after_registry") throw new HostMarketplaceFailStopError();
      },
    };
    const first = await createHostMarketplacePluginRegistry(options);
    let result = await activate(first);
    result = await first.install(context(scopeA, result.registryRevision, "install-before-idempotent-recovery"), packageRevision("v1"));
    fail = true;
    await expect(first.update(context(scopeA, result.registryRevision, "crash-before-idempotent-recovery"), packageRevision("v2"))).rejects.toBeInstanceOf(HostMarketplaceFailStopError);
    first.close();

    const crashed = new Database(options.databasePath);
    try {
      expect(crashed.query("SELECT phase FROM host_marketplace_operation_journal").all()).toEqual([{ phase: "registry_applied" }]);
    } finally {
      crashed.close();
    }

    fail = false;
    const reopened = await createHostMarketplacePluginRegistry(options);
    try {
      await reopened.startupDeactivateAndRecover();
      const recovered = await reopened.list(scopeA);
      expect(recovered.active).toBe(false);
      expect(recovered.installations[0]?.packageRevision).toBe("v1");
      const recoveredRevision = recovered.registryRevision;

      await reopened.startupDeactivateAndRecover();
      expect(await reopened.list(scopeA)).toEqual(recovered);
      expect((await reopened.list(scopeA)).registryRevision).toBe(recoveredRevision);
      expect(liveOverlay).toEqual({});

      const inspected = new Database(options.databasePath);
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_operation_journal").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      reopened.close();
    }
  });

  test("does not create an installation record for pure Cloud content and rejects unsupported desktop components", async () => {
    const { registry } = await fixture();
    try {
      const active = await activate(registry);
      const cloudOnly: HostMarketplacePackage = {
        pluginId: "cloud-only",
        marketplaceId: "team-marketplace",
        name: "Cloud Only",
        revision: "1",
        components: [{ id: "cloud", type: "mcp", title: "Cloud", versionId: "1", delivery: "cloud", payload: { mcp: { cloud: { url: "https://example.test/mcp" } } } }],
      };
      const result = await registry.install(context(scopeA, active.registryRevision, "cloud-only"), cloudOnly);
      expect(result.operation).toBe("cloud_only");
      expect((await registry.list(scopeA)).installations).toEqual([]);

      const cloudCustom = await registry.install(context(scopeA, result.registryRevision, "custom-cloud"), {
        ...cloudOnly,
        pluginId: "custom",
        components: [{ id: "custom", type: "custom", title: "Custom", versionId: "1", delivery: "cloud" }],
      });
      expect(cloudCustom).toMatchObject({ operation: "cloud_only", changed: false, installation: null });
      await expect(registry.install(context(scopeA, cloudCustom.registryRevision, "custom-desktop"), {
        ...cloudOnly,
        pluginId: "custom-desktop",
        components: [{ id: "custom", type: "custom", title: "Custom", versionId: "1", delivery: "desktop" }],
      })).rejects.toMatchObject({ code: "unsupported_host_marketplace_component" });
      await expect(registry.install(context(scopeA, result.registryRevision, "remote"), {
        ...cloudOnly,
        pluginId: "remote",
        confirmedExecutableRevision: "1",
        components: [{ id: "remote", type: "mcp", title: "Remote", versionId: "1", delivery: "desktop", payload: { url: "https://example.test/mcp" } }],
      })).rejects.toMatchObject({ code: "unsupported_host_marketplace_mcp" });
    } finally {
      registry.close();
    }
  });

  test("pure Cloud PUT transactionally dematerializes an installed package", async () => {
    const { globalOpenCodeDirectory, registry } = await fixture();
    try {
      let result = await activate(registry);
      result = await registry.install(context(scopeA, result.registryRevision, "install-desktop"), packageRevision());
      const target = result.installation!.resources.find((resource) => resource.kind === "file")!.target;
      const cloudOnly: HostMarketplacePackage = {
        pluginId: "planning-suite",
        marketplaceId: "team-marketplace",
        name: "Planning Suite",
        revision: "cloud-v2",
        components: [{ id: "cloud", type: "mcp", title: "Cloud", versionId: "2", delivery: "cloud", payload: { mcp: { cloud: { url: "https://example.test/mcp" } } } }],
      };
      const dematerialized = await registry.install(context(scopeA, result.registryRevision, "put-cloud"), cloudOnly);
      expect(dematerialized).toMatchObject({ operation: "cloud_only", changed: true, installation: null, mcpOverlay: {} });
      expect((await registry.list(scopeA)).installations).toEqual([]);
      await missing(join(globalOpenCodeDirectory, target));
    } finally {
      registry.close();
    }
  });
});
