import { ApiError } from "../errors.js";
import type { CloudDocsRequester } from "./bridge.js";
import { type CloudDocChange, type CloudDocRef, CloudDocTurns } from "./turns.js";

interface TurnKey {
  workspaceId: string;
  sessionId: string;
  messageId: string;
}

interface Operation {
  op: CloudDocChange["op"];
  blockId: string;
  expectedHash: string;
  markdown?: string;
}

/** 云文档工具的服务端逻辑：范围校验、Docs 代理与本轮变更记录。 */
export class CloudDocsService {
  constructor(
    readonly turns: CloudDocTurns,
    private readonly request: CloudDocsRequester
  ) {}

  /** 调用 Docs 接口；非 2xx 状态保留 Docs 返回的冲突信息。 */
  private async docs(tenantId: string, op: Parameters<CloudDocsRequester>[0]["op"], params: Record<string, unknown>) {
    const { status, body } = await this.request({ tenantId, op, params });
    if (status >= 400)
      throw new ApiError(status === 409 ? 409 : status, "cloud_docs_error", String(body?.message ?? body?.error ?? "云文档请求失败"), body);
    return body;
  }

  /** 本轮可写范围、引用、选区 blockId 与面板激活云文档。 */
  context(key: TurnKey) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    const { whole, selected } = this.turns.scope(turn);
    return {
      currentTenantId: turn.currentTenantId,
      writable: [
        ...[...whole.values()].map(ref => ({ ...ref, blockIds: undefined, scope: "document" as const })),
        ...[...selected.values()].map(({ ref, blockIds }) => ({ ...ref, blockIds: [...blockIds], scope: "selection" as const })),
      ],
      references: turn.references,
      activeDoc: turn.activeDoc ?? null,
    };
  }

  /** 按标题检索可读云文档；结果为数据，不扩大可写范围。 */
  async search(key: TurnKey, q: string, limit?: number) {
    const tenantId = this.tenant(key);
    return this.docs(tenantId, "search", { q, limit });
  }

  /** 读取页面；范围外文档只读，允许读取。 */
  async read(key: TurnKey, input: { workspaceId: string; docId: string; mode?: string; blockIds?: string[] }) {
    const tenantId = this.tenant(key);
    return this.docs(tenantId, "read", { ...input, blockIds: input.blockIds?.join(",") });
  }

  /** 先校验可写范围与选区，再提交 Docs 块级编辑并记录本轮变更。 */
  async edit(key: TurnKey, input: { workspaceId: string; docId: string; operations: Operation[] }) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    this.tenant(key);
    const { tenantId } = this.turns.assertWritable(turn, input, input.operations.map(o => o.blockId));
    const result = await this.docs(tenantId, "edit", { ...input, partial: false });
    this.record(turn.changes, tenantId, input, result);
    turn.summary = undefined;
    turn.summary = this.changes(key).documents;
    turn.undone = false;
    this.turns.persist();
    return result;
  }

  /** 新建页面并加入本轮可写范围。 */
  async create(key: TurnKey, input: { title: string; markdown: string }) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    const tenantId = this.tenant(key);
    const created = await this.docs(tenantId, "create", { ...input, sessionId: key.sessionId });
    this.turns.noteCreated(turn, { tenantId, workspaceId: created.workspaceId, docId: created.docId, title: input.title });
    return created;
  }

  /** 把会话工作区内的文件上传为云文档（重复文件直接返回已有页面），并加入本轮可写范围。 */
  async importFile(key: TurnKey, input: { localWorkspaceId: string; path: string }) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    const tenantId = this.tenant(key);
    const imported = await this.docs(tenantId, "import", { ...input, sessionId: key.sessionId });
    this.turns.noteCreated(turn, { tenantId, workspaceId: imported.workspaceId, docId: imported.pageId, title: String(input.path.split(/[\\/]/).pop()) });
    return imported;
  }

  /** 会话首页只返回各轮汇总；逐块内容在用户查看该轮时按需读取。 */
  sessionChanges(workspaceId: string, sessionId: string) {
    return { turns: this.turns.session(workspaceId, sessionId).map(({ messageId }) => {
      const { documents, undone } = this.changes({ workspaceId, sessionId, messageId });
      return { messageId, documents, undone };
    }) };
  }

  /** 本轮变更，按文档汇总改／增／删数量。 */
  changes(key: TurnKey) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    const documents = new Map<string, { tenantId: string; workspaceId: string; docId: string; title: string; replaced: number; inserted: number; deleted: number }>();
    for (const change of turn.changes) {
      const id = `${change.workspaceId}/${change.docId}`;
      const item = documents.get(id) ?? { tenantId: change.tenantId, workspaceId: change.workspaceId, docId: change.docId, title: change.title, replaced: 0, inserted: 0, deleted: 0 };
      if (change.op === "replace") item.replaced += 1;
      else if (change.op === "delete") item.deleted += 1;
      else item.inserted += 1;
      documents.set(id, item);
    }
    return { documents: turn.summary ?? [...documents.values()], changes: turn.changes, undone: turn.undone === true };
  }

  /** 用修改前内容提交 partial 反向操作；撤销成功的记录立即移除，冲突的保留，重复撤销不会重复恢复。 */
  async undo(key: TurnKey) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    let restored = 0;
    let conflicts = 0;
    for (const change of [...turn.changes].reverse()) {
      const outcome = await this.undoChange(change, turn.changes);
      if (outcome === "restored") {
        restored += 1;
        turn.changes = turn.changes.filter(item => item !== change);
        this.turns.persist();
      } else conflicts += 1;
    }
    turn.undone = turn.changes.length === 0;
    this.turns.persist();
    return { restored, conflicts };
  }

  private async undoChange(change: CloudDocChange, pending: CloudDocChange[]): Promise<"restored" | "conflict"> {
    const read = async (blockIds: string[]) =>
      this.docs(change.tenantId, "read", { workspaceId: change.workspaceId, docId: change.docId, blockIds: blockIds.join(",") });
    const submit = async (operations: Operation[], restoringDeleted = false) => {
      const result = await this.docs(change.tenantId, "edit", { workspaceId: change.workspaceId, docId: change.docId, operations, partial: true });
      const ok = result.results?.length === operations.length && result.results.every((r: { status: string }) => r.status === "applied");
      const restored: Array<{ blockId: string; hash: string }> = result.results?.[0]?.blocks ?? [];
      if (ok && restoringDeleted && restored.length) {
        // TIPS: 原生插回会分配新块 id；同轮其他删除记录必须指向恢复后的邻居，才能连续撤销整段删除。
        for (const item of pending) {
          if (item.workspaceId !== change.workspaceId || item.docId !== change.docId || item === change) continue;
          item.predecessors = item.predecessors?.flatMap(id => id === change.blockId ? restored.map(block => block.blockId).reverse() : [id]);
          item.successors = item.successors?.flatMap(id => id === change.blockId ? restored.map(block => block.blockId) : [id]);
          item.blocks = item.blocks.flatMap(block => block.blockId === change.blockId ? restored : [block]);
        }
      }
      return ok;
    };
    const current = async (blockId: string) => {
      const body = await read([blockId]);
      return body.blocks?.find((b: { blockId: string }) => b.blockId === blockId)?.hash as string | undefined;
    };
    if (change.op === "replace" && change.before !== undefined) {
      const hash = await current(change.blocks[0]?.blockId ?? change.blockId);
      if (!hash || hash !== change.blocks[0]?.hash) return "conflict";
      const ok = await submit([{ op: "replace", blockId: change.blocks[0].blockId, expectedHash: hash, markdown: change.before }]);
      if (!ok) return "conflict";
      // TIPS: 主块恢复后只保留尚待删除的新块；后续冲突重试不会再次覆盖主块。
      change.op = "insert_after";
      change.before = undefined;
      change.blocks = change.blocks.slice(1);
      this.turns.persist();
      if (!change.blocks.length) return "restored";
    }
    if (change.op === "delete" && change.before !== undefined) {
      for (const anchor of change.predecessors ?? []) {
        const hash = await current(anchor);
        if (!hash) continue;
        return (await submit([{ op: "insert_after", blockId: anchor, expectedHash: hash, markdown: change.before }], true)) ? "restored" : "conflict";
      }
      for (const anchor of change.successors ?? []) {
        const hash = await current(anchor);
        if (!hash) continue;
        return (await submit([{ op: "insert_before", blockId: anchor, expectedHash: hash, markdown: change.before }], true)) ? "restored" : "conflict";
      }
      // TIPS: 删除首段或全部正文后没有前驱；仅在服务端确认空页时使用插入锚点，不覆盖后来新增的正文。
      const { insertionAnchor } = await this.docs(change.tenantId, "read", { workspaceId: change.workspaceId, docId: change.docId, mode: "outline" });
      if (insertionAnchor?.blockId && insertionAnchor.hash)
        return (await submit([{ op: "insert_after", blockId: insertionAnchor.blockId, expectedHash: insertionAnchor.hash, markdown: change.before }], true)) ? "restored" : "conflict";
      return "conflict";
    }
    // 插入的块：仍未被他人修改时删除。
    let ok = true;
    for (const block of [...change.blocks]) {
      const hash = await current(block.blockId);
      if (!hash || hash !== block.hash) { ok = false; continue; }
      if (await submit([{ op: "delete", blockId: block.blockId, expectedHash: hash }])) {
        change.blocks = change.blocks.filter(item => item !== block);
        this.turns.persist();
      } else ok = false;
    }
    return ok ? "restored" : "conflict";
  }

  private tenant(key: TurnKey) {
    const turn = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    if (!turn.currentTenantId) throw new ApiError(409, "cloud_docs_organization_required", "请先登录并进入组织");
    return turn.currentTenantId;
  }

  private record(changes: CloudDocChange[], tenantId: string, input: { workspaceId: string; docId: string; operations: Operation[] }, result: any) {
    const title = String(result.title ?? "");
    for (const item of result.results ?? []) {
      if (item.status !== "applied") continue;
      changes.push({
        tenantId, workspaceId: input.workspaceId, docId: input.docId, title,
        op: item.op, blockId: item.blockId, before: item.before, after: input.operations.find(op => op.blockId === item.blockId)?.markdown, blocks: item.blocks ?? [], predecessors: item.predecessors, successors: item.successors,
      });
    }
  }
}

export type { CloudDocRef };
