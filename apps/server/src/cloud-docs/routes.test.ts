import { expect, test } from "bun:test";
import { registerCloudDocsRoutes } from "../routes/cloud-docs.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { CloudDocsService } from "./service.js";
import { CloudDocTurns } from "./turns.js";

test("卡片接口必须显式指定所属 messageId，不回退到会话最近有变更的轮次", async () => {
  const routes: Route[] = [];
  const calls: unknown[] = [];
  registerCloudDocsRoutes({ routes, config: {} as any, service: {
    changes: (key: unknown) => { calls.push(key); return {}; },
    undo: async (key: unknown) => { calls.push(key); return {}; },
  } as any, jsonResponse: (data, status) => Response.json(data, { status }), readJsonBody: request => request.json(), ensureWritable() {}, requireClientScope() {}, resolveWorkspace: async () => ({ id: "local", workspaceType: "local" }) as any,
    resolveTurn: async () => { throw new Error("卡片不按助手消息解析轮次"); },
  });
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

test("助手工具解析真实用户轮次后读取选区、编辑并按用户消息汇总，不能借用其他轮次选区", async () => {
  const routes: Route[] = [];
  const turns = new CloudDocTurns();
  const ref = { tenantId: "t1", workspaceId: "docs-ws", docId: "doc1", title: "测试文档", blockIds: ["selected"] };
  turns.register("local", "s1", "user-1", { currentTenantId: "t1", references: [ref] });
  turns.register("local", "s1", "user-2", { currentTenantId: "t1", references: [] });
  const requests: unknown[] = [];
  const service = new CloudDocsService(turns, async input => {
    requests.push(input);
    return { status: 200, body: input.op === "edit"
      ? { title: ref.title, results: [{ op: "replace", blockId: "selected", status: "applied", before: "时代峰峻", blocks: [{ blockId: "selected", hash: "b".repeat(64) }] }] }
      : { title: ref.title, blocks: [{ blockId: "selected", markdown: "时代峰峻", hash: "a".repeat(64) }] } };
  });
  registerCloudDocsRoutes({ routes, config: {} as any, service,
    jsonResponse: (data, status) => Response.json(data, { status }), readJsonBody: request => request.json(), ensureWritable() {}, requireClientScope() {},
    resolveWorkspace: async () => ({ id: "local", workspaceType: "local" }) as any,
    resolveTurn: async (workspaceId, sessionId, messageId) => workspaceId === "local" && sessionId === "s1"
      ? ({ "assistant-1": "user-1", "assistant-follow-up": "user-1", "assistant-2": "user-2" } as Record<string, string>)[messageId] ?? null : null,
  });
  const call = async (name: string, messageId: string, extra: Record<string, unknown> = {}, sessionId = "s1") => {
    const post = name === "edit";
    const path = `/workspace/local/cloud-docs/${name}`;
    const route = matchRoute(routes, post ? "POST" : "GET", path)!;
    const args = { sessionId, messageId, ...extra };
    const url = new URL(`http://localhost${path}`);
    if (!post) for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
    return route.handler({ url, params: route.params, request: new Request(url, { method: post ? "POST" : "GET", ...(post ? { body: JSON.stringify(args) } : {}) }) } as any);
  };
  for (const message of ["assistant-1", "assistant-follow-up"]) {
    const context = await (await call("context", message)).json();
    expect(context.writable).toEqual([{ ...ref, scope: "selection" }]);
  }
  await call("read", "assistant-1", { workspaceId: ref.workspaceId, docId: ref.docId, blockIds: "selected" });
  const edit = (blockId: string) => ({ workspaceId: ref.workspaceId, docId: ref.docId,
    operations: [{ op: "replace", blockId, expectedHash: "a".repeat(64), markdown: "测试123" }] });
  await call("edit", "assistant-1", edit("selected"));
  expect(service.changes({ workspaceId: "local", sessionId: "s1", messageId: "user-1" }).changes).toHaveLength(1);
  expect(service.changes({ workspaceId: "local", sessionId: "s1", messageId: "assistant-1" }).changes).toHaveLength(0);
  await expect(call("edit", "assistant-1", edit("other-block"))).rejects.toMatchObject({ code: "cloud_doc_block_out_of_selection" });
  await expect(call("edit", "assistant-2", edit("selected"))).rejects.toMatchObject({ code: "cloud_doc_out_of_scope" });
  await expect(call("context", "assistant-1", {}, "other-session")).rejects.toMatchObject({ code: "cloud_doc_turn_unavailable" });
  await expect(call("context", "unknown-assistant")).rejects.toMatchObject({ code: "cloud_doc_turn_unavailable" });
  expect(requests).toHaveLength(2);
});
