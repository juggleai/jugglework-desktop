/** @jsxImportSource react */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import type {
  JuggleWorkHostMarketplaceIdentityScope,
  JuggleWorkHostMarketplaceRegistryList,
} from "../src/app/lib/jugglework-server";
import { CloudSessionProvider, useCloudSession } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import type { HostMarketplaceClient } from "../src/react-app/domains/settings/state/host-marketplace-plugins";
import {
  HostMarketplacePluginsProvider,
  useHostMarketplaceExecutionTarget,
  useHostMarketplacePlugins,
} from "../src/react-app/domains/settings/state/host-marketplace-plugins-provider";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let cloud: ReturnType<typeof useCloudSession>;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let hostMarketplace: ReturnType<typeof useHostMarketplacePlugins>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let active = false;
let revision = 1;
const setScope = mock(async (input: { scope: JuggleWorkHostMarketplaceIdentityScope; active: boolean }) => {
  active = input.active;
  revision += 1;
  return {
    operation: input.active ? "activate" as const : "deactivate" as const,
    changed: true,
    registryRevision: revision,
    activeScope: input.active ? input.scope : null,
    installation: null,
    mcpOverlay: {},
  };
});
const client = {
  baseUrl: "http://host.example.test",
  capabilities: async () => ({
    skills: { read: true, write: true, source: "jugglework" as const },
    plugins: { read: true, write: true },
    mcp: { read: true, write: true },
    commands: { read: true, write: true },
    config: { read: true, write: true },
    hostMarketplacePlugins: { read: true, write: true },
  }),
  getHostMarketplaceEnvironment: async () => ({
    schemaVersion: 1 as const,
    environmentId: "host-environment",
    managed: true,
    capability: { read: true, write: true },
  }),
  listHostMarketplacePlugins: async (scope: JuggleWorkHostMarketplaceIdentityScope): Promise<JuggleWorkHostMarketplaceRegistryList> => ({
    schemaVersion: 1,
    registryRevision: revision,
    scope: { ...scope, environmentId: "host-environment" },
    active,
    installations: [],
  }),
  setHostMarketplaceScope: setScope,
} as unknown as HostMarketplaceClient;

function CloudProbe() {
  cloud = useCloudSession();
  return null;
}

function GlobalSessionShell() {
  hostMarketplace = useHostMarketplacePlugins();
  useHostMarketplaceExecutionTarget({
    client,
    token: "workspace-token",
    hostToken: "host-token",
    workspaceType: "local",
  });
  return <div data-testid="session-shell" />;
}

beforeEach(() => {
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
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  active = false;
  revision = 1;
  setScope.mockClear();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("the global session shell activates host plugins without mounting the Plugins route and clears them on sign-out", async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <CloudSessionProvider>
        <CloudProbe />
        <HostMarketplacePluginsProvider>
          <GlobalSessionShell />
        </HostMarketplacePluginsProvider>
      </CloudSessionProvider>,
    );
  });

  await act(async () => {
    cloud.setBaseUrl("https://cloud.example.test");
    cloud.setUser({ id: "user-1", email: "user@example.test", name: "User" });
    cloud.setActiveOrganization({ id: "org-1", name: "Org", slug: "org", role: "owner" });
    cloud.setIsSignedIn(true);
  });

  expect(renderer!.root.findByProps({ "data-testid": "session-shell" })).toBeTruthy();
  expect(setScope).toHaveBeenCalledTimes(1);
  expect(setScope.mock.calls[0]?.[0]).toMatchObject({
    active: true,
    scope: {
      controlPlaneOrigin: "https://cloud.example.test",
      userId: "user-1",
      organizationId: "org-1",
    },
  });

  await act(async () => {
    cloud.setIsSignedIn(false);
    cloud.setUser(null);
    cloud.setActiveOrganization(null);
  });

  expect(setScope).toHaveBeenCalledTimes(2);
  expect(setScope.mock.calls[1]?.[0]).toMatchObject({ active: false });
});

test("a direct OpenCode remote abandons the previous host without contacting it", async () => {
  function SwitchableShell(props: { directRemote: boolean }) {
    useHostMarketplaceExecutionTarget(props.directRemote ? {
      client,
      token: "direct-token",
      hostToken: "",
      workspaceType: "remote",
      remoteType: "opencode",
    } : {
      client,
      token: "workspace-token",
      hostToken: "host-token",
      workspaceType: "local",
    });
    return null;
  }

  const tree = (directRemote: boolean) => (
    <CloudSessionProvider>
      <CloudProbe />
      <HostMarketplacePluginsProvider>
        <SwitchableShell directRemote={directRemote} />
      </HostMarketplacePluginsProvider>
    </CloudSessionProvider>
  );
  await act(async () => { renderer = TestRenderer.create(tree(false)); });
  await act(async () => {
    cloud.setBaseUrl("https://cloud.example.test");
    cloud.setUser({ id: "user-1", email: "user@example.test", name: "User" });
    cloud.setActiveOrganization({ id: "org-1", name: "Org", slug: "org", role: "owner" });
    cloud.setIsSignedIn(true);
  });
  expect(setScope).toHaveBeenCalledTimes(1);

  await act(async () => { renderer!.update(tree(true)); });

  expect(setScope).toHaveBeenCalledTimes(1);
});

test("a mounted session can re-ensure scope after the server fails closed on restart", async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <CloudSessionProvider>
        <CloudProbe />
        <HostMarketplacePluginsProvider>
          <GlobalSessionShell />
        </HostMarketplacePluginsProvider>
      </CloudSessionProvider>,
    );
  });
  await act(async () => {
    cloud.setBaseUrl("https://cloud.example.test");
    cloud.setUser({ id: "user-1", email: "user@example.test", name: "User" });
    cloud.setActiveOrganization({ id: "org-1", name: "Org", slug: "org", role: "owner" });
    cloud.setIsSignedIn(true);
  });
  expect(setScope).toHaveBeenCalledTimes(1);

  active = false;
  await act(async () => { await hostMarketplace.ensureReady(); });

  expect(setScope).toHaveBeenCalledTimes(2);
  expect(setScope.mock.calls[1]?.[0]).toMatchObject({ active: true });
});
