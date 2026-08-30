import { describe, expect, test } from "bun:test";

import type { CloudImportedPlugin, CloudImportedPluginFile } from "../src/app/cloud/import-state";
import type { DenOrgPlugin, DenPluginMcpComponent } from "../src/app/lib/den";
import {
  hasMarketplacePluginLocalLedger,
  isMarketplacePluginActionDisabled,
  marketplaceResolvedCacheKey,
  resolveMarketplaceDetailResolution,
  resolveMarketplaceDetailSelection,
  resolveMarketplacePluginActions,
  resolveMarketplacePluginLifecycle,
  resolveMarketplaceResolvedCache,
} from "../src/react-app/domains/settings/pages/marketplace-plugin-state";

const plugin: DenOrgPlugin = {
  id: "plugin-1",
  name: "Test package",
  description: null,
  status: "active",
  memberCount: 2,
  updatedAt: "2026-08-30T12:00:00Z",
  componentCounts: { mcp: 2 },
};

const cloudComponent: DenPluginMcpComponent = {
  configObjectId: "cloud-object",
  serverName: "cloud-service",
  delivery: "cloud",
  url: "https://example.com/mcp",
  connectionId: "connection-1",
  credentialMode: "per_member",
  connectedForMe: true,
};

const desktopComponent: DenPluginMcpComponent = {
  configObjectId: "desktop-object",
  serverName: "desktop-service",
  delivery: "desktop",
  command: ["node", "server.js"],
};

function file(overrides: Partial<CloudImportedPluginFile> = {}): CloudImportedPluginFile {
  return {
    configObjectId: "desktop-object",
    versionId: "version-1",
    objectType: "mcp",
    title: "Desktop service",
    path: ".opencode/plugin/desktop-service",
    updatedAt: plugin.updatedAt,
    delivery: "runtime_mcp",
    outcome: "installed_local",
    ...overrides,
  };
}

function imported(overrides: Partial<CloudImportedPlugin> = {}): CloudImportedPlugin {
  return {
    pluginId: plugin.id,
    marketplaceId: "marketplace-1",
    name: plugin.name,
    description: null,
    updatedAt: plugin.updatedAt,
    files: [file()],
    importedAt: 1,
    status: "installed",
    ...overrides,
  };
}

function lifecycle(overrides: Partial<Parameters<typeof resolveMarketplacePluginLifecycle>[0]> = {}) {
  return resolveMarketplacePluginLifecycle({
    plugin,
    imported: imported(),
    components: [cloudComponent, desktopComponent],
    resolvedConfigObjectIds: ["cloud-object", "desktop-object"],
    ...overrides,
  });
}

describe("marketplace plugin canonical lifecycle", () => {
  test("uses the documented precedence for operations and unhealthy imports", () => {
    expect(lifecycle({ operation: "removing", imported: imported({ status: "repair_required" }) }).state).toBe("removing");
    expect(lifecycle({ operation: "installing", imported: imported({ status: "repair_required" }) }).state).toBe("installing");
    expect(lifecycle({ imported: imported({ status: "repair_required" }) }).state).toBe("repair_required");
    expect(lifecycle({ imported: imported({ status: "failed" }) }).state).toBe("failed");
    expect(lifecycle({ imported: imported({ status: "partial" }) }).state).toBe("partial");
  });

  test("keeps a failed store operation canonical with its retry error", () => {
    const result = lifecycle({
      operation: "failed",
      operationError: "Server rejected the workspace mutation",
      imported: null,
    });
    expect(result.state).toBe("failed");
    expect(result.error).toBe("Server rejected the workspace mutation");
    expect(result.primaryAction?.kind).toBe("retry");
  });

  test("admin setup takes precedence over member sign-in", () => {
    const result = lifecycle({
      components: [
        { ...cloudComponent, connectedForMe: false },
        { ...cloudComponent, configObjectId: "admin-object", connectionId: null, connectedForMe: false },
      ],
      imported: null,
      resolvedConfigObjectIds: ["cloud-object", "admin-object"],
    });
    expect(result.state).toBe("needs_admin");
  });

  test("readiness blockers take precedence over a generic partial import", () => {
    const needsAdmin = lifecycle({
      imported: imported({ status: "partial" }),
      components: [{ ...cloudComponent, connectionId: null, connectedForMe: false }],
    });
    expect(needsAdmin.state).toBe("needs_admin");
    expect(needsAdmin.primaryAction).toBeNull();

    const needsSignin = lifecycle({
      imported: imported({ status: "partial" }),
      components: [{ ...cloudComponent, connectedForMe: false }],
    });
    expect(needsSignin.state).toBe("needs_signin");
    expect(needsSignin.primaryAction?.kind).toBe("sign_in");
  });

  test("detects updates after readiness blockers and before current", () => {
    expect(lifecycle({ pendingChange: "modified" }).state).toBe("update_available");
    expect(lifecycle({ imported: imported({ updatedAt: "older" }) }).state).toBe("update_available");
    expect(lifecycle().state).toBe("current");
  });

  test("distinguishes not installed and partial desktop outcomes", () => {
    const notInstalled = lifecycle({ imported: null, components: [desktopComponent], resolvedConfigObjectIds: ["desktop-object"] });
    expect(notInstalled.state).toBe("not_installed");
    expect(notInstalled.delivery).toBe("desktop_only");

    const partial = lifecycle({
      imported: imported({ files: [] }),
      components: [cloudComponent, desktopComponent],
    });
    expect(partial.state).toBe("partial");
    expect(partial.delivery).toBe("mixed");
    expect(partial.components.find((component) => component.delivery === "desktop")?.state).toBe("not_installed");
  });

  test("treats cloud-only packages as current without a local import", () => {
    const result = lifecycle({ imported: null, components: [cloudComponent], resolvedConfigObjectIds: ["cloud-object"] });
    expect(result.state).toBe("current");
    expect(result.delivery).toBe("cloud_only");
    expect(result.components[0]?.state).toBe("current");
  });

  test("still installs workspace content bundled with a cloud component", () => {
    const result = lifecycle({
      imported: null,
      components: [cloudComponent],
      resolvedConfigObjectIds: ["cloud-object", "skill-object"],
    });
    expect(result.state).toBe("not_installed");
    expect(result.delivery).toBe("mixed");
  });

  test("classifies packages with only workspace content as desktop-only", () => {
    const result = lifecycle({ imported: null, components: [], resolvedConfigObjectIds: ["skill-object"] });
    expect(result.state).toBe("not_installed");
    expect(result.delivery).toBe("desktop_only");
  });

  test("classifies missing components from a newer release as an update", () => {
    const result = lifecycle({
      imported: imported({ updatedAt: "older", files: [] }),
      components: [desktopComponent],
      resolvedConfigObjectIds: ["desktop-object"],
    });
    expect(result.state).toBe("update_available");
  });

  test("uses persisted imported outcomes for cloud and desktop availability", () => {
    const result = lifecycle({
      imported: imported({
        files: [
          file({ configObjectId: "cloud-object", delivery: "cloud", outcome: "needs_signin", path: "cloud:service" }),
          file({ outcome: "failed", errorMessage: "runtime failed" }),
        ],
      }),
    });
    expect(result.state).toBe("failed");
    expect(result.components.map((component) => component.state)).toEqual(["needs_signin", "failed"]);
  });

  test("matches sibling server ledgers before config object fallback", () => {
    const sibling = { ...desktopComponent, serverName: "sibling-service" };
    const result = lifecycle({
      components: [desktopComponent, sibling],
      resolvedConfigObjectIds: [desktopComponent.configObjectId],
      imported: imported({
        files: [
          file({ componentKey: "desktop-object:desktop-service", serverName: "desktop-service" }),
          file({
            componentKey: "desktop-object:sibling-service",
            serverName: "sibling-service",
            outcome: "failed",
            errorMessage: "sibling failed",
          }),
        ],
      }),
    });
    expect(result.components.map((component) => component.state)).toEqual(["current", "failed"]);
  });

  test("still accepts an object-level legacy ledger when no per-server ledger exists", () => {
    const result = lifecycle({
      components: [desktopComponent],
      imported: imported({
        files: [file({ componentKey: "desktop-object", serverName: null })],
      }),
    });
    expect(result.components[0]?.state).toBe("current");
  });

  test("requires an actual local ledger for removal and force re-sync", () => {
    const cloudLedger = imported({
      files: [file({
        configObjectId: "cloud-object",
        componentKey: "cloud-object:cloud-service",
        serverName: "cloud-service",
        delivery: "cloud",
        outcome: "available_cloud",
      })],
    });
    const pureCloud = lifecycle({ imported: cloudLedger, components: [cloudComponent], resolvedConfigObjectIds: ["cloud-object"] });
    expect(hasMarketplacePluginLocalLedger(cloudLedger)).toBe(false);
    expect(pureCloud.hasLocalLedger).toBe(false);
    expect(pureCloud.secondaryAction).toBeNull();

    const local = imported();
    expect(hasMarketplacePluginLocalLedger(local)).toBe(true);
    expect(lifecycle({ imported: local }).secondaryAction?.kind).toBe("force_resync");
  });

  test("maps deterministic primary and secondary actions", () => {
    expect(resolveMarketplacePluginActions("not_installed").primaryAction?.kind).toBe("install");
    expect(resolveMarketplacePluginActions("update_available").primaryAction?.kind).toBe("update");
    expect(resolveMarketplacePluginActions("partial").primaryAction?.kind).toBe("continue");
    expect(resolveMarketplacePluginActions("failed").primaryAction?.kind).toBe("retry");
    expect(resolveMarketplacePluginActions("needs_signin").primaryAction).toEqual({ kind: "sign_in", mutatesWorkspace: false });
    expect(resolveMarketplacePluginActions("needs_admin").primaryAction).toBeNull();
    expect(resolveMarketplacePluginActions("repair_required").primaryAction?.kind).toBe("repair");
    expect(resolveMarketplacePluginActions("current", { hasLocalLedger: true })).toEqual({
      primaryAction: null,
      secondaryAction: { kind: "force_resync", mutatesWorkspace: true },
    });
    expect(resolveMarketplacePluginActions("current").secondaryAction).toBeNull();
  });

  test("disables unresolved workspace mutations without blocking sign-in", () => {
    expect(isMarketplacePluginActionDisabled(
      { kind: "install", mutatesWorkspace: true },
      { busy: false, canMutate: true, resolutionState: "unknown" },
    )).toBe(true);
    expect(isMarketplacePluginActionDisabled(
      { kind: "update", mutatesWorkspace: true },
      { busy: false, canMutate: true, resolutionState: "stale" },
    )).toBe(true);
    expect(isMarketplacePluginActionDisabled(
      { kind: "install", mutatesWorkspace: true },
      { busy: false, canMutate: true, resolutionState: "current" },
    )).toBe(false);
    expect(isMarketplacePluginActionDisabled(
      { kind: "sign_in", mutatesWorkspace: false },
      { busy: false, canMutate: false, resolutionState: "unknown" },
    )).toBe(false);
  });

  test("keys resolved data by organization, plugin identity, and published version", () => {
    expect(marketplaceResolvedCacheKey("org-1", plugin)).toBe("org-1:plugin-1:2026-08-30T12:00:00Z");
    expect(marketplaceResolvedCacheKey("org-2", plugin)).not.toBe(marketplaceResolvedCacheKey("org-1", plugin));
    expect(marketplaceResolvedCacheKey("org-1", { ...plugin, updatedAt: "new-version" }))
      .not.toBe(marketplaceResolvedCacheKey("org-1", plugin));
  });

  test("retains last-known-good version data and marks failed refreshes stale", () => {
    const oldPlugin = { ...plugin, updatedAt: "old-version" };
    const oldKey = marketplaceResolvedCacheKey("org-1", oldPlugin);
    const cached = resolveMarketplaceResolvedCache({ [oldKey]: { revision: "old" } }, "org-1", plugin);
    expect(cached.current).toBeNull();
    expect(cached.lastKnownGood).toEqual({ revision: "old" });
    expect(resolveMarketplaceDetailResolution({
      hasCurrent: false,
      hasLastKnownGood: true,
      resolving: false,
      hasError: true,
    })).toBe("stale");
    expect(resolveMarketplaceDetailResolution({
      hasCurrent: false,
      hasLastKnownGood: false,
      resolving: false,
      hasError: true,
    })).toBe("unknown");
    expect(resolveMarketplaceDetailResolution({
      hasCurrent: false,
      hasLastKnownGood: false,
      resolving: true,
      hasError: false,
    })).toBe("loading");
  });

  test("re-derives detail rows by stable identity and rejects workspace or organization switches", () => {
    const selection = { rowKey: "marketplace-1:plugin-1", organizationId: "org-1", workspaceKey: "workspace-1" };
    const original = { key: selection.rowKey, state: "not_installed" };
    const updated = { key: selection.rowKey, state: "current" };
    const getKey = (row: typeof original) => row.key;

    expect(resolveMarketplaceDetailSelection([updated], selection, {
      organizationId: "org-1",
      workspaceKey: "workspace-1",
    }, getKey)).toBe(updated);
    expect(resolveMarketplaceDetailSelection([original], selection, {
      organizationId: "org-2",
      workspaceKey: "workspace-1",
    }, getKey)).toBeNull();
    expect(resolveMarketplaceDetailSelection([original], selection, {
      organizationId: "org-1",
      workspaceKey: "workspace-2",
    }, getKey)).toBeNull();
  });
});
