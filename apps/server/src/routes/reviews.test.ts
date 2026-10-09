import { describe, expect, test } from "bun:test";
import type { ReviewConnectionStatus } from "@jugglework/types/reviews";

import { registerReviewRoutes } from "./reviews.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

const workspace: WorkspaceInfo = { id: "ws-1", name: "Review", path: "/tmp/review", preset: "default", workspaceType: "local" };
const config = { workspaces: [workspace] } as ServerConfig;
const connection: ReviewConnectionStatus = { schemaVersion: 1, provider: "github", state: "ready", connectionId: "github", connectionName: "GitHub" };

function setup() {
  const routes: Route[] = [];
  const calls: Array<{ method: string; input: unknown }> = [];
  registerReviewRoutes({
    routes,
    config,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    resolveWorkspaceForInspection: async (_config, id) => {
      expect(id).toBe("ws-1");
      return workspace;
    },
    service: {
      getConnection: async (input) => { calls.push({ method: "connection", input }); return connection; },
      listInbox: async (input) => { calls.push({ method: "inbox", input }); return { schemaVersion: 1, items: [], nextCursor: null, snapshotAt: new Date(0).toISOString(), source: { provider: "github", connectionId: "github", connectionName: "GitHub" }, cache: { source: "provider", fetchedAt: new Date(0).toISOString(), stale: false } }; },
      getDetail: async (input) => { calls.push({ method: "detail", input }); throw new Error("unused"); },
      listFiles: async (input) => { calls.push({ method: "files", input }); throw new Error("unused"); },
      getChecks: async (input) => { calls.push({ method: "checks", input }); throw new Error("unused"); },
      listThreads: async (input) => { calls.push({ method: "threads", input }); throw new Error("unused"); },
    },
  });
  return { routes, calls };
}

async function invoke(routes: Route[], path: string) {
  const url = new URL(`http://localhost${path}`);
  const route = matchRoute(routes, "GET", url.pathname);
  expect(route).toBeTruthy();
  expect(route!.auth).toBe("client");
  return route!.handler({ request: new Request(url), url, params: route!.params, config } as RequestContext);
}

describe("read-only Review routes", () => {
  test("registers only GET client routes and forwards request cancellation", async () => {
    const { routes, calls } = setup();
    expect(routes).toHaveLength(6);
    expect(routes.every((route) => route.method === "GET" && route.auth === "client")).toBe(true);
    const response = await invoke(routes, "/workspace/ws-1/reviews/connection");
    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("connection");
    expect((calls[0]?.input as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  test("normalizes bounded Inbox filters without accepting capabilities", async () => {
    const { routes, calls } = setup();
    const response = await invoke(routes, "/workspace/ws-1/reviews?relationship=authored&query=router&limit=20&capability=merge_pull_request");
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "inbox", input: { relationship: "authored", query: "router", limit: 20 } });
    expect(JSON.stringify(calls[0])).not.toContain("merge_pull_request");
  });
});
