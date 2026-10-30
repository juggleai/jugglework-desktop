import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const noop = () => {};
type Subscription = {
  workspaceId: string;
  onSessionUpdated: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onReconnect: () => void;
};
const subscriptions = new Map<string, Subscription>();
let listSessions: (workspaceId: string) => Promise<{ items: RouteSession[] }>;
mock.module("../src/react-app/kernel/local-provider", () => ({ useLocal: () => ({ prefs: { hasCompletedOnboarding: true } }) }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: "signed-out", isSignedIn: false }) }));
mock.module("../src/react-app/shell/boot-state", () => ({ useBootState: () => ({ markRouteReady: noop }) }));
mock.module("../src/react-app/shell/jugglework-connection", () => ({ resolveJuggleWorkConnection: async () => ({
  normalizedBaseUrl: "", resolvedToken: "", resolvedHostToken: "", hostInfo: null,
}) }));
mock.module("../src/react-app/domains/session/sync/session-sync", () => ({
  ensureWorkspaceSessionSync: (input: Subscription) => {
    subscriptions.set(input.workspaceId, input);
    return () => { subscriptions.delete(input.workspaceId); };
  },
}));
mock.module("../src/react-app/infra/workspace-server-client", () => ({
  createWorkspaceServerClientResolver: () => (workspace: RouteWorkspace | null) => workspace ? {
    workspaceId: workspace.id.replace(/^rem_/, ""),
    opencodeBaseUrl: `http://test/${workspace.id}`, baseUrl: "http://test", token: "test",
    isRemote: true, client: { listSessions: (id: string) => listSessions(id) },
  } : null,
  useWorkspaceServerClient: () => null,
}));

const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
let state: ReturnType<typeof useWorkspaceRouteState>;
let renderer: TestRenderer.ReactTestRenderer;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const workspaces = ["a", "b"].map((id) => ({
  id: `rem_${id}`, workspaceType: "remote", remoteType: "jugglework", displayNameResolved: id,
})) as RouteWorkspace[];
const session = (title: string) => ({ id: "same-session-id", title, time: { created: 1, updated: 2 } }) as RouteSession;
function Probe({ selected }: { selected: string }) {
  state = useWorkspaceRouteState({ embedded: true, routeWorkspaceId: "", routeSessionId: null,
    developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
  return null;
}
const tree = (selected = "rem_a") => <MemoryRouter><Probe selected={selected} /></MemoryRouter>;

beforeEach(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  listSessions = async () => ({ items: [session("Database title")] });
  await act(async () => { renderer = TestRenderer.create(tree()); });
  await act(async () => {
    state.setWorkspaces(workspaces);
    state.setLegacySelectedWorkspaceId("rem_a");
    state.setSessionsByWorkspaceId({ rem_a: [session("A")], rem_b: [session("B")] });
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  subscriptions.clear();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

test("background metadata is bound to the owning workspace before and after selection changes", async () => {
  const notify = (id: string, title: string) => subscriptions.get(id)!.onSessionUpdated({ sessionId: "same-session-id", info: { title } });
  await act(async () => notify("b", "B live"));
  expect(state.sessionsByWorkspaceId.rem_a![0]!.title).toBe("A");
  expect(state.sessionsByWorkspaceId.rem_b![0]!.title).toBe("B live");
  await act(async () => state.setLegacySelectedWorkspaceId("rem_b"));
  await act(async () => notify("a", "A live"));
  expect(state.sessionsByWorkspaceId.rem_a![0]!.title).toBe("A live");
  expect(state.sessionsByWorkspaceId.rem_b![0]!.title).toBe("B live");
});

test("reconnect reloads its workspace and a stale list cannot undo a concurrent title event", async () => {
  let resolve!: (response: { items: RouteSession[] }) => void;
  listSessions = async (id) => {
    expect(id).toBe("b");
    return await new Promise((done) => { resolve = done; });
  };
  await act(async () => subscriptions.get("b")!.onReconnect());
  await act(async () => subscriptions.get("b")!.onSessionUpdated({ sessionId: "same-session-id", info: { title: "Live title" } }));
  await act(async () => resolve({ items: [session("B")] }));
  expect(state.sessionsByWorkspaceId.rem_b![0]!.title).toBe("Live title");
  listSessions = async () => ({ items: [session("Missed offline rename")] });
  await act(async () => subscriptions.get("b")!.onReconnect());
  expect(state.sessionsByWorkspaceId.rem_b![0]!.title).toBe("Missed offline rename");
  expect(state.sessionsByWorkspaceId.rem_a![0]!.title).toBe("A");
});

test("a forced reconnect supersedes an older list response even when both start in the same tick", async () => {
  const pending: ((response: { items: RouteSession[] }) => void)[] = [];
  listSessions = () => new Promise((resolve) => pending.push(resolve));
  await act(async () => subscriptions.get("b")!.onReconnect());
  await act(async () => subscriptions.get("b")!.onReconnect());
  expect(pending).toHaveLength(2);
  await act(async () => pending[1]!({ items: [session("Newest title")] }));
  await act(async () => pending[0]!({ items: [session("Stale title")] }));
  expect(state.sessionsByWorkspaceId.rem_b![0]!.title).toBe("Newest title");
});
