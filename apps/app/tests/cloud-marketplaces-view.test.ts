import { describe, expect, mock, test } from "bun:test";

// This helper suite does not render the parent-owned detail page.
mock.module("@/react-app/domains/settings/pages/catalog-detail-page", () => ({ CatalogDetailPage: () => null }));
const {
  matchesMarketplaceFilters,
  selectMarketplaceRowsBySource,
  shouldIncludeCloudMarketplacePluginRow,
  shouldIncludeOrgMcpConnectionMarketplaceRow,
  shouldShowMarketplaceRows,
} = await import("../src/react-app/domains/settings/pages/cloud-marketplaces-view");
import { resolveMarketplacePluginLifecycle } from "../src/react-app/domains/settings/pages/marketplace-plugin-state";
import { readFileSync } from "node:fs";

describe("Cloud marketplace row visibility", () => {
  test("hides marketplace rows until a signed-in org is available", () => {
    expect(shouldShowMarketplaceRows(false, "org_1")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "   ")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "org_1")).toBe(true);
  });

  test("keeps Den organization plugins out of the embedded Extensions Marketplace pane", () => {
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: false })).toBe(true);
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: true })).toBe(false);
  });

  test("keeps organization MCP connections out of both Marketplace surfaces", () => {
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: false })).toBe(false);
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: true })).toBe(false);
  });
});

describe("Marketplace catalog sources", () => {
  const builtIn = { id: "public-builtin" };
  const cloudBuiltIn = { id: "org-builtin", extension: { sourceFormat: "jugglework-builtin" } };
  const cloud = { id: "org-plugin" };
  const personal = [{ id: "user-enabled-builtin" }, { id: "global-local-spec" }];
  const input = {
    isSignedIn: false,
    activeOrgId: "",
    builtInRows: [builtIn],
    cloudRows: [cloudBuiltIn, cloud],
    personalRows: personal,
    orgMcpRows: [{ id: "org-connection" }],
  };

  test("public needs no sign-in or organization and never reclassifies org built-ins", () => {
    expect(selectMarketplaceRowsBySource({ ...input, source: "public" })).toEqual([builtIn]);
    expect(selectMarketplaceRowsBySource({ ...input, source: "public", isSignedIn: true, activeOrgId: "org" })).toEqual([builtIn]);
  });

  test("organization contains only cloud rows behind the sign-in and org gates", () => {
    for (const [isSignedIn, activeOrgId] of [[false, "org"], [true, ""], [true, "  "]] as const) {
      expect(selectMarketplaceRowsBySource({ ...input, source: "organization", isSignedIn, activeOrgId })).toEqual([]);
    }
    expect(selectMarketplaceRowsBySource({ ...input, source: "organization", isSignedIn: true, activeOrgId: "org" })).toEqual([cloudBuiltIn, cloud]);
  });

  test("personal uses only parent-supplied installed inventory, regardless of org", () => {
    expect(selectMarketplaceRowsBySource({ ...input, source: "personal" })).toEqual(personal);
    expect(selectMarketplaceRowsBySource({ ...input, source: "personal", isSignedIn: true, activeOrgId: "org" })).toEqual(personal);
    expect(selectMarketplaceRowsBySource({ ...input, source: "personal", personalRows: [] })).toEqual([]);
  });

  test("no-source keeps the legacy sign-in gate, mixed catalog, and skills filter", () => {
    expect(selectMarketplaceRowsBySource(input)).toEqual([]);
    const signedIn = { ...input, isSignedIn: true, activeOrgId: "org" };
    expect(selectMarketplaceRowsBySource(signedIn)).toEqual([builtIn, cloudBuiltIn, cloud, ...input.orgMcpRows]);
    expect(selectMarketplaceRowsBySource({ ...signedIn, skillsOnly: true })).toEqual([cloudBuiltIn, cloud]);
  });
});

describe("Dedicated plugin catalog refresh lifecycle", () => {
  const source = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
  const hostProviderSource = readFileSync(new URL("../src/react-app/domains/settings/state/host-marketplace-plugins-provider.tsx", import.meta.url), "utf8");
  const marketplaceSource = readFileSync(new URL("../src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx", import.meta.url), "utf8");
  const detailSource = readFileSync(new URL("../src/react-app/domains/settings/pages/marketplace-package-detail-modal.tsx", import.meta.url), "utf8");

  test("passes a stable organization connector refresh callback", () => {
    const catalogBranch = source.slice(
      source.indexOf("if (props.pluginCatalogOnly)"),
      source.indexOf("// TIPS: 仅会话右侧 rail", source.indexOf("if (props.pluginCatalogOnly)")),
    );
    expect(catalogBranch).toContain("refreshOrgMcpConnections={orgMcpConnections.refresh}");
    expect(catalogBranch).not.toContain("refreshOrgMcpConnections={() => orgMcpConnections.refresh()}");
  });

  test("uses application catalog mode inside global customization navigation", () => {
    const catalogBranch = source.slice(
      source.indexOf("if (props.pluginCatalogOnly)"),
      source.indexOf("// TIPS: 仅会话右侧 rail", source.indexOf("if (props.pluginCatalogOnly)")),
    );
    expect(catalogBranch).toContain("applicationCatalog");
    expect(source).toContain("CustomizationCatalogSidebar");
    expect(source).toContain("globalCustomizationInstalledItems");
    expect(source).not.toContain("plugins: extensionsSnapshot.importedCloudPlugins");
  });

  test("uses host installation actions behind the application catalog boundary", () => {
    expect(marketplaceSource).toContain("const workspaceImportedPlugins = extensions.importedCloudPlugins()");
    expect(marketplaceSource).toContain("const importedPlugins = applicationCatalogMode ? {} : workspaceImportedPlugins");
    expect(marketplaceSource).toContain("applicationCatalogMode ? hostCanWrite : marketplacePluginAccess.allowed");
    expect(marketplaceSource).toContain("onInstallPlugin={applicationCatalogMode ? putHostPlugin : installPlugin}");
    expect(marketplaceSource).toContain("const resolved = await client.getOrgPluginResolved(activeOrgId, plugin)");
    expect(marketplaceSource).toContain("hostMarketplacePackageRequiresExecutableConfirmation");
    expect(marketplaceSource).toContain("aria-label={t(\"marketplace.install_plugin\")}");
    expect(marketplaceSource).toContain("aria-label={t(\"marketplace.plugin_actions\")}");
    expect(detailSource).toContain("row.imported && !cloudBuiltIn && props.onRemovePlugin");
    expect(detailSource).toContain("!applicationPage ? <div className=\"mt-3");
    expect(detailSource).toContain("marketplace.host_component_availability_description");
  });

  test("keeps removed-upstream workspace cleanup out of the standalone catalog", () => {
    expect(marketplaceSource).toContain("() => applicationCatalogMode\n      ? []");
    expect(marketplaceSource).toContain("standalone application catalog must not leak");
  });

  test("integrates one stable host controller keyed by host and Cloud identity, never workspace id", () => {
    expect(hostProviderSource).toContain("controllersRef");
    expect(hostProviderSource).toContain("controllerContext");
    expect(hostProviderSource).toContain("controllersRef.current.get(controllerContext)");
    expect(hostProviderSource).toContain("useSyncExternalStore(");
    expect(hostProviderSource).toContain("controlPlaneOrigin: new URL(cloudSession.baseUrl).origin");
    expect(hostProviderSource).toContain("hostMarketplacePluginsKey(hostBaseUrl, scope)");
    expect(source).toContain("hostInstallations: hostMarketplaceSnapshot.registry?.installations ?? []");
    expect(source).toContain("workspaceKey={hostCatalogKey}");
    expect(hostProviderSource).toContain("controller.loadScope(scope)");
    expect(hostProviderSource).toContain("controller.ensureScope(scope)");
    expect(hostProviderSource).toContain("controller.clear()");
  });

  test("guards direct remote OpenCode before constructing or using the host registry", () => {
    expect(hostProviderSource).toContain("const supported = supportsHostMarketplaceWorkspace(target)");
    expect(hostProviderSource).toContain("if (!target || !supported || !hostBaseUrl || !scope) return null");
    expect(hostProviderSource).toContain("if (!supportedRef.current) {");
    expect(hostProviderSource).toContain("controller.abandon()");
    expect(source).toContain("errorHint={hostMarketplaceErrorHint}");
    expect(marketplaceSource).toContain("{showsOrganization && errorHint ? (");
    expect(marketplaceSource).toContain("accessHint={errorHint ?? marketplacePluginAccessHint}");
  });
});

describe("Application plugin catalog lifecycle", () => {
  const plugin = {
    updatedAt: "2026-10-12T00:00:00Z",
    memberCount: 1,
    componentCounts: { skill: 1 },
    cloudReadiness: { state: "ready" as const, components: [], connections: [] },
  };

  test("reports a Connect-ready plugin as current without a workspace ledger", () => {
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin,
      imported: null,
      components: [],
      catalogMode: true,
    });
    expect(lifecycle.state).toBe("current");
    expect(lifecycle.hasLocalLedger).toBe(false);
    expect(lifecycle.primaryAction).toBeNull();
  });

  test("standalone installation mode requires an explicit record for a Cloud-ready plugin", () => {
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin,
      imported: null,
      components: [],
      requireInstallRecord: true,
    });
    expect(lifecycle.state).toBe("not_installed");
    expect(lifecycle.primaryAction).toEqual({ kind: "install", mutatesWorkspace: true });
  });

  test("keeps sign-in available but never offers workspace installation", () => {
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin: { ...plugin, cloudReadiness: { state: "needs_signin" as const, components: [], connections: [] } },
      imported: null,
      components: [],
      catalogMode: true,
    });
    expect(lifecycle.state).toBe("needs_signin");
    expect(lifecycle.primaryAction).toEqual({ kind: "sign_in", mutatesWorkspace: false });
    expect(lifecycle.secondaryAction).toBeNull();
  });

  test("does not claim desktop-only plugin components are globally installed", () => {
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin: {
        ...plugin,
        componentCounts: { hook: 1 },
        cloudReadiness: { state: "desktop_only" as const, components: [], connections: [] },
      },
      imported: null,
      components: [],
      catalogMode: true,
    });
    expect(lifecycle.state).toBe("not_installed");
    expect(lifecycle.primaryAction).toBeNull();
  });

  test("does not claim unsynced or unverified cloud MCP components are ready", () => {
    for (const cloudReadiness of [
      { state: "not_synced" as const, components: [], connections: [] },
      undefined,
    ]) {
      const lifecycle = resolveMarketplacePluginLifecycle({
        plugin: {
          ...plugin,
          componentCounts: { mcp: 1 },
          cloudReadiness,
        },
        imported: null,
        components: [{
          configObjectId: "mcp_1",
          serverName: "docs",
          delivery: "cloud",
          url: "https://example.com/mcp",
        }],
        catalogMode: true,
      });
      expect(lifecycle.state).toBe("not_installed");
      expect(lifecycle.primaryAction).toBeNull();
    }
  });
});

describe("Marketplace search and filters", () => {
  const row = {
    marketplaceId: "mk_1",
    status: "available" as const,
    searchableText: "desktop marketplace compatibility test 1 skill",
  };
  const noFilters = { search: "", statusFilter: "all" as const, marketplaceFilter: "all" };

  test("keeps every row when no query or filter is set", () => {
    expect(matchesMarketplaceFilters(row, noFilters)).toBe(true);
  });

  test("matches the query case-insensitively and ignores surrounding spaces", () => {
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "Compatibility" })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "  DESKTOP  " })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "notion" })).toBe(false);
  });

  test("applies status and marketplace filters alongside the query", () => {
    expect(matchesMarketplaceFilters(row, { ...noFilters, statusFilter: "installed" })).toBe(false);
    expect(matchesMarketplaceFilters(row, { ...noFilters, statusFilter: "available" })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, marketplaceFilter: "mk_2" })).toBe(false);
    expect(matchesMarketplaceFilters(row, { ...noFilters, marketplaceFilter: "mk_1", search: "skill" })).toBe(true);
  });
});
