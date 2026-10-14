import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import * as den from "../src/app/lib/den";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const user = { id: "test-user", email: "test@example.test", name: "Test" };
const team = { id: "team", name: "Team", slug: "team", role: "owner" };
const personal = { id: "personal", name: "Personal", slug: "personal", role: "owner", isPersonal: true };
let sessionCalls = 0;
let orgCalls = 0;
let listOrgs = async () => ({ orgs: [team, personal], activeOrgId: team.id });
const client = {
  getSession: async () => { sessionCalls += 1; return user; },
  listOrgs: () => { orgCalls += 1; return listOrgs(); },
};
mock.module("../src/app/lib/den", () => ({
  ...den,
  createDenClient: () => client,
  ensureDenActiveOrganization: async () => null,
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ user, isSignedIn: true }),
}));

const { CloudSessionProvider, useCloudSession } = await import("../src/react-app/domains/settings/cloud/cloud-session-provider");
const { useDenSession } = await import("../src/react-app/domains/settings/cloud/use-den-session");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let cloud: ReturnType<typeof useCloudSession>;
let session: ReturnType<typeof useDenSession>;
const openLink = () => {};

function Probe() {
  cloud = useCloudSession();
  session = useDenSession({ developerMode: false, openLink });
  return null;
}

function installWindow() {
  const storage = new Map<string, string>();
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(target, {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    }),
  });
  den.writeDenSettings({ baseUrl: "https://cloud.example.test", authToken: "test-token", activeOrgId: team.id, activeOrgName: team.name, activeOrgSlug: team.slug });
  sessionCalls = 0;
  orgCalls = 0;
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  listOrgs = async () => ({ orgs: [team, personal], activeOrgId: team.id });
});

test("mounted settings follows account-menu selection, including personal, without revalidating or looping", async () => {
  installWindow();
  await act(async () => { renderer = TestRenderer.create(<CloudSessionProvider><Probe /></CloudSessionProvider>); });
  expect(cloud.activeOrganization).toMatchObject(team);
  const beforeSessionCalls = sessionCalls;
  const beforeOrgCalls = orgCalls;
  await act(async () => {
    den.writeDenSettings({ ...den.readDenSettings(), activeOrgId: personal.id, activeOrgName: personal.name, activeOrgSlug: personal.slug });
  });
  expect(cloud.activeOrganization).toMatchObject(personal);
  expect(cloud.isSignedIn).toBe(true);
  expect(cloud.user).toEqual(user);
  expect(den.readDenSettings().activeOrgId).toBe(personal.id);
  const currentOrg = cloud.activeOrganization;
  await act(async () => { window.dispatchEvent(new Event(denSettingsChangedEvent)); });
  expect(cloud.activeOrganization).toBe(currentOrg);
  expect(sessionCalls).toBe(beforeSessionCalls);
  expect(orgCalls).toBe(beforeOrgCalls);
  // A stale server-active hint must not undo the explicit local selection.
  await act(async () => { await session.onRefreshOrgs(true); });
  expect(den.readDenSettings().activeOrgId).toBe(personal.id);
  expect(cloud.activeOrganization?.id).toBe(personal.id);
});

test("an in-flight org list uses the latest selection instead of restoring its starting org", async () => {
  installWindow();
  await act(async () => { renderer = TestRenderer.create(<CloudSessionProvider><Probe /></CloudSessionProvider>); });
  let resolve!: (value: Awaited<ReturnType<typeof listOrgs>>) => void;
  listOrgs = () => new Promise((done) => { resolve = done; });
  let pending!: Promise<void>;
  await act(async () => { pending = session.onRefreshOrgs(true); });
  await act(async () => {
    den.writeDenSettings({ ...den.readDenSettings(), activeOrgId: personal.id, activeOrgName: personal.name, activeOrgSlug: personal.slug });
    resolve({ orgs: [team, personal], activeOrgId: team.id });
    await pending;
  });
  expect(cloud.activeOrganization?.id).toBe(personal.id);
  expect(den.readDenSettings().activeOrgId).toBe(personal.id);
});

test("provider synchronizes metadata and clears an explicitly removed selection", async () => {
  installWindow();
  function ProviderProbe() { cloud = useCloudSession(); return null; }
  await act(async () => { renderer = TestRenderer.create(<CloudSessionProvider><ProviderProbe /></CloudSessionProvider>); });
  await act(async () => {
    cloud.setActiveOrganization({ ...team, role: "admin" });
    cloud.setUser(user);
    cloud.setIsSignedIn(true);
  });
  await act(async () => { den.writeDenSettings({ ...den.readDenSettings(), activeOrgName: "Renamed" }); });
  expect(cloud.activeOrganization).toMatchObject({ id: team.id, name: "Renamed", role: "admin" });
  expect(cloud.isSignedIn).toBe(true);
  await act(async () => { den.writeDenSettings({ ...den.readDenSettings(), authToken: null, activeOrgId: null }); });
  expect(cloud.activeOrganization).toBeNull();
  expect(cloud.user).toBeNull();
  expect(cloud.isSignedIn).toBe(false);
  expect(cloud.authToken).toBe("");
});
