import { expect, test } from "bun:test";
import { CloudDocsService } from "./service.js";
import { CloudDocTurns } from "./turns.js";

const key = { workspaceId: "local", sessionId: "s1", messageId: "m1" };
const doc = { tenantId: "t1", workspaceId: "dw", docId: "d1", title: "方案" };

/** 记录 Docs 请求并按脚本返回响应。 */
function setup(respond: (op: string, params: any) => { status?: number; body: any }) {
  const calls: Array<{ op: string; params: any }> = [];
  const turns = new CloudDocTurns();
  const service = new CloudDocsService(turns, async ({ op, params }) => {
    calls.push({ op, params });
    const result = respond(op, params);
    return { status: result.status ?? 200, body: result.body };
  });
  return { service, turns, calls };
}
const edit = (blockId: string) => ({ workspaceId: "dw", docId: "d1", operations: [{ op: "replace" as const, blockId, expectedHash: "a".repeat(64), markdown: "x" }] });

test("选区外块与范围外文档的写入被拒绝，整篇引用可写", async () => {
  const { service, turns, calls } = setup(() => ({ body: { title: "方案", results: [] } }));
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [{ ...doc, blockIds: ["b1"] }] });
  await expect(service.edit(key, edit("b2"))).rejects.toMatchObject({ code: "cloud_doc_block_out_of_selection" });
  await expect(service.edit(key, { ...edit("b1"), docId: "other" })).rejects.toMatchObject({ code: "cloud_doc_out_of_scope" });
  await service.edit(key, edit("b1"));
  expect(calls.map(c => c.op)).toEqual(["edit"]);
  turns.register("local", "s1", "m2", { currentTenantId: "t1", references: [doc] });
  await service.edit({ ...key, messageId: "m2" }, edit("anything"));
});

test("面板激活标签仅在无引用时可写，跨组织引用要求切换组织", async () => {
  const { service, turns } = setup(() => ({ body: { title: "方案", results: [] } }));
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [], activeDoc: doc });
  await service.edit(key, edit("b1"));
  turns.register("local", "s1", "m2", { currentTenantId: "t1", references: [{ ...doc, docId: "d2" }], activeDoc: doc });
  await expect(service.edit({ ...key, messageId: "m2" }, edit("b1"))).rejects.toMatchObject({ code: "cloud_doc_out_of_scope" });
  turns.register("local", "s1", "m3", { currentTenantId: "t2", references: [doc] });
  await expect(service.edit({ ...key, messageId: "m3" }, edit("b1"))).rejects.toMatchObject({ code: "cloud_doc_switch_organization" });
});

test("本轮新建的文档自动可写", async () => {
  const { service, turns } = setup(op => op === "create" ? { body: { workspaceId: "dw", docId: "new1" } } : { body: { title: "新", results: [] } });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [] });
  await service.create(key, { title: "新", markdown: "hi" });
  await service.edit(key, { ...edit("b1"), docId: "new1" });
});

test("变更按文档汇总，撤销用修改前内容 partial 提交并报告冲突", async () => {
  const applied = { op: "replace", blockId: "b1", status: "applied", before: "旧", blocks: [{ blockId: "b1", hash: "h2" }] };
  const { service, turns, calls } = setup((op, params) => {
    if (op === "edit" && !params.partial) return { body: { title: "方案", results: [applied] } };
    if (op === "read") return { body: { blocks: [{ blockId: "b1", hash: "h2" }] } };
    return { body: { results: [{ status: "applied" }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  await service.edit(key, edit("b1"));
  expect(service.changes(key).documents).toEqual([{ ...doc, replaced: 1, inserted: 0, deleted: 0 }]);
  expect(await service.undo(key)).toEqual({ restored: 1, conflicts: 0 });
  const undo = calls.at(-1)!;
  expect(undo.params.partial).toBe(true);
  expect(undo.params.operations).toEqual([{ op: "replace", blockId: "b1", expectedHash: "h2", markdown: "旧" }]);
  expect(service.changes(key).changes).toHaveLength(0);
});

test("被他人修改的块撤销时跳过并保留记录", async () => {
  const applied = { op: "replace", blockId: "b1", status: "applied", before: "旧", blocks: [{ blockId: "b1", hash: "h2" }] };
  const { service, turns } = setup((op, params) => {
    if (op === "edit" && !params.partial) return { body: { title: "方案", results: [applied] } };
    return { body: { blocks: [{ blockId: "b1", hash: "changed-by-someone" }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  await service.edit(key, edit("b1"));
  expect(await service.undo(key)).toEqual({ restored: 0, conflicts: 1 });
  expect(service.changes(key).changes).toHaveLength(1);
});

test("变更记录落盘后可由新实例读取", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "cloud-doc-")), "changes.json");
  const applied = { op: "replace", blockId: "b1", status: "applied", before: "旧", blocks: [{ blockId: "b1", hash: "h2" }] };
  const turns = new CloudDocTurns(500, file);
  const service = new CloudDocsService(turns, async () => ({ status: 200, body: { title: "方案", results: [applied] } }));
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  await service.edit(key, edit("b1"));
  const restored = new CloudDocsService(new CloudDocTurns(500, file), async () => ({ status: 200, body: {} }));
  expect(restored.changes(key).changes).toHaveLength(1);
  expect(restored.changes({ ...key, messageId: "m9" }).changes).toHaveLength(0);
});

test("部分冲突后再次撤销不会重复恢复已成功的记录", async () => {
  const del = { op: "delete", blockId: "b1", status: "applied", before: "删了", blocks: [], predecessors: ["p1"] };
  const rep = { op: "replace", blockId: "b2", status: "applied", before: "旧", blocks: [{ blockId: "b2", hash: "h2" }, { blockId: "x1", hash: "hx" }] };
  const submitted: any[] = [];
  let changed = true;
  const { service, turns } = setup((op, params) => {
    if (op === "edit" && !params.partial) return { body: { title: "方案", results: [del, rep] } };
    if (op === "read") {
      const id = String(params.blockIds);
      return { body: { blocks: [{ blockId: id, hash: id === "b2" && changed ? "other" : id === "b2" ? "h2" : id === "x1" ? "hx" : "ph" }] } };
    }
    submitted.push(params.operations);
    return { body: { results: [{ status: "applied" }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  await service.edit(key, { workspaceId: "dw", docId: "d1", operations: [{ op: "delete", blockId: "b1", expectedHash: "a".repeat(64) }, { op: "replace", blockId: "b2", expectedHash: "a".repeat(64), markdown: "x" }] });
  expect(await service.undo(key)).toEqual({ restored: 1, conflicts: 1 });
  expect(service.changes(key).changes.map(c => c.blockId)).toEqual(["b2"]);
  changed = false;
  expect(await service.undo(key)).toEqual({ restored: 1, conflicts: 0 });
  // delete 只插回一次；多块替换的额外块 x1 被删除。
  expect(submitted.filter(ops => ops[0].op === "insert_after")).toHaveLength(1);
  expect(submitted.some(ops => ops[0].op === "delete" && ops[0].blockId === "x1")).toBe(true);
});

test("较早轮次的卡片只撤销该轮，之后轮次的记录不受影响", async () => {
  const { service, turns } = setup((op, params) => {
    if (op === "read") return { body: { blocks: [{ blockId: params.blockIds, hash: "new" }] } };
    return { body: { results: [{ status: "applied" }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  turns.register("local", "s1", "m2", { currentTenantId: "t1", references: [doc] });
  const change = { ...doc, op: "replace" as const, blockId: "b1", before: "old", blocks: [{ blockId: "b1", hash: "new" }] };
  turns.get("local", "s1", "m1").changes.push(change);
  turns.get("local", "s1", "m2").changes.push({ ...change, blockId: "b2", blocks: [{ blockId: "b2", hash: "new" }] });
  await service.undo(key);
  expect(service.changes(key).changes).toHaveLength(0);
  expect(service.changes({ ...key, messageId: "m2" }).changes).toHaveLength(1);
});

test("单次插入多个块，部分撤销成功后只重试冲突块", async () => {
  let conflict = true;
  const deleted: string[] = [];
  const { service, turns } = setup((op, params) => {
    if (op === "read") return { body: { blocks: [{ blockId: params.blockIds, hash: params.blockIds === "b2" && conflict ? "someone" : "new" }] } };
    deleted.push(params.operations[0].blockId);
    return { body: { results: [{ status: "applied" }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  turns.get("local", "s1", "m1").changes.push({ ...doc, op: "insert_after", blockId: "anchor", blocks: [{ blockId: "b1", hash: "new" }, { blockId: "b2", hash: "new" }] });
  expect(await service.undo(key)).toEqual({ restored: 0, conflicts: 1 });
  expect(service.changes(key).changes[0].blocks.map(block => block.blockId)).toEqual(["b2"]);
  conflict = false;
  expect(await service.undo(key)).toEqual({ restored: 1, conflicts: 0 });
  expect(deleted).toEqual(["b1", "b2"]);
});

test("完整撤销后重新打开会话仍显示该轮已撤销卡片", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cloud-doc-undone-"));
  try {
    const file = join(dir, "changes.json");
    const turns = new CloudDocTurns(500, file);
    const service = new CloudDocsService(turns, async ({ op }) => ({ status: 200, body: op === "read" ? { blocks: [{ blockId: "b1", hash: "new" }] } : { title: "方案", results: [{ op: "replace", blockId: "b1", status: "applied", before: "old", blocks: [{ blockId: "b1", hash: "new" }] }] } }));
    turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
    await service.edit(key, edit("b1"));
    await service.undo(key);
    const restored = new CloudDocsService(new CloudDocTurns(500, file), async () => ({ status: 200, body: {} }));
    expect(restored.changes(key)).toMatchObject({ undone: true, documents: [{ ...doc, replaced: 1 }], changes: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("按会话一次返回全部轮次汇总，详情按需读取，其他工作区和会话不混入", () => {
  const { service, turns, calls } = setup(() => ({ body: {} }));
  const change = { ...doc, op: "replace" as const, blockId: "b1", before: "不应在汇总返回的正文", blocks: [{ blockId: "b1", hash: "new" }] };
  for (let i = 0; i < 100; i++) turns.get("local", "s1", `m${i}`).changes.push(change);
  turns.get("other", "s1", "foreign").changes.push(change);
  turns.get("local", "s2", "other-session").changes.push(change);
  const result = service.sessionChanges("local", "s1");
  expect(result.turns).toHaveLength(100);
  expect(JSON.stringify(result)).not.toContain("不应在汇总返回的正文");
  expect(result.turns.every(turn => turn.messageId.startsWith("m"))).toBe(true);
  expect(calls).toEqual([]);
});

test("删除首段用仍存在的后继恢复；删除全部正文只使用服务端空页锚点", async () => {
  for (const empty of [false, true]) {
    const { service, turns, calls } = setup((op, params) => {
      if (op === "read") return { body: empty ? { blocks: [], insertionAnchor: { blockId: "d1", hash: "empty-hash" } } : { blocks: [{ blockId: "next", hash: "next-hash" }] } };
      return { body: { results: [{ status: "applied" }] } };
    });
    turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
    turns.get("local", "s1", "m1").changes.push({ ...doc, op: "delete", blockId: "removed", before: "first", blocks: [], predecessors: [], successors: empty ? [] : ["next"] });
    expect(await service.undo(key)).toEqual({ restored: 1, conflicts: 0 });
    expect(calls.at(-1)?.params.operations).toEqual([{ op: empty ? "insert_after" : "insert_before", blockId: empty ? "d1" : "next", expectedHash: empty ? "empty-hash" : "next-hash", markdown: "first" }]);
  }
});

test("连续删除全部正文后，撤销逐步映射原生新块 id，完整恢复原顺序", async () => {
  const body: string[] = [];
  const { service, turns } = setup((op, params) => {
    if (op === "read") return { body: body.length ? { blocks: body.map(blockId => ({ blockId, hash: "h" })) } : { blocks: [], insertionAnchor: { blockId: "d1", hash: "empty" } } };
    const action = params.operations[0];
    const newId = `restored-${action.markdown}`;
    const index = body.indexOf(action.blockId);
    body.splice(index < 0 ? 0 : index + (action.op === "insert_after" ? 1 : 0), 0, newId);
    return { body: { results: [{ status: "applied", blocks: [{ blockId: newId, hash: "h" }] }] } };
  });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  for (let i = 1; i <= 3; i++) turns.get("local", "s1", "m1").changes.push({ ...doc, op: "delete", blockId: `b${i}`, before: String(i), blocks: [], predecessors: Array.from({ length: i - 1 }, (_, n) => `b${i - n - 1}`), successors: Array.from({ length: 3 - i }, (_, n) => `b${i + n + 1}`) });
  expect(await service.undo(key)).toEqual({ restored: 3, conflicts: 0 });
  expect(body).toEqual(["restored-1", "restored-2", "restored-3"]);
});

test("同一消息失败重试重新登记时保留已写入记录和本轮新建文档", () => {
  const turns = new CloudDocTurns();
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  const turn = turns.get("local", "s1", "m1");
  turn.changes.push({ ...doc, op: "replace", blockId: "b1", before: "old", blocks: [{ blockId: "b1", hash: "new" }] });
  turns.noteCreated(turn, { ...doc, docId: "created" });
  turns.register("local", "s1", "m1", { currentTenantId: "t1", references: [doc] });
  const retry = turns.get("local", "s1", "m1");
  expect(retry.changes).toHaveLength(1);
  expect(turns.assertWritable(retry, { workspaceId: "dw", docId: "created" }, ["any"]).docId).toBe("created");
});
