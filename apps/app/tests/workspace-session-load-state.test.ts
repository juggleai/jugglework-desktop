import { describe, expect, test } from "bun:test";

import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import {
  beginWorkspaceSessionLoad,
  completeWorkspaceSessionLoad,
  createWorkspaceSessionEndpointKey,
  failWorkspaceSessionLoad,
  shouldReloadWorkspaceSessions,
} from "../src/react-app/shell/workspace-session-load-state";

const workspace = {
  id: "workspace-a",
  path: "/Users/example/project/",
  workspaceType: "local",
} as RouteWorkspace;

const endpoint = {
  baseUrl: "http://127.0.0.1:61882/",
  workspaceId: "workspace-a",
  token: "token-a",
} as ResolvedWorkspaceEndpoint;

describe("workspace session load state", () => {
  test("reloads workspaces that have no authoritative load state even when their cached list is empty", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint);

    expect(shouldReloadWorkspaceSessions({ state: undefined, endpointKey, now: 1_000 })).toBe(true);
  });

  test("keeps a fresh successful cache and reloads it after the TTL", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint)!;
    const state = completeWorkspaceSessionLoad(endpointKey, 1_000);

    expect(shouldReloadWorkspaceSessions({ state, endpointKey, now: 30_999, ttlMs: 30_000 })).toBe(false);
    expect(shouldReloadWorkspaceSessions({ state, endpointKey, now: 31_000, ttlMs: 30_000 })).toBe(true);
  });

  test("invalidates a successful cache when the endpoint identity changes", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint)!;
    const changedEndpointKey = createWorkspaceSessionEndpointKey(workspace, {
      ...endpoint,
      token: "token-b",
    })!;
    const state = completeWorkspaceSessionLoad(endpointKey, 1_000);

    expect(shouldReloadWorkspaceSessions({ state, endpointKey: changedEndpointKey, now: 2_000 })).toBe(true);
  });

  test("invalidates a successful cache when the workspace path changes", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint)!;
    const movedEndpointKey = createWorkspaceSessionEndpointKey({
      ...workspace,
      path: "/Users/example/moved-project",
    }, endpoint)!;
    const state = completeWorkspaceSessionLoad(endpointKey, 1_000);

    expect(shouldReloadWorkspaceSessions({ state, endpointKey: movedEndpointKey, now: 2_000 })).toBe(true);
  });

  test("always validates the selected workspace and retries failed workspaces", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint)!;
    const loaded = completeWorkspaceSessionLoad(endpointKey, 1_000);
    const failed = failWorkspaceSessionLoad(loaded, endpointKey, "timed out");

    expect(shouldReloadWorkspaceSessions({ state: loaded, endpointKey, selected: true, now: 1_001 })).toBe(true);
    expect(shouldReloadWorkspaceSessions({ state: failed, endpointKey, now: 1_001 })).toBe(true);
  });

  test("preserves the last successful timestamp while loading or after a failed refresh", () => {
    const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint)!;
    const loaded = completeWorkspaceSessionLoad(endpointKey, 1_000);
    const loading = beginWorkspaceSessionLoad(loaded, endpointKey);
    const failed = failWorkspaceSessionLoad(loading, endpointKey, "connection failed");

    expect(loading.loadedAt).toBe(1_000);
    expect(failed.loadedAt).toBe(1_000);
    expect(failed.status).toBe("error");
  });
});
