import { expect, test } from "bun:test";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import type { OfficeDocuments } from "../office/documents.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { registerOfficeRoutes } from "./office.js";
import { ApiError } from "../errors.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";

function fixture() {
  const document = { documentId: "doc", workspaceId: "ws", ownerSessionId: "chat", pageId: "page", engineFileId: "model", state: "ready" } as OfficeDocumentSession;
  const captures: unknown[][] = [], contexts: unknown[][] = [];
  const config = {} as ServerConfig;
  const documents = {
    get: async () => document,
    updateContext: (...args: unknown[]) => {
      if (args[2] !== document.pageId) throw new ApiError(409, "office_page_invalidated", "选区所属页面已失效");
      contexts.push(args);
    },
    selections: { capture: async (...args: unknown[]) => { captures.push(args); return { referenceId: "ref" }; } },
  };
  const routes: Route[] = [];
  registerOfficeRoutes({
    routes, config, documents: documents as unknown as OfficeDocuments,
    jsonResponse: (data, status) => Response.json(data, { status }),
    readJsonBody: (request) => request.json(), ensureWritable() {}, requireClientScope() {},
    resolveWorkspace: async () => ({ id: "ws", workspaceType: "local" }) as WorkspaceInfo,
  });
  const capture = async (extra: Record<string, unknown> = {}, reviewed = false) => {
    const url = new URL(`http://localhost/workspace/ws/office/doc/selection-references${reviewed ? "/review-confirmed" : ""}`);
    const route = matchRoute(routes, "POST", url.pathname)!;
    expect(route.auth).toBe(reviewed ? "host-token" : "client");
    const request = new Request(url, { method: "POST", body: JSON.stringify({ sessionId: "chat", pageId: "page", captureId: "capture", expectedSelection: { ranges: [] }, ...extra }) });
    return route.handler({ request, url, params: route.params, config } as RequestContext);
  };
  const review = (extra: Record<string, unknown> = {}) => capture({ expectedGeneration: "page:model", ...extra }, true);
  return { document, captures, contexts, capture, review };
}

test("capture API 普通采集不授权核对，仅 host-token 路由绑定 generation 后授权", async () => {
  const f = fixture();
  await f.capture({ expectedSelection: { reviewedUnconfirmed: true } });
  expect(f.captures[0]).toEqual([f.document, "capture", { reviewedUnconfirmed: true }, false]);
  await f.review();
  expect(f.captures[1]).toEqual([f.document, "capture", { ranges: [] }, true]);
});

for (const extra of [
  { reviewedUnconfirmed: "true", expectedGeneration: "page:model" },
  { reviewedUnconfirmed: 1, expectedGeneration: "page:model" },
  { reviewedUnconfirmed: true },
  { reviewedUnconfirmed: true, expectedGeneration: "" },
  { reviewedUnconfirmed: true, expectedGeneration: 123 },
  { reviewedUnconfirmed: false },
  { expectedGeneration: "page:model" },
]) test(`capture API 拒绝不完整确认 ${JSON.stringify(extra)}`, async () => {
  const f = fixture();
  await expect(f.capture(extra)).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
  expect(f.captures).toEqual([]);
  expect(f.contexts).toEqual([]);
});

for (const extra of [{ expectedGeneration: undefined }, { expectedGeneration: "" }, { expectedGeneration: 123 }, { reviewedUnconfirmed: true }])
  test(`host 核对 API 拒绝无效 body ${JSON.stringify(extra)}`, async () => {
    const f = fixture();
    await expect(f.review(extra)).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
    expect(f.captures).toEqual([]);
  });

for (const change of [{ pageId: "new-page" }, { engineFileId: "new-model" }, { engineFileId: null }, { state: "saving" }, { state: "error" }])
  test(`capture API 核对后模型变化不能传 true 到 core ${JSON.stringify(change)}`, async () => {
    const f = fixture();
    Object.assign(f.document, change);
    await expect(f.review()).rejects.toMatchObject({ status: 409, code: "office_selection_stale" });
    expect(f.captures).toEqual([]);
    expect(f.contexts).toEqual([]);
  });

test("capture API 核对不能跨聊天或页面", async () => {
  const f = fixture();
  await expect(f.review({ sessionId: "other" })).rejects.toMatchObject({ code: "office_wrong_document" });
  await expect(f.review({ pageId: "other" })).rejects.toMatchObject({ code: "office_page_invalidated" });
  expect(f.captures).toEqual([]);
});
