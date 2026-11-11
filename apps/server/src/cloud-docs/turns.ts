import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "../errors.js";

/**
 * 云文档引用，只含定位信息。
 * @param tenantId 云文档所属组织
 * @param workspaceId Docs 原生 Workspace
 * @param docId 页面标识
 * @param title 引用时的标题
 * @param blockIds 选区标签的块；为空表示整篇引用
 */
export interface CloudDocRef {
  tenantId: string;
  workspaceId: string;
  docId: string;
  title: string;
  blockIds?: string[];
}

/** 本轮提交的云文档上下文：引用、面板激活标签与当前组织。 */
export interface CloudDocTurnInput {
  currentTenantId: string | null;
  references: CloudDocRef[];
  activeDoc?: CloudDocRef | null;
}

/** 一次写入留下的可撤销记录，不含整篇正文。 */
export interface CloudDocChange {
  tenantId: string;
  workspaceId: string;
  docId: string;
  title: string;
  op: "replace" | "insert_after" | "insert_before" | "delete";
  blockId: string;
  before?: string;
  after?: string;
  blocks: Array<{ blockId: string; hash: string }>;
  predecessors?: string[];
  successors?: string[];
}

/** 卡片保留该轮文档汇总，撤销后重开会话仍可显示已撤销状态。 */
export interface CloudDocChangeSummary extends CloudDocRef { replaced: number; inserted: number; deleted: number; }

interface Turn extends CloudDocTurnInput {
  created: CloudDocRef[];
  changes: CloudDocChange[];
  summary?: CloudDocChangeSummary[];
  undone?: boolean;
}

const docKey = (ref: { workspaceId: string; docId: string }) => `${ref.workspaceId}/${ref.docId}`;

/** 每个用户轮次的云文档可写范围与变更记录，由接收消息时固定。 */
export class CloudDocTurns {
  private readonly turns = new Map<string, Turn>();

  /**
   * @param limit 最多保留的轮次数
   * @param persistPath 变更记录的持久化文件；只保存定位、修改前内容与 hash，不含整篇正文
   */
  constructor(private readonly limit = 500, private readonly persistPath?: string) {
    if (!persistPath) return;
    try {
      const saved = JSON.parse(readFileSync(persistPath, "utf8")) as Record<string, CloudDocChange[] | Pick<Turn, "changes" | "summary" | "undone">>;
      for (const [key, value] of Object.entries(saved))
        this.turns.set(key, { currentTenantId: null, references: [], activeDoc: null, created: [], ...(Array.isArray(value) ? { changes: value } : value) });
    } catch { /* 无记录或记录损坏时从空开始。 */ }
  }

  /** 记录或清空变更后落盘；写入失败不影响本轮编辑。 */
  persist() {
    if (!this.persistPath) return;
    const data: Record<string, Pick<Turn, "changes" | "summary" | "undone">> = {};
    for (const [key, turn] of this.turns) if (turn.changes.length || turn.summary?.length)
      data[key] = { changes: turn.changes, summary: turn.summary, undone: turn.undone };
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const temp = `${this.persistPath}.tmp`;
      writeFileSync(temp, JSON.stringify(data));
      renameSync(temp, this.persistPath);
    } catch { /* 持久化失败时仍保留内存记录。 */ }
  }

  private key(workspaceId: string, sessionId: string, messageId: string) {
    return JSON.stringify([workspaceId, sessionId, messageId]);
  }

  /** 接收用户消息时登记本轮范围。 */
  register(workspaceId: string, sessionId: string, messageId: string, input: CloudDocTurnInput) {
    const key = this.key(workspaceId, sessionId, messageId);
    const prior = this.turns.get(key);
    // TIPS: 失败重试沿用同一 messageId，已经写入的变更和新建文档不能因重新派发而丢失。
    this.turns.set(key, { ...input, created: prior?.created ?? [], changes: prior?.changes ?? [], summary: prior?.summary, undone: prior?.undone });
    this.evict();
  }

  /** 超出上限时淘汰最旧的轮次。 */
  private evict() {
    while (this.turns.size > this.limit) this.turns.delete(this.turns.keys().next().value!);
  }

  /** 读取本轮；未登记的轮次视为没有任何云文档引用。 */
  get(workspaceId: string, sessionId: string, messageId: string): Turn {
    const key = this.key(workspaceId, sessionId, messageId);
    let turn = this.turns.get(key);
    if (!turn) {
      turn = { currentTenantId: null, references: [], activeDoc: null, created: [], changes: [] };
      this.turns.set(key, turn);
      this.evict();
    }
    return turn;
  }

  /** 一次读取指定会话的全部变更轮次，不创建空轮次。 */
  session(workspaceId: string, sessionId: string) {
    return [...this.turns].flatMap(([key, turn]) => {
      const [w, s, messageId] = JSON.parse(key) as string[];
      return w === workspaceId && s === sessionId && (turn.changes.length || turn.summary?.length) ? [{ messageId, turn }] : [];
    });
  }

  /** 本轮新建或导入的文档自动进入可写范围。 */
  noteCreated(turn: Turn, ref: CloudDocRef) {
    turn.created.push(ref);
  }

  /** 可写范围描述，供 cloud_docs.context 返回。 */
  scope(turn: Turn) {
    const whole = new Map<string, CloudDocRef>();
    const selected = new Map<string, { ref: CloudDocRef; blockIds: Set<string> }>();
    for (const ref of turn.references) {
      if (ref.blockIds?.length) {
        const item = selected.get(docKey(ref)) ?? { ref, blockIds: new Set<string>() };
        ref.blockIds.forEach(id => item.blockIds.add(id));
        selected.set(docKey(ref), item);
      } else whole.set(docKey(ref), ref);
    }
    if (!turn.references.length && turn.activeDoc) whole.set(docKey(turn.activeDoc), turn.activeDoc);
    for (const ref of turn.created) whole.set(docKey(ref), ref);
    return { whole, selected };
  }

  /**
   * 校验写入范围：范围外文档只读，选区外块被拒绝，跨组织需先切换。
   * @param blockIds 本次操作触及的块
   * @returns 命中的范围引用，其 tenantId 为文档所属组织
   */
  assertWritable(turn: Turn, target: { workspaceId: string; docId: string }, blockIds: string[]): CloudDocRef {
    const { whole, selected } = this.scope(turn);
    const key = docKey(target);
    const matched = whole.get(key) ?? selected.get(key)?.ref;
    if (!matched) throw new ApiError(403, "cloud_doc_out_of_scope", "该云文档不在本轮可写范围内");
    if (turn.currentTenantId && matched.tenantId !== turn.currentTenantId)
      throw new ApiError(409, "cloud_doc_switch_organization", "该云文档属于其他组织，请切换组织后再操作");
    const selection = whole.has(key) ? undefined : selected.get(key);
    if (selection && blockIds.some(id => !selection.blockIds.has(id)))
      throw new ApiError(403, "cloud_doc_block_out_of_selection", "目标块不在所选范围内");
    return matched;
  }
}
