/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { t } from "../src/i18n";
import { writeDenSettings } from "../src/app/lib/den";
import { CloudSessionProvider, useCloudSession } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import type { CloudMarketplacesViewProps } from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";

const info = mock(() => {});
let cloud: ReturnType<typeof useCloudSession>;
function SessionProbe() {
  cloud = useCloudSession();
  return null;
}
mock.module("../src/components/ui/sonner", () => ({ toast: { info, success: mock(() => {}), warning: mock(() => {}), error: mock(() => {}) } }));
mock.module("../src/react-app/design-system/extension-card", () => ({
  ExtensionCard: (props: { name: string; onClick: () => void; disabled?: boolean }) => <button disabled={props.disabled} onClick={props.onClick}>{props.name}</button>,
}));
mock.module("../src/react-app/design-system/extension-detail-modal", () => ({ ExtensionDetailModal: () => null }));
mock.module("../src/react-app/domains/settings/pages/marketplace-package-detail-modal", () => ({ MarketplacePackageDetailModal: () => null }));
mock.module("../src/react-app/shell/notifications", () => ({
  drainPendingMarketplacePlugin: () => null,
  openMarketplacePluginEvent: "test-open-marketplace",
}));
const { CloudMarketplacesView } = await import("../src/react-app/domains/settings/pages/cloud-marketplaces-view");
const { CatalogHeader } = await import("../src/react-app/domains/settings/pages/catalog-source");

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
  for (const fn of [info, refresh, sync, connectors, sourceChange]) fn.mockClear();
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
    // The only buttons are refresh and the three controlled source tabs.
    expect(renderer!.root.findAllByType("button")).toHaveLength(4);
    expect(props.extensions.importCloudOrgPlugin).not.toHaveBeenCalled();
    await render({ personalPlugins: [] });
    expect(text()).toContain(t("customization.empty_source"));
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
