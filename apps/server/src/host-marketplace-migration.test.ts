import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { installCloudPlugin, readInstalledCloudPlugins, type CloudPluginResolved } from "./cloud-plugins.js";
import { createHostMarketplacePluginRegistry, type HostMarketplacePackage, type HostMarketplaceScope } from "./host-marketplace-plugins.js";
import {
  createHostMarketplaceMigrationCoordinator,
  HostMarketplaceMigrationFailStopError,
  type HostMarketplaceMigrationPlan,
} from "./host-marketplace-migration.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const scope: HostMarketplaceScope = {
  environmentId: "env-test",
  controlPlaneOrigin: "https://work.example.test",
  userId: "user-a",
  organizationId: "org-a",
};

function resolved(pluginId: string, source = "# Workspace copy"): CloudPluginResolved {
  return {
    plugin: { id: pluginId, name: "Migration Plugin", description: null, updatedAt: "v1" },
    memberships: [{
      configObjectId: "skill",
      configObject: {
        id: "skill",
        objectType: "skill",
        title: "Migration Skill",
        description: null,
        currentRelativePath: null,
        status: "active",
        updatedAt: "v1",
        latestVersion: { id: "skill-v1", rawSourceText: source, normalizedPayloadJson: null },
      },
    }],
  };
}

function hostPackage(pluginId: string): HostMarketplacePackage {
  return {
    pluginId,
    marketplaceId: "marketplace",
    name: "Migration Plugin",
    revision: "host-v1",
    components: [{ id: "skill", type: "skill", title: "Migration Skill", versionId: "host-v1", source: "# Host copy", delivery: "desktop" }],
  };
}

async function fixture(workspaceCount = 1, faultInjector?: Parameters<typeof createHostMarketplaceMigrationCoordinator>[0]["faultInjector"]) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-host-migration-"));
  roots.push(root);
  const workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
    id: `ws_${index + 1}`,
    name: `Workspace ${index + 1}`,
    displayName: `Project ${index + 1}`,
    path: join(root, `workspace-${index + 1}`),
    preset: "starter",
    workspaceType: "local" as const,
  }));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "client",
    hostToken: "host-secret",
    approval: { mode: "auto", timeoutMs: 100 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [root],
    readOnly: false,
    managedRuntime: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const authority = Object.freeze({});
  const registry = await createHostMarketplacePluginRegistry({
    config,
    databasePath: join(root, "runtime.sqlite"),
    storageDirectory: root,
    globalOpenCodeDirectory: join(root, "global-opencode"),
    migrationAuthority: authority,
    findWorkspaceConflicts: async (pluginId) => {
      const conflicts: string[] = [];
      for (const workspace of workspaces) {
        if ((await readInstalledCloudPlugins(config, workspace.id)).plugins[pluginId]) conflicts.push(workspace.id);
      }
      return conflicts;
    },
  });
  await registry.activateScope({ scope, authority: "owner", expectedRevision: 0, idempotencyKey: "activate" });
  const coordinator = await createHostMarketplaceMigrationCoordinator({ config, registry, authority, environmentId: scope.environmentId, faultInjector });
  return { root, config, workspaces, authority, registry, coordinator };
}

async function installCopies(f: Awaited<ReturnType<typeof fixture>>, pluginId: string): Promise<void> {
  for (const workspace of f.workspaces) {
    await installCloudPlugin({
      serverConfig: f.config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      marketplaceId: "marketplace",
      resolved: resolved(pluginId),
    });
  }
}

function commitInput(plan: HostMarketplaceMigrationPlan, packageInput: HostMarketplacePackage, idempotencyKey = "migrate") {
  return {
    scope,
    package: packageInput,
    expectedRevision: plan.registryRevision,
    idempotencyKey,
    workspaceCopies: plan.workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
    confirmed: true as const,
    fingerprint: plan.fingerprint,
    migrationToken: plan.migrationToken,
  };
}

describe("host Marketplace workspace-copy migration", () => {
  test("startup migrates legacy completed results and deletes terminal migration journals", async () => {
    const f = await fixture();
    f.coordinator.close();
    const databasePath = join(f.root, "runtime.sqlite");
    const seeded = new Database(databasePath);
    const result = {
      operation: "migrate_workspace_copies",
      changed: true,
      migratedWorkspaces: ["ws_1"],
      host: { operation: "install", changed: true },
    };
    seeded.run(`INSERT INTO host_marketplace_migration_journal(
      operation_id, plugin_id, phase, request_digest, idempotency_key, before_json, result_json, created_at, updated_at
    ) VALUES ('legacy-completed', 'legacy-plugin', 'completed', 'request-digest', 'legacy-key', ?, ?, 1, 2)`, [
      JSON.stringify({ secret: "snapshot-secret" }),
      JSON.stringify(result),
    ]);
    seeded.run(`INSERT INTO host_marketplace_migration_journal(
      operation_id, plugin_id, phase, request_digest, idempotency_key, before_json, result_json, created_at, updated_at
    ) VALUES ('legacy-rolled-back', 'rolled-back-plugin', 'rolled_back', 'rollback-digest', 'rollback-key', ?, NULL, 3, 4)`, [
      JSON.stringify({ secret: "rollback-snapshot-secret" }),
    ]);
    seeded.close();

    const reopened = await createHostMarketplaceMigrationCoordinator({
      config: f.config,
      registry: f.registry,
      authority: f.authority,
      environmentId: scope.environmentId,
    });
    try {
      const inspected = new Database(databasePath);
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_migration_journal").all()).toEqual([]);
        expect(inspected.query(`SELECT plugin_id AS pluginId, idempotency_key AS idempotencyKey,
          request_digest AS requestDigest, response_json AS responseJson
          FROM host_marketplace_migration_idempotency`).all()).toEqual([{
          pluginId: "legacy-plugin",
          idempotencyKey: "legacy-key",
          requestDigest: "request-digest",
          responseJson: JSON.stringify(result),
        }]);
      } finally {
        inspected.close();
      }
    } finally {
      reopened.close();
      f.registry.close();
    }
  });

  for (const count of [1, 2]) {
    test(`migrates ${count} exact workspace ${count === 1 ? "copy" : "copies"} to the host`, async () => {
      const f = await fixture(count);
      try {
        const pluginId = `success-${count}`;
        await installCopies(f, pluginId);
        const packageInput = hostPackage(pluginId);
        const plan = await f.coordinator.plan(scope, packageInput);
        expect(plan.migratable).toBe(true);
        expect(plan.blockers).toEqual([]);
        expect(plan.workspaces).toHaveLength(count);

        const result = await f.coordinator.commit(commitInput(plan, packageInput));
        expect(result.migratedWorkspaces).toEqual(f.workspaces.map((workspace) => workspace.id));
        expect((await f.registry.list(scope)).installations.map((item) => item.pluginId)).toContain(pluginId);
        for (const workspace of f.workspaces) {
          expect((await readInstalledCloudPlugins(f.config, workspace.id)).plugins[pluginId]).toBeUndefined();
        }
        const inspected = new Database(join(f.root, "runtime.sqlite"));
        try {
          expect(inspected.query("SELECT * FROM host_marketplace_migration_journal").all()).toEqual([]);
          expect(inspected.query("SELECT response_json FROM host_marketplace_migration_idempotency WHERE plugin_id = ?").all(pluginId)).toHaveLength(1);
        } finally {
          inspected.close();
        }
      } finally {
        f.coordinator.close();
        f.registry.close();
      }
    });
  }

  test("rejects a stale plan after a workspace copy changes", async () => {
    const f = await fixture();
    try {
      const pluginId = "stale-plan";
      await installCopies(f, pluginId);
      const packageInput = hostPackage(pluginId);
      const plan = await f.coordinator.plan(scope, packageInput);
      await installCloudPlugin({
        serverConfig: f.config,
        workspaceId: f.workspaces[0]!.id,
        workspaceRoot: f.workspaces[0]!.path,
        marketplaceId: "marketplace",
        resolved: resolved(pluginId, "# Updated copy"),
      });
      await expect(f.coordinator.commit(commitInput(plan, packageInput))).rejects.toMatchObject({ code: "host_marketplace_migration_plan_stale" });
    } finally {
      f.coordinator.close();
      f.registry.close();
    }
  });

  test("replays a completed migration by idempotency key", async () => {
    const f = await fixture();
    try {
      const pluginId = "idempotent-migration";
      await installCopies(f, pluginId);
      const packageInput = hostPackage(pluginId);
      const plan = await f.coordinator.plan(scope, packageInput);
      const input = commitInput(plan, packageInput);
      const first = await f.coordinator.commit(input);
      expect(await f.coordinator.commit(input)).toEqual(first);
    } finally {
      f.coordinator.close();
      f.registry.close();
    }
  });

  test("reports a modified owned resource as a blocker without mutating it", async () => {
    const f = await fixture();
    try {
      const pluginId = "modified-copy";
      await installCopies(f, pluginId);
      const installation = (await readInstalledCloudPlugins(f.config, "ws_1")).plugins[pluginId]!;
      const path = installation.files.find((file) => file.delivery === "local_file")!.path;
      await writeFile(join(f.workspaces[0]!.path, path), "member edit\n", "utf8");
      const plan = await f.coordinator.plan(scope, hostPackage(pluginId));
      expect(plan).toMatchObject({ migratable: false, blockers: [expect.objectContaining({ code: "modified_file", workspaceId: "ws_1" })] });
      expect(await readFile(join(f.workspaces[0]!.path, path), "utf8")).toBe("member edit\n");
    } finally {
      f.coordinator.close();
      f.registry.close();
    }
  });

  test("restores exact workspace state when host installation fails", async () => {
    const f = await fixture(1, (stage) => {
      if (stage === "after_host") throw new Error("host failed");
    });
    try {
      const pluginId = "rollback-copy";
      await installCopies(f, pluginId);
      const packageInput = hostPackage(pluginId);
      const plan = await f.coordinator.plan(scope, packageInput);
      const before = (await readInstalledCloudPlugins(f.config, "ws_1")).plugins[pluginId]!;
      const path = before.files.find((file) => file.delivery === "local_file")!.path;
      const bytes = await readFile(join(f.workspaces[0]!.path, path));

      await expect(f.coordinator.commit(commitInput(plan, packageInput))).rejects.toMatchObject({ code: "host_marketplace_migration_failed" });
      expect(await readFile(join(f.workspaces[0]!.path, path))).toEqual(bytes);
      expect((await readInstalledCloudPlugins(f.config, "ws_1")).plugins[pluginId]).toEqual(before);
      expect((await f.registry.list(scope)).installations).toEqual([]);
      const inspected = new Database(join(f.root, "runtime.sqlite"));
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_migration_journal").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      f.coordinator.close();
      f.registry.close();
    }
  });

  test("startup recovery rolls back a nonterminal migration", async () => {
    let crash = true;
    const f = await fixture(1, (stage) => {
      if (crash && stage === "after_workspace") throw new HostMarketplaceMigrationFailStopError();
    });
    const pluginId = "startup-recovery";
    await installCopies(f, pluginId);
    const packageInput = hostPackage(pluginId);
    const plan = await f.coordinator.plan(scope, packageInput);
    const before = (await readInstalledCloudPlugins(f.config, "ws_1")).plugins[pluginId]!;
    await expect(f.coordinator.commit(commitInput(plan, packageInput))).rejects.toBeInstanceOf(HostMarketplaceMigrationFailStopError);
    f.coordinator.close();

    const crashed = new Database(join(f.root, "runtime.sqlite"));
    try {
      expect(crashed.query("SELECT phase FROM host_marketplace_migration_journal").all()).toEqual([{ phase: "workspaces_removed" }]);
    } finally {
      crashed.close();
    }

    crash = false;
    const reopened = await createHostMarketplaceMigrationCoordinator({
      config: f.config,
      registry: f.registry,
      authority: f.authority,
      environmentId: scope.environmentId,
    });
    try {
      await reopened.recoverNonterminal();
      expect((await readInstalledCloudPlugins(f.config, "ws_1")).plugins[pluginId]).toEqual(before);
      expect((await f.registry.list(scope)).installations).toEqual([]);
      const inspected = new Database(join(f.root, "runtime.sqlite"));
      try {
        expect(inspected.query("SELECT * FROM host_marketplace_migration_journal").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      reopened.close();
      f.registry.close();
    }
  });
});
