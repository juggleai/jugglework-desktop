import { beforeEach, describe, expect, test } from "bun:test";

import type {
  DenOrgLlmProviderConnection,
  DenOrgLlmProviderModel,
} from "../src/app/lib/den";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import { buildCloudImportedProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import {
  cloudProviderReconcileAction,
  resetUnappliedCloudProviderReloadKeysForTest,
  shouldMarkUnappliedCloudProviderReload,
} from "../src/react-app/domains/connections/provider-auth/store";

const LPR_ID = "lpr_openrouter";

const makeModel = (id: string): DenOrgLlmProviderModel => ({ id, name: id, config: {}, createdAt: null });

const makeProvider = (models: string[], updatedAt = "2026-11-01T00:00:00.000Z"): DenOrgLlmProviderConnection => ({
  id: LPR_ID,
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: {} },
  hasApiKey: true,
  models: models.map(makeModel),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  apiKey: "sk-test",
  apiKeys: null,
});

const imports = (provider: DenOrgLlmProviderConnection): Record<string, CloudImportedProvider> => ({
  [provider.id]: buildCloudImportedProvider(provider, Date.now(), "org_current"),
});

const engine = (models: string[]) => [{
  id: LPR_ID,
  models: Object.fromEntries(models.map((id) => [id, { id }])),
}];

beforeEach(() => resetUnappliedCloudProviderReloadKeysForTest());

describe("model-level cloud provider reload marking", () => {
  test("asks once when the engine lacks a newly imported model on an existing provider", () => {
    // Den added model-y; the import already wrote the baseline but the
    // reload was deferred, so the engine still serves only model-x.
    const imported = imports(makeProvider(["model-x", "model-y"]));
    const input = { workspaceId: "ws_a", imported, engineProviders: engine(["model-x"]) };
    expect(shouldMarkUnappliedCloudProviderReload(input)).toBe(true);
    // Focus/resume/settings triggers with the same gap do not re-mark.
    expect(shouldMarkUnappliedCloudProviderReload(input)).toBe(false);
  });

  test("re-arms once the difference disappears", () => {
    const imported = imports(makeProvider(["model-x", "model-y"]));
    const missing = { workspaceId: "ws_a", imported, engineProviders: engine(["model-x"]) };
    expect(shouldMarkUnappliedCloudProviderReload(missing)).toBe(true);
    expect(shouldMarkUnappliedCloudProviderReload({ ...missing, engineProviders: engine(["model-x", "model-y"]) }))
      .toBe(false);
    expect(shouldMarkUnappliedCloudProviderReload(missing)).toBe(true);
  });

  test("a new difference asks again without waiting for re-arm", () => {
    const first = { workspaceId: "ws_a", imported: imports(makeProvider(["model-x", "model-y"])), engineProviders: engine(["model-x"]) };
    expect(shouldMarkUnappliedCloudProviderReload(first)).toBe(true);
    const second = { ...first, imported: imports(makeProvider(["model-x", "model-z"])) };
    expect(shouldMarkUnappliedCloudProviderReload(second)).toBe(true);
  });

  test("dedupe is per workspace: B becoming applied does not re-arm A", () => {
    const imported = imports(makeProvider(["model-x", "model-y"]));
    const a = { workspaceId: "ws_a", imported, engineProviders: engine(["model-x"]) };
    expect(shouldMarkUnappliedCloudProviderReload(a)).toBe(true);
    expect(shouldMarkUnappliedCloudProviderReload({ ...a, workspaceId: "ws_b" })).toBe(true);
    expect(shouldMarkUnappliedCloudProviderReload({
      workspaceId: "ws_b",
      imported,
      engineProviders: engine(["model-x", "model-y"]),
    })).toBe(false);
    expect(shouldMarkUnappliedCloudProviderReload(a)).toBe(false);
  });

  test("extra engine-side models cannot cause a reload loop", () => {
    expect(shouldMarkUnappliedCloudProviderReload({
      workspaceId: "ws_a",
      imported: imports(makeProvider(["model-x"])),
      engineProviders: engine(["model-x", "engine-extra"]),
    })).toBe(false);
  });
});

describe("sync reconcile decision", () => {
  test("baseline in sync but engine missing models: keep (reload only, no re-import)", () => {
    const live = makeProvider(["model-x", "model-y"]);
    expect(cloudProviderReconcileAction({
      liveProvider: live,
      importedProvider: imports(live)[LPR_ID]!,
      organizationId: "org_current",
      // The engine lists the provider; its model set is checked afterwards.
      engineProviderIds: new Set([LPR_ID]),
    })).toBe("keep");
  });

  test("engine missing the provider entirely forces a re-import", () => {
    const live = makeProvider(["model-x"]);
    expect(cloudProviderReconcileAction({
      liveProvider: live,
      importedProvider: imports(live)[LPR_ID]!,
      organizationId: "org_current",
      engineProviderIds: new Set(["anthropic"]),
    })).toBe("reimport");
  });

  test("a gateway provider the engine lists but no longer authenticates is re-imported", () => {
    // The incident: the shared OpenCode auth entry was deleted, the baseline
    // and runtime block still looked current, and sync skipped it forever.
    const live = makeProvider(["model-x"]);
    const importedProvider = {
      ...imports(live)[LPR_ID]!,
      gatewayMirror: { organizationId: "org_current", cloudProviderId: LPR_ID, key: "MCP_GATEWAY_KEY_V2_ORG_x" },
    };
    const decide = (connected: ReadonlySet<string> | null) => cloudProviderReconcileAction({
      liveProvider: live, importedProvider, organizationId: "org_current",
      engineProviderIds: new Set([LPR_ID]), engineConnectedProviderIds: connected,
    });
    expect(decide(new Set())).toBe("reimport");
    expect(decide(new Set([LPR_ID]))).toBe("keep");
    // An unreadable connected list is unknown, never a reason to re-import.
    expect(decide(null)).toBe("keep");
  });

  test("stale baseline re-imports; unreadable engine list does not force one", () => {
    const baseline = imports(makeProvider(["model-x"]))[LPR_ID]!;
    const live = makeProvider(["model-x", "model-y"], "2026-11-02T00:00:00.000Z");
    expect(cloudProviderReconcileAction({
      liveProvider: live, importedProvider: baseline, organizationId: "org_current", engineProviderIds: null,
    })).toBe("reimport");
    expect(cloudProviderReconcileAction({
      liveProvider: makeProvider(["model-x"]), importedProvider: baseline, organizationId: "org_current", engineProviderIds: null,
    })).toBe("keep");
  });
});
