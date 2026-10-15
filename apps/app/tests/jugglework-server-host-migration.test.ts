import { afterEach, expect, test } from "bun:test";

import {
  createJuggleWorkServerClient,
  type JuggleWorkHostMarketplaceMigrationCommitInput,
  type JuggleWorkHostMarketplacePackage,
} from "../src/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const scope = { controlPlaneOrigin: "https://work.example.test", userId: "user-1", organizationId: "org-1" };
const packageInput: JuggleWorkHostMarketplacePackage = {
  pluginId: "plugin/one",
  marketplaceId: "marketplace-1",
  name: "Plugin one",
  revision: "revision-1",
  components: [{ id: "skill-1", type: "skill", title: "Skill", versionId: "version-1", source: "# Skill", delivery: "desktop" }],
};

test("host migration client sends the exact plan and commit route contracts", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/migration-plan")) {
      return Response.json({
        pluginId: packageInput.pluginId,
        packageDigest: "package-digest",
        registryRevision: 7,
        workspaces: [{
          workspaceId: "workspace-a",
          label: "Alpha",
          path: "/alpha",
          recordDigest: "record-a",
          resources: [{ kind: "file", target: ".opencode/skills/example/SKILL.md", digest: "file-digest" }],
          blockers: [],
          migratable: true,
        }],
        blockers: [],
        migratable: true,
        fingerprint: "fingerprint",
        migrationToken: "token",
      });
    }
    return Response.json({
      operation: "migrate_workspace_copies",
      changed: true,
      migratedWorkspaces: ["workspace-a"],
      host: {
        operation: "install",
        changed: true,
        registryRevision: 8,
        activeScope: { ...scope, environmentId: "host-1" },
        installation: null,
        mcpOverlay: {},
      },
    });
  }) as typeof fetch;
  const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787", hostToken: "host-token" });

  const plan = await client.planHostMarketplacePluginMigration({ scope, package: packageInput });
  const commit: JuggleWorkHostMarketplaceMigrationCommitInput = {
    scope,
    package: packageInput,
    expectedRevision: plan.registryRevision,
    idempotencyKey: "operation-1",
    workspaceCopies: plan.workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
    confirmed: true,
    fingerprint: plan.fingerprint,
    migrationToken: plan.migrationToken,
  };
  const result = await client.migrateHostMarketplacePluginWorkspaceCopies(commit);

  expect(new URL(requests[0]!.url).pathname).toBe("/host/marketplace-plugins/plugin%2Fone/migration-plan");
  expect(requests[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ scope, package: packageInput });
  expect(new Headers(requests[0]!.init?.headers).get("X-JuggleWork-Host-Token")).toBe("host-token");
  expect(new URL(requests[1]!.url).pathname).toBe("/host/marketplace-plugins/plugin%2Fone/migrate-workspace-copies");
  expect(requests[1]!.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[1]!.init?.body))).toEqual(commit);
  expect(result).toMatchObject({ operation: "migrate_workspace_copies", migratedWorkspaces: ["workspace-a"], host: { registryRevision: 8 } });
});
