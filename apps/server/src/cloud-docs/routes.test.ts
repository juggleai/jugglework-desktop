import { expect, test } from "bun:test";
import { registerCloudDocsRoutes } from "../routes/cloud-docs.js";
import { matchRoute, type Route } from "../routes/registry.js";

test("卡片接口必须显式指定所属 messageId，不回退到会话最近有变更的轮次", async () => {
  const routes: Route[] = [];
  const calls: unknown[] = [];
  registerCloudDocsRoutes({ routes, config: {} as any, service: {
    changes: (key: unknown) => { calls.push(key); return {}; },
    undo: async (key: unknown) => { calls.push(key); return {}; },
  } as any, jsonResponse: (data, status) => Response.json(data, { status }), readJsonBody: request => request.json(), ensureWritable() {}, requireClientScope() {}, resolveWorkspace: async () => ({ id: "local", workspaceType: "local" }) as any });
  for (const method of ["GET", "POST"]) {
    const path = `/workspace/local/cloud-docs/${method === "GET" ? "changes" : "undo"}`;
    const route = matchRoute(routes, method, path)!;
    const context = (messageId?: string) => {
      const url = new URL(`http://localhost${path}?sessionId=s1${messageId ? `&messageId=${messageId}` : ""}`);
      return { url, params: route.params, request: new Request(url, { method, ...(method === "POST" ? { body: JSON.stringify({ sessionId: "s1", ...(messageId ? { messageId } : {}) }) } : {}) }) } as any;
    };
    await expect(route.handler(context())).rejects.toMatchObject({ status: 400 });
    await route.handler(context("m1"));
  }
  expect(calls).toEqual([{ workspaceId: "local", sessionId: "s1", messageId: "m1" }, { workspaceId: "local", sessionId: "s1", messageId: "m1" }]);
});
