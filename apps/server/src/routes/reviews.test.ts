import { describe, expect, test } from "bun:test";
import type { ReviewConnectionStatus } from "@jugglework/types/reviews";

import { registerReviewRoutes, registerReviewWorkflowRoutes } from "./reviews.js";
import type { ReviewWorkflow } from "../reviews/workflow.js";
import { ApiError } from "../errors.js";
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

describe("Review workflow routes", () => {
  test("publishing requires write authorization and rejects arbitrary capabilities or review events", async () => {
    const routes: Route[] = [];
    let writes = 0;
    let allowed = false;
    const inspected: boolean[] = [];
    registerReviewWorkflowRoutes({
      routes, jsonResponse: (data, status = 200) => Response.json(data, { status }),
      authorizeWrite: () => { if (!allowed) throw new ApiError(403, "insufficient_scope", "Collaborator scope required"); },
      resolveWorkspace: async (_id, inspection) => { inspected.push(inspection); return workspace; },
      readJsonBody: async (request) => await request.json() as Record<string, unknown>,
      workflow: { mutate: async () => { writes++; return { ok: true }; } } as unknown as ReviewWorkflow,
    });
    const url = new URL("http://localhost/workspace/ws-1/reviews/pr-one/publish");
    const route = matchRoute(routes, "POST", url.pathname)!;
    const body = { requestId: crypto.randomUUID(), expectedHeadRevision: "a".repeat(40), kind: "review", event: "APPROVE", body: "" };
    const call = (value: unknown) => route.handler({ request: new Request(url, { method: "POST", body: JSON.stringify(value) }), url, params: route.params, config } as RequestContext);
    await expect(call(body)).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(inspected).toHaveLength(0);
    allowed = true;
    await expect(call({ ...body, event: "MERGE" })).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(call({ ...body, capability: "merge_pull_request" })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(writes).toBe(0);
    expect((await call(body)).status).toBe(200);
    expect(writes).toBe(1);
    expect(inspected).toEqual([true]);
  });

  test("pull request actions accept only the fixed action contract", async () => {
    const routes: Route[] = [];
    const calls: unknown[] = [];
    registerReviewWorkflowRoutes({
      routes, jsonResponse: (data, status = 200) => Response.json(data, { status }),
      authorizeWrite: () => undefined,
      resolveWorkspace: async () => workspace,
      readJsonBody: async (request) => await request.json() as Record<string, unknown>,
      workflow: { mutatePullRequest: async (input: unknown) => { calls.push(input); return { ok: true }; } } as unknown as ReviewWorkflow,
    });
    const url = new URL("http://localhost/workspace/ws-1/reviews/pr-one/action");
    const route = matchRoute(routes, "POST", url.pathname)!;
    const invokeAction = (body: unknown) => route.handler({ request: new Request(url, { method: "POST", body: JSON.stringify(body) }), url, params: route.params, config } as RequestContext);
    const valid = { requestId: crypto.randomUUID(), expectedHeadRevision: "a".repeat(40), action: "merge", mergeMethod: "squash" };
    await expect(invokeAction({ ...valid, capability: "delete_repository" })).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(invokeAction({ ...valid, action: "close", mergeMethod: "squash" })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(calls).toHaveLength(0);
    expect((await invokeAction(valid)).status).toBe(200);
    expect(calls[0]).toMatchObject({ action: "merge", mergeMethod: "squash", reviewId: "pr-one" });
  });
});
