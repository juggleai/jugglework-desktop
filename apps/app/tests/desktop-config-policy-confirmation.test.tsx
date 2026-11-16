/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as den from "../src/app/lib/den";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { usePromptSuggestions } from "../src/react-app/domains/session/surface/prompt-suggestions";

let auth = { status: "signed_in", isSignedIn: true, user: { id: "user-a" } };
let settings = { baseUrl: "https://policy.test", authToken: "test-only", activeOrgId: "org-a" };
let fetchPolicy: (org: string) => Promise<den.DenDesktopConfig> = async () => { throw new Error("offline"); };
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => auth }));
mock.module("../src/app/lib/den", () => ({
  ...den, readDenSettings: () => settings,
  createDenClient: () => ({ getDesktopConfig: (org: string) => fetchPolicy(org) }),
}));
mock.module("../src/react-app/shell/jugglework-connection", () => ({ resolveJuggleWorkConnection: async () => ({}) }));
const { DesktopConfigProvider, useDesktopConfig } = await import("../src/react-app/domains/cloud/desktop-config-provider");

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const storage = new Map<string, string>();
const target = Object.assign(new EventTarget(), {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  setInterval, clearInterval,
});
Object.defineProperty(globalThis, "window", { configurable: true, value: target });
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  for (const [key, descriptor] of [["window", previousWindow], ["document", previousDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
let view: TestRenderer.ReactTestRenderer;
let policy: ReturnType<typeof useDesktopConfig>;
let queryClient: QueryClient;
let round = 1;
let running = false;
let sequence = 0;
let sessionId = "";
const request = mock(async (_workspace: string, _session: string, input: { turnKey: string }) => ({ turnKey: input.turnKey, suggestion: null }));
const client = {
  ...createJuggleWorkServerClient({ baseUrl: "https://suggestion.test" }),
  capabilities: async () => ({ sessions: { promptSuggestions: true } }) as Awaited<ReturnType<ReturnType<typeof createJuggleWorkServerClient>["capabilities"]>>,
  getPromptSuggestion: request,
};
function Probe() {
  policy = useDesktopConfig();
  usePromptSuggestions({ client, workspaceId: "ws", sessionId, model: { providerID: "p", modelID: "m" },
    loaded: true, enabled: true, active: true, turnKey: `turn-${round}`, turnCreatedAt: round * 100,
    running, completed: !running, blocked: false, empty: true,
    ready: policy.policyConfirmed && !policy.loading, policyKey: JSON.stringify(policy.config) });
  return null;
}
function element() { return <QueryClientProvider client={queryClient}><DesktopConfigProvider><Probe /></DesktopConfigProvider></QueryClientProvider>; }
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function mount(options: { cached?: den.DenDesktopConfig; status?: string; fetch?: typeof fetchPolicy } = {}) {
  storage.clear(); request.mockClear(); round = 1; running = false; sessionId = `policy-${++sequence}`;
  settings = { baseUrl: "https://policy.test", authToken: "test-only", activeOrgId: "org-a" };
  auth = { status: options.status ?? "signed_in", isSignedIn: (options.status ?? "signed_in") === "signed_in", user: { id: "user-a" } };
  fetchPolicy = options.fetch ?? (async () => { throw new Error("offline"); });
  if (options.cached) storage.set("jugglework.den.desktopConfig:https://policy.test::org-a", JSON.stringify(options.cached));
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  await act(async () => { view = TestRenderer.create(element()); }); await act(wait);
}
async function update() { await act(async () => view.update(element())); }
async function newRound() {
  round++; running = true; await update(); running = false; await update(); await act(wait);
}
afterEach(async () => { await act(async () => view?.unmount()); queryClient?.clear(); });

test("signed-in fetch failure without cache is unknown despite loading=false and permissive legacy fallback", async () => {
  await mount();
  expect(policy.loading).toBe(false); expect(policy.policyConfirmed).toBe(false);
  expect(policy.checkRestriction({ restriction: "allowCustomProviders" })).toBe(false);
  await newRound(); expect(request).not.toHaveBeenCalled();
  fetchPolicy = async () => ({});
  await act(async () => { await policy.refresh(); });
  expect(policy.policyConfirmed).toBe(true);
  await act(wait); expect(request).not.toHaveBeenCalled(); // No old-round backfill.
  await newRound(); expect(request).toHaveBeenCalledTimes(1);
});

test("confirmed signed-out local use permits suggestions; checking and unavailable auth do not", async () => {
  await mount({ status: "signed_out" }); expect(policy.policyConfirmed).toBe(true);
  await newRound(); expect(request).toHaveBeenCalledTimes(1);
  for (const status of ["checking", "unavailable"]) {
    auth = { ...auth, status }; await update(); expect(policy.policyConfirmed).toBe(false);
    await newRound(); expect(request).toHaveBeenCalledTimes(1);
  }
});

test("matching scoped cache survives offline refresh with original restrictions unchanged", async () => {
  await mount({ cached: { allowCustomProviders: false, allowedModels: ["p/m"] } });
  expect(policy.loading).toBe(false); expect(policy.policyConfirmed).toBe(true);
  expect(policy.checkRestriction({ restriction: "allowCustomProviders" })).toBe(true);
  expect(policy.config.allowedModels).toEqual(["p/m"]);
  await act(async () => { await policy.refresh(); });
  expect(policy.policyConfirmed).toBe(true);
  await newRound(); expect(request).toHaveBeenCalledTimes(1);
});

test("cache from another organization cannot confirm; late old-scope fetch cannot authorize new scope", async () => {
  let resolve!: (config: den.DenDesktopConfig) => void;
  await mount({ cached: {}, fetch: () => new Promise((done) => { resolve = done; }) });
  expect(policy.policyConfirmed).toBe(true);
  fetchPolicy = async () => { throw new Error("offline in org-b"); };
  await act(async () => { settings = { ...settings, activeOrgId: "org-b" }; target.dispatchEvent(new Event(denSettingsChangedEvent)); });
  expect(policy.loading).toBe(false); expect(policy.policyConfirmed).toBe(false);
  await act(async () => { resolve({ allowCustomProviders: true }); });
  expect(policy.policyConfirmed).toBe(false); await newRound(); expect(request).not.toHaveBeenCalled();
});

test("base URL change drops confirmation and ignores another deployment's cache", async () => {
  await mount({ cached: {} }); expect(policy.policyConfirmed).toBe(true);
  await act(async () => { settings = { ...settings, baseUrl: "https://other-policy.test" }; target.dispatchEvent(new Event(denSettingsChangedEvent)); });
  expect(policy.policyConfirmed).toBe(false); await newRound(); expect(request).not.toHaveBeenCalled();
});

test("account changes cannot reuse the previous account's in-memory confirmation", async () => {
  await mount({ fetch: async () => ({ allowCustomProviders: false }) });
  expect(policy.policyConfirmed).toBe(true);
  // Existing cache ownership is unchanged: this test removes that cache to
  // exercise the no-cache identity transition rather than alter its semantics.
  storage.clear();
  fetchPolicy = async () => { throw new Error("offline after account change"); };
  auth = { ...auth, user: { id: "user-b" } };
  await update();
  expect(policy.loading).toBe(false); expect(policy.policyConfirmed).toBe(false);
  await newRound(); expect(request).not.toHaveBeenCalled();
});
