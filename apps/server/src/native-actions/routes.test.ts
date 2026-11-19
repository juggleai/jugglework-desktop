import { expect, test } from "bun:test";
import { registerNativeActionRoutes } from "../routes/native-actions.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { NativeActionsService } from "./service.js";
import { NativeActionTurns } from "./turns.js";

const scopeA = { baseUrl: "https://work.example.test", userId: "u1", organizationId: "org-a" };
const scopeB = { baseUrl: "https://work.example.test", userId: "u1", organizationId: "org-b" };

function setup(workspaceType: "local" | "remote" = "local") {
  const routes: Route[] = [];
  const turns = new NativeActionTurns();
  const requests: Array<{ op: string; scope: unknown; params: unknown }> = [];
  const service = new NativeActionsService(turns, async (input) => {
    requests.push(input);
    return { items: [], hasMore: false };
  });
  registerNativeActionRoutes({
    routes, config: {} as any, service,
    jsonResponse: (data, status) => Response.json(data, { status }),
    readJsonBody: (request) => request.json(),
    resolveWorkspace: async () => ({ id: "local", workspaceType }) as any,
    resolveTurn: async (workspaceId, sessionId, messageId) => workspaceId === "local" && sessionId === "s1"
      ? ({ "assistant-a": "user-a", "assistant-b": "user-b", "assistant-none": "user-none" } as Record<string, string>)[messageId] ?? null
      : null,
  });
  const call = async (name: "product-tasks" | "contacts", body: Record<string, unknown>) => {
    const path = `/workspace/local/native-actions/${name}`;
    const route = matchRoute(routes, "POST", path)!;
    const url = new URL(`http://localhost${path}`);
    return route.handler({ url, params: route.params, request: new Request(url, { method: "POST", body: JSON.stringify(body) }) } as any);
  };
  return { turns, requests, call };
}

test("each tool call runs under the identity frozen on its own user turn", async () => {
  const { turns, requests, call } = setup();
  turns.register("local", "s1", "user-a", scopeA);
  turns.register("local", "s1", "user-b", scopeB);
  await call("product-tasks", { sessionId: "s1", messageId: "assistant-a", args: { dueOn: "2026-11-19" } });
  await call("contacts", { sessionId: "s1", messageId: "assistant-b", args: { query: "张" } });
  expect(requests).toEqual([
    { op: "product_tasks.list", scope: scopeA, params: { dueOn: "2026-11-19" } },
    { op: "contacts.search", scope: scopeB, params: { query: "张" } },
  ]);
});

test("a turn sent while signed out has no native actions", async () => {
  const { turns, requests, call } = setup();
  turns.register("local", "s1", "user-none", null);
  await expect(call("product-tasks", { sessionId: "s1", messageId: "assistant-none", args: {} })).rejects.toMatchObject({ status: 409, code: "native_actions_scope_required" });
  expect(requests).toEqual([]);
});

test("an unknown turn, another session, or a remote workspace is refused", async () => {
  const local = setup();
  local.turns.register("local", "s1", "user-a", scopeA);
  await expect(local.call("product-tasks", { sessionId: "s1", messageId: "assistant-unknown", args: {} })).rejects.toMatchObject({ status: 409 });
  await expect(local.call("product-tasks", { sessionId: "s2", messageId: "assistant-a", args: {} })).rejects.toMatchObject({ status: 409 });
  const remote = setup("remote");
  remote.turns.register("local", "s1", "user-a", scopeA);
  await expect(remote.call("product-tasks", { sessionId: "s1", messageId: "assistant-a", args: {} })).rejects.toMatchObject({ status: 400 });
  expect([...local.requests, ...remote.requests]).toEqual([]);
});

test("arguments cannot choose an organization, account, address or path", async () => {
  const { turns, requests, call } = setup();
  turns.register("local", "s1", "user-a", scopeA);
  for (const args of [{ organizationId: "org-b" }, { baseUrl: "https://evil.test" }, { path: "/v1/tasks" }, { limit: 500 }, { dueOn: "2026-11-19", dueFrom: "2026-11-19T00:00:00Z" }]) {
    await expect(call("product-tasks", { sessionId: "s1", messageId: "assistant-a", args })).rejects.toThrow();
  }
  await expect(call("contacts", { sessionId: "s1", messageId: "assistant-a", args: { query: "张", limit: 50 } })).rejects.toThrow();
  expect(requests).toEqual([]);
});
