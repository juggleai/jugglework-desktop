/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { t } from "../src/i18n";
import { writeDenSettings } from "../src/app/lib/den";
import { JUGGLEWORK_EXTENSION_CATALOG } from "../src/app/constants";
import { CloudSessionProvider, useCloudSession } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import type { CloudMarketplacesViewProps } from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";
import type { HostMarketplacePluginsSnapshot } from "../src/react-app/domains/settings/state/host-marketplace-plugins";
import { HostMarketplaceMigrationRequiredError } from "../src/react-app/domains/settings/state/host-marketplace-plugins";
import { JuggleWorkServerError, hostMarketplacePackageFromDenResolved, type JuggleWorkHostMarketplaceMigrationPlan } from "../src/app/lib/jugglework-server";
import type { ReactNode } from "react";

const info = mock(() => {});
const success = mock(() => {});
const warning = mock(() => {});
const confirmExecutable = mock(() => true);
let cloud: ReturnType<typeof useCloudSession>;
function SessionProbe() {
  cloud = useCloudSession();
  return null;
}
mock.module("../src/components/ui/sonner", () => ({ toast: { info, success, warning, error: mock(() => {}) } }));
mock.module("../src/react-app/design-system/extension-card", () => ({
  ExtensionCard: (props: { name: string; onClick: () => void; disabled?: boolean }) => <button disabled={props.disabled} onClick={props.onClick}>{props.name}</button>,
}));
mock.module("@/react-app/domains/settings/pages/catalog-detail-page", () => ({
  CatalogDetailPage: ({ name, description, onBack, actions, children }: { name: string; description?: string; onBack: () => void; actions?: ReactNode; children: ReactNode }) => (
    <section data-testid="detail-page"><button onClick={onBack}>Back</button><h1>{name}</h1>{description ? <p>{description}</p> : null}{actions}{children}</section>
  ),
}));
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: box, DialogHeader: box, DialogDescription: box, DialogFooter: box,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module("../src/components/ui/scroll-area", () => ({ ScrollArea: box, ScrollAreaViewport: box, ScrollAreaContent: box }));
mock.module("../src/react-app/domains/session/surface/markdown", () => ({ MarkdownBlock: () => null }));
mock.module("../src/react-app/shell/notifications", () => ({
  drainPendingMarketplacePlugin: () => null,
  openMarketplacePluginEvent: "test-open-marketplace",
}));
const { CloudMarketplacesView, requestBuiltInEnabled } = await import("../src/react-app/domains/settings/pages/cloud-marketplaces-view");
const { CatalogHeader } = await import("../src/react-app/domains/settings/pages/catalog-source");
const { ExtensionDetailModal } = await import("../src/react-app/design-system/extension-detail-modal");
const { ExtensionCard } = await import("../src/react-app/design-system/extension-card");
const { MarketplacePackageDetailModal } = await import("../src/react-app/domains/settings/pages/marketplace-package-detail-modal");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let renderer: TestRenderer.ReactTestRenderer | undefined;
let props: CloudMarketplacesViewProps;
let load: () => Promise<unknown>;
const refresh = mock(() => load());
const sync = mock(() => {});
const connectors = mock(async () => {});
const sourceChange = mock(() => {});
const plugins = [{
  id: "org-builtin",
  name: "Organization built-in",
  description: "Organization-only plugin",
  componentCounts: {},
  extension: { sourceFormat: "jugglework-builtin" },
}] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;

beforeEach(async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      confirm: confirmExecutable,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    }),
  });
  writeDenSettings({ baseUrl: "https://cloud.example.test", authToken: "test-token", activeOrgId: "org-a", activeOrgName: "Team A", activeOrgSlug: "team-a" });
  // Use real context state so this suite cannot replace another suite's provider.
  await act(async () => {
    renderer = TestRenderer.create(<CloudSessionProvider><SessionProbe /></CloudSessionProvider>);
  });
  await act(async () => {
    cloud.setIsSignedIn(true);
    cloud.setUser({ id: "user", email: "test@example.test", name: "Test" });
  });
  load = async () => {};
  for (const fn of [info, success, warning, confirmExecutable, refresh, sync, connectors, sourceChange]) fn.mockClear();
  props = {
    source: "public",
    onSourceChange: sourceChange,
    organizationName: "Supplied team",
    applicationCatalog: true,
    workspaceKey: "workspace",
    onOpenAccount: () => {},
    session: { syncCurrentDenSettings: sync },
    refreshOrgMcpConnections: connectors,
    builtInEntries: [{ id: "public", name: "Public built-in", description: "Public description", oauth: false }],
    personalPlugins: [
      { id: "enabled", name: "User-enabled built-in" },
      { id: "local", name: "Global local spec", description: "Environment plugin" },
    ],
    extensions: {
      cloudOrgPlugins: () => plugins,
      cloudOrgMarketplacesStatus: () => "Organization readiness failed",
      importedCloudPlugins: () => ({}),
      pendingCloudPluginChanges: () => ({}),
      marketplacePluginOperations: () => ({}),
      marketplacePluginAccess: () => ({ allowed: false, reason: "read_only" }),
      refreshCloudOrgMarketplaces: refresh,
      importCloudOrgPlugin: mock(async () => { throw new Error("Must not install"); }),
      removeCloudOrgPlugin: mock(async () => { throw new Error("Must not remove"); }),
    },
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
async function render(next: Partial<CloudMarketplacesViewProps> = {}) {
  props = { ...props, ...next };
  await act(async () => {
    renderer!.update(<CloudSessionProvider><SessionProbe /><CloudMarketplacesView {...props} /></CloudSessionProvider>);
  });
}
const text = () => JSON.stringify(renderer!.toJSON());
const header = () => renderer!.root.findByType(CatalogHeader);
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function hostSnapshot(input: {
  write?: boolean;
  installations?: NonNullable<HostMarketplacePluginsSnapshot["registry"]>["installations"];
} = {}): HostMarketplacePluginsSnapshot {
  const write = input.write ?? true;
  const scope = { controlPlaneOrigin: "https://cloud.example.test", userId: "user", organizationId: "org-a" };
  return {
    key: "host-key",
    scope,
    environment: {
      schemaVersion: 1,
      environmentId: "host-1",
      managed: true,
      readOnly: !write,
      capability: { read: true, write },
    },
    registry: {
      schemaVersion: 1,
      registryRevision: 1,
      scope: { ...scope, environmentId: "host-1" },
      active: true,
      installations: input.installations ?? [],
    },
    writable: write,
    status: "ready",
    operation: null,
    error: null,
  };
}

function hostCatalog(input: Parameters<typeof hostSnapshot>[0] = {}) {
  return {
    snapshot: hostSnapshot(input),
    put: mock(async () => null),
    migrate: mock(async () => null),
    delete: mock(async () => {}),
    refresh: mock(async () => hostSnapshot(input)),
  };
}

function migrationPlan(input: { migratable?: boolean; blocker?: boolean } = {}): JuggleWorkHostMarketplaceMigrationPlan {
  const blocker = { workspaceId: "workspace-b", code: "modified_file", resource: ".opencode/hooks/b.json", message: "modified" };
  return {
    pluginId: "desktop-plugin",
    packageDigest: "package-digest",
    registryRevision: 1,
    workspaces: [
      { workspaceId: "workspace-a", label: "Alpha workspace", path: "/alpha", recordDigest: "digest-a", resources: [{ kind: "file", target: "a", digest: "a" }], blockers: [], migratable: true },
      { workspaceId: "workspace-b", label: "Beta workspace", path: "/beta", recordDigest: "digest-b", resources: [{ kind: "file", target: "b", digest: "b" }, { kind: "mcp", target: "service", digest: "c" }], blockers: input.blocker ? [{ code: blocker.code, resource: blocker.resource, message: blocker.message }] : [], migratable: !input.blocker },
    ],
    blockers: input.blocker ? [blocker] : [],
    migratable: input.migratable ?? !input.blocker,
    fingerprint: "fingerprint",
    migrationToken: "token",
  };
}

function resolvedDesktopPlugin(plugin: ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>[number]) {
  return {
    plugin,
    memberships: [{
      id: "membership-hook",
      pluginId: plugin.id,
      configObjectId: "hook-1",
      configObject: {
        id: "hook-1",
        objectType: "hook" as const,
        title: "Desktop hook",
        description: null,
        currentFileName: "hook.json",
        currentFileExtension: "json",
        currentRelativePath: ".opencode/hooks/hook.json",
        status: "active",
        updatedAt: null,
        latestVersion: {
          id: "hook-version-1",
          rawSourceText: "{}",
          normalizedPayloadJson: null,
          sourceRevisionRef: null,
          createdAt: null,
        },
      },
    }],
  };
}

describe("Marketplace source surfaces", () => {
  test("public is available signed out, without org status, sync, or legacy filters", async () => {
    await act(async () => {
      cloud.setIsSignedIn(false);
      cloud.setActiveOrganization(null);
    });
    await render({ builtInExtensionsDisabled: true });
    expect(text()).toContain("Public built-in");
    expect(text()).not.toContain("Organization built-in");
    expect(text()).not.toContain("Global local spec");
    expect(text()).not.toContain("Organization readiness failed");
    expect(text()).not.toContain(t("marketplace.signin_hint"));
    expect(text()).not.toContain(t("marketplace.filter_all"));
    expect(header().props.description).toBe(t("customization.public_description"));
    expect(header().props.organizationName).toBe("Supplied team");
    expect(renderer!.root.findAllByType("button").find((button) => button.children.includes("Public built-in"))!.props.disabled).toBe(true);
    await act(async () => header().props.onRefresh());
    expect(refresh).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => header().props.onSourceChange("personal"));
    expect(sourceChange).toHaveBeenCalledWith("personal");
    await act(async () => renderer!.root.findByType("input").props.onChange({ currentTarget: { value: "missing" } }));
    expect(text()).toContain(t("marketplace.no_match"));
  });

  test("personal is read-only parent inventory and has a signed-out empty state", async () => {
    await act(async () => cloud.setIsSignedIn(false));
    await render({ source: "personal" });
    expect(text()).toContain("User-enabled built-in");
    expect(text()).toContain("Global local spec");
    expect(text()).not.toContain("Organization built-in");
    expect(text()).not.toContain("Public built-in");
    expect(text()).not.toContain("Organization readiness failed");
    expect(text()).not.toContain(t("marketplace.signin_hint"));
    // Refresh, source tabs, two detail cards, and one installed-actions trigger per card.
    expect(renderer!.root.findAllByType("button")).toHaveLength(8);
    expect(props.extensions.importCloudOrgPlugin).not.toHaveBeenCalled();
    await render({ personalPlugins: [] });
    expect(text()).toContain(t("customization.empty_source"));
  });

  test("shows Add for an uninstalled host package, resolves the latest Den details, and confirms executable content", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin",
      name: "Desktop plugin",
      description: "Needs workspace installation",
      memberCount: 1,
      updatedAt: "2026-10-14T00:00:00Z",
      status: "active",
      componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const resolved = resolvedDesktopPlugin(marketplacePlugin[0]!);
    const resolvePlugin = mock(async () => resolved);
    cloud.client.getOrgPluginResolved = resolvePlugin as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog();
    await render({
      source: "organization",
      applicationCatalog: host,
      extensions: {
        ...props.extensions,
        cloudOrgPlugins: () => marketplacePlugin,
      },
    });
    const add = renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") });
    await act(async () => add.props.onClick({ stopPropagation: () => {} }));
    expect(resolvePlugin).toHaveBeenCalledTimes(1);
    expect(confirmExecutable).toHaveBeenCalledWith(t("marketplace.host_executable_confirm", { name: "Desktop plugin" }));
    expect(host.put).toHaveBeenCalledWith("organization-plugins", resolved, { confirmExecutable: true });
    expect(props.extensions.importCloudOrgPlugin).not.toHaveBeenCalled();
    expect(text()).not.toContain("detail-page");
  });

  test("cancels workspace-copy migration without commit or optimistic mutation", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin", name: "Desktop plugin", description: "Local copies", memberCount: 1,
      updatedAt: "revision-1", status: "active", componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const resolved = resolvedDesktopPlugin(marketplacePlugin[0]!);
    cloud.client.getOrgPluginResolved = mock(async () => resolved) as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog();
    const plan = migrationPlan();
    const packageInput = { ...hostMarketplacePackageFromDenResolved("organization-plugins", resolved), confirmedExecutableRevision: "revision-1" };
    host.put.mockImplementation(async () => { throw new HostMarketplaceMigrationRequiredError({ scope: host.snapshot.scope!, package: packageInput, plan }); });
    confirmExecutable.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });
    const refreshCallsBeforeCancel = host.refresh.mock.calls.length;

    await act(async () => renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") }).props.onClick({ stopPropagation: () => {} }));

    expect(confirmExecutable).toHaveBeenCalledTimes(2);
    expect(confirmExecutable.mock.calls[1]?.[0]).toContain("Alpha workspace: 1 local resource");
    expect(confirmExecutable.mock.calls[1]?.[0]).toContain("Beta workspace: 2 local resources");
    expect(confirmExecutable.mock.calls[1]?.[0]).toContain("All local copies listed above will be removed");
    expect(host.migrate).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalledTimes(refreshCallsBeforeCancel);
    expect(success).not.toHaveBeenCalled();
    expect(text()).not.toContain(t("marketplace.host_migration_failed"));
  });

  test("confirms and commits all workspace copies before reporting a global migration", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin", name: "Desktop plugin", description: "Local copies", memberCount: 1,
      updatedAt: "revision-1", status: "active", componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const resolved = resolvedDesktopPlugin(marketplacePlugin[0]!);
    cloud.client.getOrgPluginResolved = mock(async () => resolved) as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog();
    const plan = migrationPlan();
    const request = {
      scope: host.snapshot.scope!,
      package: { ...hostMarketplacePackageFromDenResolved("organization-plugins", resolved), confirmedExecutableRevision: "revision-1" },
      plan,
    };
    host.put.mockImplementation(async () => { throw new HostMarketplaceMigrationRequiredError(request); });
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });

    await act(async () => renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") }).props.onClick({ stopPropagation: () => {} }));

    expect(host.migrate).toHaveBeenCalledWith(request);
    expect(success).toHaveBeenCalledWith(t("marketplace.host_migration_success", { name: "Desktop plugin" }));
    expect(success).not.toHaveBeenCalledWith(t("marketplace.host_install_success", { name: "Desktop plugin" }));
  });

  test("shows localized migration blockers and never asks to commit", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin", name: "Desktop plugin", description: "Blocked copy", memberCount: 1,
      updatedAt: "revision-1", status: "active", componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const resolved = resolvedDesktopPlugin(marketplacePlugin[0]!);
    cloud.client.getOrgPluginResolved = mock(async () => resolved) as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog();
    const plan = migrationPlan({ blocker: true });
    const packageInput = { ...hostMarketplacePackageFromDenResolved("organization-plugins", resolved), confirmedExecutableRevision: "revision-1" };
    host.put.mockImplementation(async () => { throw new HostMarketplaceMigrationRequiredError({ scope: host.snapshot.scope!, package: packageInput, plan }); });
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });

    await act(async () => renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") }).props.onClick({ stopPropagation: () => {} }));

    expect(confirmExecutable).toHaveBeenCalledTimes(1);
    expect(host.migrate).not.toHaveBeenCalled();
    expect(text()).toContain(t("marketplace.host_migration_blocked"));
    expect(text()).toContain("Beta workspace");
    expect(text()).toContain(t("marketplace.host_migration_blocker_file", { resource: ".opencode/hooks/b.json" }));
  });

  test("reports a stale migration safely and does not claim success", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin", name: "Desktop plugin", description: "Stale copy", memberCount: 1,
      updatedAt: "revision-1", status: "active", componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const resolved = resolvedDesktopPlugin(marketplacePlugin[0]!);
    cloud.client.getOrgPluginResolved = mock(async () => resolved) as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog();
    const request = {
      scope: host.snapshot.scope!,
      package: { ...hostMarketplacePackageFromDenResolved("organization-plugins", resolved), confirmedExecutableRevision: "revision-1" },
      plan: migrationPlan(),
    };
    host.put.mockImplementation(async () => { throw new HostMarketplaceMigrationRequiredError(request); });
    host.migrate.mockImplementation(async () => { throw new JuggleWorkServerError(409, "host_marketplace_migration_plan_stale", "stale"); });
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });

    await act(async () => renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") }).props.onClick({ stopPropagation: () => {} }));

    expect(host.migrate).toHaveBeenCalledWith(request);
    expect(text()).toContain(t("marketplace.host_migration_stale"));
    expect(success).not.toHaveBeenCalled();
  });

  test("does not expose Add for pure Cloud packages or read-only host discovery", async () => {
    const pureCloud = [{
      id: "cloud-only",
      name: "Cloud only",
      description: "Runs in Connect",
      memberCount: 1,
      updatedAt: "2026-10-14T00:00:00Z",
      status: "active",
      componentCounts: { mcp: 1 },
      cloudReadiness: {
        state: "ready",
        hasInstructional: false,
        connections: [],
        components: [{ configObjectId: "mcp-1", serverName: "cloud", delivery: "cloud", url: "https://example.test/mcp" }],
      },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    await render({ source: "organization", applicationCatalog: hostCatalog(), extensions: { ...props.extensions, cloudOrgPlugins: () => pureCloud } });
    expect(renderer!.root.findAllByProps({ "aria-label": t("marketplace.install_plugin") })).toHaveLength(0);

    const desktop = [{ ...pureCloud[0]!, id: "desktop-only", name: "Desktop only", componentCounts: { hook: 1 }, cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] } }] as unknown as typeof pureCloud;
    await render({ applicationCatalog: hostCatalog({ write: false }), extensions: { ...props.extensions, cloudOrgPlugins: () => desktop } });
    expect(renderer!.root.findAllByProps({ "aria-label": t("marketplace.install_plugin") })).toHaveLength(0);
  });

  test("keeps organization discovery visible without Add when host integration is unavailable", async () => {
    const desktop = [{
      ...plugins[0],
      id: "unsupported-host-plugin",
      name: "Unsupported host plugin",
      extension: { ...plugins[0].extension, sourceFormat: "opencode-plugin" },
      componentCounts: { hook: 1 },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const errorHint = t("marketplace.managed_host_unsupported");

    await render({
      source: "organization",
      applicationCatalog: true,
      errorHint,
      extensions: { ...props.extensions, cloudOrgPlugins: () => desktop },
    });

    expect(text()).toContain("Unsupported host plugin");
    expect(text()).toContain(errorHint);
    expect(renderer!.root.findAllByProps({ "aria-label": t("marketplace.install_plugin") })).toHaveLength(0);
  });

  test("uses host installation records for overflow and removes through the host", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin",
      name: "Desktop plugin",
      description: "Installed globally",
      memberCount: 1,
      updatedAt: "revision-1",
      status: "active",
      componentCounts: { skill: 1 },
      cloudReadiness: { state: "desktop_only", hasInstructional: true, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const host = hostCatalog({ installations: [{
      pluginId: "desktop-plugin",
      marketplaceId: "organization-plugins",
      name: "Desktop plugin",
      description: "Installed globally",
      packageRevision: "revision-1",
      packageDigest: "digest",
      status: "installed",
      resources: [],
      installedAt: 1,
      updatedAt: 1,
    }] });
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });
    expect(renderer!.root.findAllByProps({ "aria-label": t("marketplace.plugin_actions") }).length).toBeGreaterThan(0);
    expect(renderer!.root.findAllByProps({ "aria-label": t("marketplace.install_plugin") })).toHaveLength(0);
    await act(async () => renderer!.root.findByType(ExtensionCard).props.onClick());
    await act(async () => renderer!.root.findByType(MarketplacePackageDetailModal).props.onRemovePlugin("desktop-plugin", "Desktop plugin"));
    expect(confirmExecutable).toHaveBeenCalledWith(t("marketplace.host_uninstall_confirm", { name: "Desktop plugin", count: 0 }));
    expect(host.delete).toHaveBeenCalledWith("desktop-plugin");
    expect(props.extensions.removeCloudOrgPlugin).not.toHaveBeenCalled();
  });

  test("cancels host uninstall before deleting or entering a busy state", async () => {
    const marketplacePlugin = [{
      id: "desktop-plugin",
      name: "Desktop plugin",
      description: "Installed globally",
      memberCount: 1,
      updatedAt: "revision-1",
      status: "active",
      componentCounts: { hook: 1 },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const host = hostCatalog({ installations: [{
      pluginId: "desktop-plugin",
      marketplaceId: "organization-plugins",
      name: "Desktop plugin",
      description: "Installed globally",
      packageRevision: "revision-1",
      packageDigest: "digest",
      status: "installed",
      resources: [{ kind: "file", componentId: "hook-1", target: ".opencode/hooks/hook.json", digest: "resource-digest" }],
      installedAt: 1,
      updatedAt: 1,
    }] });
    confirmExecutable.mockReturnValueOnce(false);
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });
    await act(async () => renderer!.root.findByType(ExtensionCard).props.onClick());
    await act(async () => renderer!.root.findByType(MarketplacePackageDetailModal).props.onRemovePlugin("desktop-plugin", "Desktop plugin"));
    expect(confirmExecutable).toHaveBeenCalledWith(t("marketplace.host_uninstall_confirm", { name: "Desktop plugin", count: 1 }));
    expect(host.delete).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(MarketplacePackageDetailModal).props.lifecycle.state).toBe("current");
  });

  test("renders a removed-catalog installation from the host registry and uninstalls without Den resolution", async () => {
    const resolvePlugin = mock(async () => { throw new Error("Removed plugins cannot resolve"); });
    cloud.client.getOrgPluginResolved = resolvePlugin as typeof cloud.client.getOrgPluginResolved;
    const host = hostCatalog({ installations: [{
      pluginId: "removed-plugin",
      marketplaceId: "retired-marketplace",
      name: "Recorded plugin name",
      description: "Recorded registry description",
      packageRevision: "recorded-revision-7",
      packageDigest: "digest",
      status: "repair_required",
      resources: [
        { kind: "file", componentId: "hook-1", target: ".opencode/hooks/removed.json", digest: "file-digest" },
        { kind: "mcp", componentId: "mcp-1", target: "removed-server", digest: "mcp-digest" },
      ],
      installedAt: 1,
      updatedAt: 2,
      repair: { operation: "install", cause: "Recorded repair cause", resources: ["removed-server"], recordedAt: 2 },
    }] });
    await render({
      source: "organization",
      applicationCatalog: host,
      extensions: { ...props.extensions, cloudOrgPlugins: () => [] },
      detailRequest: { id: "cloud-plugin:removed-plugin", nonce: 1 },
    });

    expect(text()).toContain("Recorded plugin name");
    expect(text()).toContain("Recorded registry description");
    expect(text()).toContain("recorded-revision-7");
    expect(text()).toContain("Recorded repair cause");
    expect(text()).toContain(".opencode/hooks/removed.json");
    expect(text()).toContain("removed-server");
    expect(resolvePlugin).not.toHaveBeenCalled();

    const uninstall = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.uninstall_plugin")))!;
    await act(async () => uninstall.props.onClick());
    expect(confirmExecutable).toHaveBeenCalledWith(t("marketplace.host_uninstall_confirm", { name: "Recorded plugin name", count: 2 }));
    expect(host.delete).toHaveBeenCalledWith("removed-plugin");
    expect(resolvePlugin).not.toHaveBeenCalled();
  });

  test("does not duplicate a host installation when the Den catalog still contains the plugin", async () => {
    const marketplacePlugin = [{
      ...plugins[0],
      id: "same-plugin",
      name: "Catalog plugin",
      description: "Catalog description",
      componentCounts: { hook: 1 },
      extension: { sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    const host = hostCatalog({ installations: [{
      pluginId: "same-plugin",
      marketplaceId: "organization-plugins",
      name: "Stale recorded name",
      description: "Stale recorded description",
      packageRevision: "revision-1",
      packageDigest: "digest",
      status: "installed",
      resources: [],
      installedAt: 1,
      updatedAt: 1,
    }] });
    await render({ source: "organization", applicationCatalog: host, extensions: { ...props.extensions, cloudOrgPlugins: () => marketplacePlugin } });

    expect(renderer!.root.findAllByType(ExtensionCard)).toHaveLength(1);
    expect(renderer!.root.findByType(ExtensionCard).props.name).toBe("Catalog plugin");
    expect(text()).not.toContain("Stale recorded name");
  });

  test("public built-ins are installed actions, never Add actions", async () => {
    await render({ setBuiltInEnabled: mock(() => {}) });
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons.filter((button) => button.props["aria-label"] === t("marketplace.plugin_actions"))).toHaveLength(1);
    expect(buttons.filter((button) => button.props["aria-label"] === t("marketplace.install_plugin"))).toHaveLength(0);
    expect(renderer!.root.findByType(ExtensionCard).props.connected).toBe(false);
    expect(renderer!.root.findByType(ExtensionCard).props.statusBadge).toBe("icon-only");
  });

  test("Add and overflow plugin actions use the same top-right geometry", async () => {
    const desktopPlugin = [{
      ...plugins[0], id: "available-plugin", name: "Available plugin",
      extension: { ...plugins[0].extension, sourceFormat: "opencode-plugin" },
      componentCounts: { hook: 1 },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as ReturnType<CloudMarketplacesViewProps["extensions"]["cloudOrgPlugins"]>;
    await render({ source: "organization", applicationCatalog: hostCatalog(), extensions: { ...props.extensions, cloudOrgPlugins: () => desktopPlugin } });
    const add = renderer!.root.findByProps({ "aria-label": t("marketplace.install_plugin") });
    const addClassName = add.props.className;
    expect(add.parent?.props.className).toContain("absolute right-2.5 top-2.5");
    expect(add.parent?.props.className).toContain("size-8");

    await render({ source: "public" });
    const overflow = renderer!.root.findByProps({ "aria-label": t("marketplace.plugin_actions") });
    const overflowContainer = renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("absolute right-2.5 top-2.5") && node.findAllByProps({ "aria-label": t("marketplace.plugin_actions") }).length > 0)[0];
    expect(overflowContainer?.props.className).toContain("absolute right-2.5 top-2.5");
    expect(overflowContainer?.props.className).toContain("size-8");
    expect(overflow.props.className).toBe(addClassName);
  });

  test("application catalog omits redundant delivery copy for desktop organization plugins", async () => {
    const desktopPlugin = [{
      ...plugins[0],
      id: "desktop-plugin",
      name: "Desktop plugin",
      extension: { ...plugins[0].extension, sourceFormat: "opencode-plugin" },
      cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [], components: [] },
    }] as unknown as typeof plugins;
    await render({ source: "organization", extensions: { ...props.extensions, cloudOrgPlugins: () => desktopPlugin } });
    const card = renderer!.root.findByType(ExtensionCard);
    expect(card.props.actionLabel).not.toBe(t("marketplace.delivery_desktop_only"));
    expect(card.props.actionLabel).toBeUndefined();
  });

  test("an unready built-in Enable menu action opens its detail page and explains the missing setup", async () => {
    const voice = JUGGLEWORK_EXTENSION_CATALOG.find((entry) => entry.id === "jugglework-voice")!;
    const setEnabled = mock(() => {});
    const openDetail = mock(() => {});
    requestBuiltInEnabled({
      source: "built-in",
      marketplaceId: "jugglework-builtins",
      marketplaceName: "JuggleWork Built-ins",
      entry: voice,
      status: "installed",
      active: false,
      setupReady: false,
      unmetRequirements: ["OpenAI API key"],
      searchableText: "voice mode",
    }, true, setEnabled, openDetail);

    expect(openDetail).toHaveBeenCalledTimes(1);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test("organization gates cloud rows and does not mix in public or personal inventory", async () => {
    await act(async () => cloud.setIsSignedIn(false));
    await render({ source: "organization" });
    expect(text()).toContain(t("marketplace.signin_hint"));
    expect(text()).not.toContain("Organization built-in");
    await act(async () => cloud.setIsSignedIn(true));
    expect(text()).toContain("Organization built-in");
    expect(text()).not.toContain("Public built-in");
    expect(text()).not.toContain("Global local spec");
    expect(sync).not.toHaveBeenCalled();
  });

  test("discarded refresh success cannot toast or refresh connectors after switching source", async () => {
    await render({ source: "organization" });
    const pending = deferred();
    load = () => pending.promise;
    await act(async () => header().props.onRefresh());
    expect(header().props.busy).toBe(true);
    const connectorCalls = connectors.mock.calls.length;
    await render({ source: "public" });
    expect(header().props.busy).toBe(false);
    await act(async () => pending.resolve());
    expect(info).not.toHaveBeenCalled();
    expect(connectors).toHaveBeenCalledTimes(connectorCalls);
    expect(text()).not.toContain("Organization readiness failed");
  });

  test("old-org failure cannot clear new-org loading or leak an error", async () => {
    await render({ source: "organization" });
    const old = deferred();
    load = () => old.promise;
    await act(async () => header().props.onRefresh());
    const current = deferred();
    load = () => current.promise;
    await act(async () => cloud.setActiveOrganization({ id: "org-b", name: "Team B", slug: "team-b", role: "member" }));
    await act(async () => old.reject(new Error("Stale org error")));
    expect(header().props.busy).toBe(true);
    expect(text()).not.toContain("Stale org error");
    await act(async () => current.resolve());
    expect(header().props.busy).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  test("a current manual refresh still reports success", async () => {
    await render({ source: "organization" });
    await act(async () => header().props.onRefresh());
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual(["Loaded 1 marketplace extension for Team A."]);
    expect(header().props.busy).toBe(false);
  });

  test("unmount invalidates an in-flight manual refresh", async () => {
    await render({ source: "organization" });
    const pending = deferred();
    load = () => pending.promise;
    await act(async () => header().props.onRefresh());
    const connectorCalls = connectors.mock.calls.length;
    await act(async () => renderer!.unmount());
    renderer = undefined;
    await act(async () => pending.resolve());
    expect(info).not.toHaveBeenCalled();
    expect(connectors).toHaveBeenCalledTimes(connectorCalls);
  });
});

describe("Standalone plugin inline details", () => {
  const back = async () => {
    await act(async () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Back"))!.props.onClick());
  };

  test("built-in cards replace the list, preserve config slots, and report Back", async () => {
    const changed = mock(() => {});
    const setEnabled = mock(() => {});
    const browser = JUGGLEWORK_EXTENSION_CATALOG.find((entry) => entry.id === "jugglework-browser")!;
    await render({
      onDetailOpenChange: changed,
      configSlotForBuiltIn: () => <div>Built-in configuration</div>,
      isBuiltInConnected: () => true,
      setBuiltInEnabled: setEnabled,
      builtInEntries: [{ ...browser, id: "public", name: "Public built-in", description: "Public description" }],
    });
    await act(async () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Public built-in"))!.props.onClick());
    expect(renderer!.root.findAllByType(CatalogHeader)).toHaveLength(0);
    const detail = renderer!.root.findByType(ExtensionDetailModal);
    expect(detail.props.presentation).toBe("page");
    expect(detail.props.onUninstall).toBeUndefined();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(text()).toContain("Built-in configuration");
    const disable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.disable_plugin")))!;
    await act(async () => disable.props.onClick());
    expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: "Public built-in" }), false);
    expect(changed).toHaveBeenLastCalledWith(true);
    await back();
    expect(renderer!.root.findAllByType(CatalogHeader)).toHaveLength(1);
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  test("sidebar builtin IDs ignore search and nonce can reopen after Back", async () => {
    await render({ searchValue: "no match", detailRequest: { id: "builtin:public", nonce: 1 } });
    expect(text()).toContain("detail-page");
    await back();
    expect(text()).not.toContain("detail-page");
    await render();
    expect(text()).not.toContain("detail-page");
    await render({ detailRequest: { id: "builtin:public", nonce: 2 } });
    expect(text()).toContain("detail-page");
  });

  test("Computer Use detail blocks Enable until MCP and permissions are ready", async () => {
    const setEnabled = mock(() => {});
    const computerUse = JUGGLEWORK_EXTENSION_CATALOG.find((entry) => entry.id === "computer-use")!;
    await render({
      builtInEntries: [computerUse],
      setBuiltInEnabled: setEnabled,
      detailRequest: { id: "builtin:computer-use", nonce: 1 },
    });

    const detail = renderer!.root.findByType(ExtensionDetailModal);
    expect(detail.props.onConnect).toBeUndefined();
    const enable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.enable_plugin")))!;
    await act(async () => enable.props.onClick());
    expect(setEnabled).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test.each(["jugglework-voice", "google-workspace", "ollama"])("%s detail keeps an unconfigured plugin disabled and explains why", async (id) => {
    const entry = JUGGLEWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === id)!;
    const setEnabled = mock(() => {});
    await render({
      builtInEntries: [entry],
      setBuiltInEnabled: setEnabled,
      detailRequest: { id: `builtin:${id}`, nonce: 1 },
    });

    expect(renderer!.root.findByType(ExtensionDetailModal).props.onConnect).toBeUndefined();
    const enable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.enable_plugin")))!;
    await act(async () => enable.props.onClick());
    expect(setEnabled).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test("Voice Mode enables from the page header only after its API key is configured", async () => {
    const entry = JUGGLEWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === "jugglework-voice")!;
    const setEnabled = mock(() => {});
    await render({
      builtInEntries: [entry],
      enablementContext: { configuredEnvKeys: new Set(["OPENAI_API_KEY"]), isToggleEnabled: () => false },
      setBuiltInEnabled: setEnabled,
      detailRequest: { id: "builtin:jugglework-voice", nonce: 1 },
    });

    const enable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.enable_plugin")))!;
    await act(async () => enable.props.onClick());
    expect(setEnabled).toHaveBeenCalledWith(entry, true);
    expect(warning).not.toHaveBeenCalled();
  });

  test("Google Workspace enables only after its account connection is ready", async () => {
    const entry = JUGGLEWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === "google-workspace")!;
    const setEnabled = mock(() => {});
    await render({
      builtInEntries: [entry],
      isBuiltInConnected: () => true,
      setBuiltInEnabled: setEnabled,
      detailRequest: { id: "builtin:google-workspace", nonce: 1 },
    });

    const enable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.enable_plugin")))!;
    await act(async () => enable.props.onClick());
    expect(setEnabled).toHaveBeenCalledWith(entry, true);
    expect(warning).not.toHaveBeenCalled();
  });

  test("Ollama enables only after its provider configuration is ready", async () => {
    const entry = JUGGLEWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === "ollama")!;
    const setEnabled = mock(() => {});
    await render({
      builtInEntries: [entry],
      enablementContext: { connectedProviders: new Set(["ollama"]), isToggleEnabled: () => false },
      setBuiltInEnabled: setEnabled,
      detailRequest: { id: "builtin:ollama", nonce: 1 },
    });

    const enable = renderer!.root.findAllByType("button").find((button) => button.children.includes(t("marketplace.enable_plugin")))!;
    await act(async () => enable.props.onClick());
    expect(setEnabled).toHaveBeenCalledWith(entry, true);
    expect(warning).not.toHaveBeenCalled();
  });

  test("page requests retain built-in policy gates and close on scope change or unmount", async () => {
    const changed = mock(() => {});
    const enable = mock(() => {});
    await render({ builtInExtensionsDisabled: true, setBuiltInEnabled: enable, onDetailOpenChange: changed, detailRequest: { id: "builtin:public", nonce: 1 } });
    const detail = renderer!.root.findByType(ExtensionDetailModal);
    expect(detail.props.disabledReason).toBe("Disabled by organization");
    expect(detail.props.onConnect).toBeUndefined();
    expect(detail.props.onUninstall).toBeUndefined();
    await render({ workspaceKey: "other-workspace" });
    expect(text()).not.toContain("detail-page");
    expect(changed).toHaveBeenLastCalledWith(false);
    await render({ detailRequest: { id: "builtin:public", nonce: 2 } });
    expect(changed).toHaveBeenLastCalledWith(true);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(enable).not.toHaveBeenCalled();
  });

  test("pending requests wait for inventory and personal IDs use the supplied value", async () => {
    const personalPlugins = props.personalPlugins;
    await render({ source: "personal", personalPlugins: [], searchValue: "no match", detailRequest: { id: "local", nonce: 1 } });
    expect(text()).not.toContain("detail-page");
    await render({ personalPlugins });
    expect(text()).toContain("Global local spec");
    expect(text()).toContain("local");
    expect(renderer!.root.findByType(ExtensionDetailModal).props.presentation).toBe("page");
    expect(props.extensions.importCloudOrgPlugin).not.toHaveBeenCalled();
    expect(props.extensions.removeCloudOrgPlugin).not.toHaveBeenCalled();
    await back();
    await render({ searchValue: "" });
    await act(async () => renderer!.root.findAllByType(ExtensionCard).find((card) => card.props.name === "Global local spec")!.props.onClick());
    expect(text()).toContain("detail-page");
  });

  test("cloud requests wait for loading and use cloud-plugin IDs without mutation access", async () => {
    const pending = deferred();
    load = () => pending.promise;
    const resolvePlugin = mock(async () => ({ memberships: [] }));
    cloud.client.getOrgPluginResolved = resolvePlugin as typeof cloud.client.getOrgPluginResolved;
    await render({ source: "organization", extensions: { ...props.extensions, cloudOrgPlugins: () => [] }, searchValue: "no match", detailRequest: { id: "cloud-plugin:org-builtin", nonce: 1 } });
    await render({ extensions: { ...props.extensions, cloudOrgPlugins: () => plugins } });
    expect(text()).not.toContain("detail-page");
    await act(async () => pending.resolve());
    expect(text()).toContain("Organization built-in");
    expect(renderer!.root.findByType(MarketplacePackageDetailModal).props.presentation).toBe("page");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(props.extensions.importCloudOrgPlugin).not.toHaveBeenCalled();
    expect(props.extensions.removeCloudOrgPlugin).not.toHaveBeenCalled();
    await render({ source: "public" });
    expect(text()).not.toContain("detail-page");
  });

  test.each([{ applicationCatalog: false }, { embedded: true }])("legacy hosts keep modal presentation: %j", async (mode) => {
    await render(mode);
    await act(async () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Public built-in"))!.props.onClick());
    expect(renderer!.root.findAllByType(CatalogHeader)).toHaveLength(1);
    expect(renderer!.root.findByType(ExtensionDetailModal).props.presentation).toBe("modal");
    expect(text()).not.toContain("detail-page");
  });
});
