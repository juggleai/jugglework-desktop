import { describe, expect, test } from "bun:test";

import {
  isRemoteWorkerUnreachableState,
  testRemoteWorkspaceConnection,
} from "../src/react-app/domains/workspace/remote-workspace-diagnostics";
import type { WorkspaceInfo } from "../src/app/lib/desktop";

function remoteWorkspaceFixture(): WorkspaceInfo {
  return {
    id: "rem_ws_fixture",
    name: "Remote workspace",
    path: "",
    preset: "remote",
    workspaceType: "remote",
    remoteType: "jugglework",
    baseUrl: "https://8080-sbold.workers.example.test",
    juggleworkHostUrl: "https://8080-sbold.workers.example.test",
    juggleworkWorkspaceId: "ws_fixture",
    juggleworkToken: "jwwc_fixture_token_value",
  } as WorkspaceInfo;
}

function statusError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function clientMock(overrides: Partial<{
  health: () => Promise<unknown>;
  capabilities: () => Promise<unknown>;
  status: () => Promise<unknown>;
  listWorkspaces: () => Promise<unknown>;
}>) {
  return {
    health: () => Promise.resolve({ ok: true, version: "1", uptimeMs: 1 }),
    capabilities: () => Promise.resolve({}),
    status: () => Promise.resolve({}),
    listWorkspaces: () => Promise.resolve({ items: [{ id: "ws_fixture", name: "Fixture" }], activeId: "ws_fixture" }),
    ...overrides,
  };
}

describe("remote workspace rebuilt diagnostics", () => {
  test("gateway 404 sandbox route classifies as worker_unreachable", async () => {
    const result = await testRemoteWorkspaceConnection(remoteWorkspaceFixture(), {
      createClient: () => clientMock({
        health: () => Promise.reject(statusError(404, "The sandbox route is unavailable.")),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.state.reason).toBe("worker_unreachable");
    expect(result.state.message).toContain("may have been redeployed");
  });

  test("network-level fetch failure classifies as worker_unreachable", async () => {
    const result = await testRemoteWorkspaceConnection(remoteWorkspaceFixture(), {
      createClient: () => clientMock({
        health: () => Promise.reject(new TypeError("fetch failed")),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.state.reason).toBe("worker_unreachable");
  });

  test("rejected token keeps its own reason", async () => {
    const result = await testRemoteWorkspaceConnection(remoteWorkspaceFixture(), {
      createClient: () => clientMock({
        capabilities: () => Promise.reject(statusError(401, "Unauthorized")),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.state.reason).toBe("token_rejected");
  });

  test("missing workspace keeps its own reason", async () => {
    const result = await testRemoteWorkspaceConnection(remoteWorkspaceFixture(), {
      createClient: () => clientMock({
        listWorkspaces: () => Promise.resolve({ items: [], activeId: null }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.state.reason).toBe("workspace_missing");
  });

  test("isRemoteWorkerUnreachableState matches only unreachable errors", () => {
    expect(isRemoteWorkerUnreachableState({ status: "error", reason: "worker_unreachable" })).toBe(true);
    expect(isRemoteWorkerUnreachableState({ status: "error", reason: "token_rejected" })).toBe(false);
    expect(isRemoteWorkerUnreachableState({ status: "connected" })).toBe(false);
    expect(isRemoteWorkerUnreachableState(null)).toBe(false);
  });
});
