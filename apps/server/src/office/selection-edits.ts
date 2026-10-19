import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OfficeDocumentSession, OfficeSelectionLocator, OfficeSelectionReference } from "@jugglework/types/office";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import { ApiError } from "../errors.js";
import { parseOfficeSelection } from "./selection.js";
import { officeSelectionToolNames, planOfficeSelectionTool } from "./selection-tools.js";
import { officeDocRangeParts, officeProofJson, readOfficeSelectionProof, verifyOfficeSelectionEdit, type OfficeSelectionProof } from "./selection-proof.js";

const id = z.string().min(1).max(256);
const instruction = z.object({
  instructionId: id, text: z.string().max(32_768),
  bindingState: z.enum(["bound", "needs-selection", "detached"]),
  referenceIds: z.array(id).max(16),
}).strict();
/** 消息边界只接收引用身份和指令关联，不允许客户端提交可执行坐标。 */
export const officeSelectionSubmissionSchema = z.object({
  officeSelectionRefs: z.array(id).max(16).optional(),
  officeInstructions: z.array(instruction).max(32).optional(),
});
export type OfficeSelectionSubmission = z.infer<typeof officeSelectionSubmissionSchema>;

interface ReferenceRecord {
  value: OfficeSelectionReference;
  fileId: string;
  proof: OfficeSelectionProof;
  /** 已按模型核对的完整所选正文，供模型读取；不保留整篇证明，也不作为写入坐标来源。 */
  docContents?: Array<{ begin: number; end: number; paragraphs: string[] }>;
  /** 仅用于修改后核对和保存；不替换公开固定定位，不能授权下一次写入。 */
  readLocator?: OfficeSelectionLocator;
}
interface Execution {
  references: ReferenceRecord[];
  baselines: Map<string, OfficeSelectionProof>;
  state: "ready" | "running" | "coordinates-changed" | "needs-verification";
}
interface Turn {
  fingerprint: string;
  references: Map<string, ReferenceRecord>;
  executions: Map<string, Execution>;
  instructions: NonNullable<OfficeSelectionSubmission["officeInstructions"]>;
}
interface Options {
  document: (workspaceId: string, sessionId: string, documentId: string) => Promise<OfficeDocumentSession>;
  prepare: (document: OfficeDocumentSession) => Promise<void>;
  selection: (document: OfficeDocumentSession) => Promise<unknown>;
  tool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  modified: (document: OfficeDocumentSession, messageId: string, name: string, args: Record<string, unknown>, result: unknown) => Promise<void>;
  save: (document: OfficeDocumentSession) => Promise<OfficeDocumentSession>;
}

function stale(message = "选区已变化，请重新选择"): never {
  throw new ApiError(409, "office_selection_stale", message);
}
function generation(document: OfficeDocumentSession): string {
  // 页面代次由 Server 生成，原生模型变化也必须换代；窗口迁移保留这两个身份。
  return `${document.pageId}:${document.engineFileId}`;
}
function domain(locator: OfficeSelectionLocator): string {
  return "sheetId" in locator ? `sheet:${locator.sheetId}`
    : "pageIndex" in locator ? `slide:${locator.pageIndex}` : locator.kind.startsWith("doc-") ? "doc" : "unsupported";
}
function turnKey(workspaceId: string, sessionId: string, turnId: string): string {
  return JSON.stringify([workspaceId, sessionId, turnId]);
}

/** 宿主选区引用与本轮执行所有者；不读取全局当前 tab，不将草稿清理传播到已接收任务。 */
export class OfficeSelectionEdits {
  private readonly references = new Map<string, ReferenceRecord>();
  private readonly captures = new Map<string, string>();
  private readonly turns = new Map<string, Turn>();

  constructor(private readonly options: Options) {}

  private async live(record: ReferenceRecord): Promise<OfficeDocumentSession> {
    const ref = record.value;
    const document = await this.options.document(ref.workspaceId, ref.ownerSessionId, ref.documentId);
    if (document.state !== "ready" || !document.engineFileId || document.engineFileId !== record.fileId || generation(document) !== ref.modelGeneration) stale();
    return document;
  }
  private async read(record: ReferenceRecord, coverage = [record.value.locator]): Promise<OfficeSelectionProof> {
    await this.live(record);
    const proof = await readOfficeSelectionProof(this.options.tool, record.fileId, record.readLocator ?? record.value.locator, coverage);
    await this.live(record);
    return proof;
  }

  /**
   * 在输入浮层聚焦前完成原生输入提交、固定原选择及同状态证明；重复 captureId 不重采光标。
   * @param document 已由宿主及页面身份校验的所属文档
   * @param captureId 当前明确打开浮层动作的唯一身份
   * @param expectedSelection 已绑定原生页面在入口动作中同步冻结的选区；省略时由宿主实时读取
   */
  async capture(document: OfficeDocumentSession, captureId: string, expectedSelection?: unknown): Promise<OfficeSelectionReference> {
    id.parse(captureId);
    if (document.state !== "ready" || !document.engineFileId) stale("请等待文档就绪后重新选择");
    const key = JSON.stringify([document.workspaceId, document.documentId, document.pageId, captureId]);
    const previous = this.captures.get(key);
    if (previous) {
      const existing = this.references.get(previous);
      if (!existing) stale();
      await this.live(existing);
      return structuredClone(existing.value);
    }
    const kind = getOfficeDocumentKind(document.relativePath)!;
    // TIPS: 原生按钮在 pointerdown 同步读取并通过已绑定页面提交冻结值。
    // IPC 往返后 SDK 可能已收回光标；此时重读当前选择会改投目标，必须用冻结内容与真实模型核对。
    const original = parseOfficeSelection(kind, expectedSelection === undefined ? await this.options.selection(document) : expectedSelection);
    if (!original?.locator) stale("请选择支持的文字或单元格范围");
    await this.options.prepare(document);
    if (expectedSelection === undefined) {
      const afterCommit = parseOfficeSelection(kind, await this.options.selection(document));
      if (!afterCommit?.locator || officeProofJson({ locator: original.locator, data: original.data }) !== officeProofJson({ locator: afterCommit.locator, data: afterCommit.data })) stale("输入提交后选区已变化，请重新选择");
    }
    const reference: ReferenceRecord = {
      fileId: document.engineFileId,
      proof: { stamp: "", state: {} },
      value: {
        referenceId: `osr_${randomUUID()}`, workspaceId: document.workspaceId,
        ownerSessionId: document.ownerSessionId, documentId: document.documentId,
        modelGeneration: generation(document), sourcePageId: document.pageId, captureId,
        locator: original.locator, contentStamp: "", capturedAt: Date.now(),
        preview: { name: document.name, path: document.relativePath, range: "", text: String(original.data.description ?? "").slice(0, 160) },
      },
    };
    const first = await this.read(reference);
    if (expectedSelection === undefined) {
      const selected = parseOfficeSelection(kind, await this.options.selection(document));
      if (!selected?.locator || officeProofJson({ locator: selected.locator, data: selected.data }) !== officeProofJson({ locator: original.locator, data: original.data })) stale();
    }
    const second = await this.read(reference);
    if (first.stamp !== second.stamp) stale();
    if (original.locator.kind === "sheet-rows" || original.locator.kind === "sheet-columns") {
      const locator = original.locator;
      const sheet = (second.state.sheets as Array<{ sheet_id: string; row_count: number; col_count: number }>).find((item) => item.sheet_id === locator.sheetId)!;
      const ranges = original.data.ranges as Array<{ startRowIndex: number; endRowIndex: number; startColIndex: number; endColIndex: number }>;
      if (ranges.some((range) => locator.kind === "sheet-rows" ? range.startColIndex !== 0 || range.endColIndex !== sheet.col_count - 1 : range.startRowIndex !== 0 || range.endRowIndex !== sheet.row_count - 1)) stale("完整行列范围与当前网格不一致，请重新选择");
    }
    // TIPS: 页面选择的文字也必须与原生坐标中的完整文字一致，不能把滞后页面配到更新模型。
    if (original.locator.kind === "doc-text") {
      reference.docContents = original.locator.ranges.map((range) => ({ ...range, paragraphs: officeDocRangeParts(second.state, range).map((part) => part.text) }));
      const text = reference.docContents.map((range) => range.paragraphs.join("\r")).join("");
      if (text !== original.data.description) stale("页面文字尚未同步，请等待后重新选择");
    }
    if (original.locator.kind === "slide-text") {
      const locator = original.locator;
      const text = (second.state.texts as Array<{ shapeId: string; text: string }>).find((item) => item.shapeId === locator.shapeId)?.text;
      const selectedText = (original.data.textSelection as { selectedText?: string } | undefined)?.selectedText;
      if (typeof text !== "string" || selectedText !== text.slice(locator.start, locator.start + locator.count)) stale("页面文字尚未同步，请等待后重新选择");
    }
    // 完整证明只在采集时使用；未发送登记保留摘要，避免为每个标签重复保存相同文档。
    reference.proof = { stamp: second.stamp, state: {} };
    reference.value.contentStamp = second.stamp;
    reference.value.preview.range = this.rangeLabel(reference.value.locator, second);
    if (!reference.value.preview.text && reference.value.locator.kind === "slide-text") {
      const text = (second.state.texts as Array<{ shapeId: string; text: string }>).find((item) => item.shapeId === (original.locator as { shapeId: string }).shapeId)?.text ?? "";
      reference.value.preview.text = text.slice(reference.value.locator.start, reference.value.locator.start + reference.value.locator.count).slice(0, 160);
    }
    const owned = [...this.references.values()].filter((item) => item.value.workspaceId === document.workspaceId && item.value.ownerSessionId === document.ownerSessionId);
    if (owned.length >= 64) throw new ApiError(409, "office_selection_capacity", "选区过多，请先移除不再使用的选区");
    this.references.set(reference.value.referenceId, reference);
    this.captures.set(key, reference.value.referenceId);
    return structuredClone(reference.value);
  }

  private rangeLabel(locator: OfficeSelectionLocator, proof: OfficeSelectionProof): string {
    if (locator.kind === "doc-caret") return `光标 ${locator.idx}`;
    if (locator.kind === "doc-text") return locator.ranges.map((range) => `${range.begin}–${range.end}`).join("、");
    if ("sheetId" in locator) {
      const sheet = (proof.state.sheets as Array<{ sheet_id: string; name: string }>).find((item) => item.sheet_id === locator.sheetId);
      const column = (index: number) => { let name = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
      if (locator.kind === "sheet-rows") return `${sheet?.name ?? locator.sheetId}!${locator.ranges.map((range) => `${range.start + 1}:${range.end + 1}`).join("、")}`;
      if (locator.kind === "sheet-columns") return `${sheet?.name ?? locator.sheetId}!${locator.ranges.map((range) => `${column(range.start)}:${column(range.end)}`).join("、")}`;
      return `${sheet?.name ?? locator.sheetId}!${locator.ranges.map((range) => {
        const first = `${column(range.startCol)}${range.startRow + 1}`, last = `${column(range.endCol)}${range.endRow + 1}`;
        return first === last ? first : `${first}:${last}`;
      }).join("、")}`;
    }
    if ("pageIndex" in locator) return `第 ${locator.pageIndex + 1} 页${locator.kind === "slide-text" ? " · 文字选区" : ` · ${locator.shapeIds.length} 个文本框`}`;
    return "选区";
  }

  /** 删除未发送登记；已接收消息持有独立快照，历史任务不会因此失去目标。 */
  release(workspaceId: string, sessionId: string, ids: string[]): void {
    for (const id of ids) {
      const record = this.references.get(id);
      if (record?.value.workspaceId === workspaceId && record.value.ownerSessionId === sessionId) {
        this.references.delete(id);
        // 保留捕获身份的墓碑，晚到的同一次采集不能重新建立刚移除的标签。
      }
    }
  }

  /** 模型关闭、恢复或失效时释放其内容证明；轮次标记保留，旧任务不能降级成当前文件编辑。 */
  retireDocument(workspaceId: string, documentId: string): void {
    for (const [id, record] of this.references) if (record.value.workspaceId === workspaceId && record.value.documentId === documentId) this.references.delete(id);
    for (const turn of this.turns.values()) {
      const execution = turn.executions.get(documentId);
      if (!execution || execution.references[0]?.value.workspaceId !== workspaceId) continue;
      execution.state = "needs-verification";
      execution.baselines.clear();
    }
  }

  /** 添加、发送或入队前核对草稿中的固定引用，不登记新轮次，不读取当前光标替代。 */
  async validate(workspaceId: string, sessionId: string, ids: string[]): Promise<void> {
    if (ids.length > 16) stale("本次选区过多，请拆分发送");
    for (const id of ids) {
      const record = this.references.get(id);
      if (!record || record.value.workspaceId !== workspaceId || record.value.ownerSessionId !== sessionId) stale();
      if ((await this.read(record)).stamp !== record.proof.stamp) stale();
    }
  }

  /** 标签定位只读取仍有效的草稿引用；不接收客户端给出的坐标或替代模型。 */
  async reveal(workspaceId: string, sessionId: string, referenceId: string): Promise<OfficeSelectionReference> {
    await this.validate(workspaceId, sessionId, [referenceId]);
    return structuredClone(this.references.get(referenceId)!.value);
  }

  /** 消息接收前核对引用与指令；重复 admission 复用原快照，不重新吸收模型变化。 */
  async prepareTurn(workspaceId: string, sessionId: string, turnId: string, input: OfficeSelectionSubmission): Promise<void> {
    const parsed = officeSelectionSubmissionSchema.parse(input);
    const refs = parsed.officeSelectionRefs ?? [], instructions = parsed.officeInstructions ?? [];
    if (new Set(refs).size !== refs.length || new Set(instructions.map((item) => item.instructionId)).size !== instructions.length)
      stale("选区指令重复，请重新添加");
    for (const item of instructions) {
      if (item.bindingState === "needs-selection") stale("请重新选择要修改的内容，或明确将要求改为普通文本");
      if (item.bindingState === "detached" ? item.referenceIds.length !== 0 : !item.referenceIds.length || item.referenceIds.some((id) => !refs.includes(id))) stale("修改要求缺少对应的选区");
    }
    if (refs.some((id) => !instructions.some((item) => item.bindingState === "bound" && item.referenceIds.includes(id)))) stale("选区缺少对应的修改要求");
    const key = turnKey(workspaceId, sessionId, turnId), fingerprint = officeProofJson(parsed);
    const previous = this.turns.get(key);
    if (previous) { if (previous.fingerprint !== fingerprint) stale("相同消息不能改换选区"); return; }
    if (!refs.length) return;
    const turn: Turn = { fingerprint, references: new Map(), executions: new Map(), instructions: structuredClone(instructions) };
    for (const id of refs) {
      const record = this.references.get(id);
      if (!record || record.value.workspaceId !== workspaceId || record.value.ownerSessionId !== sessionId) stale();
      const current = await this.read(record);
      if (current.stamp !== record.proof.stamp) stale();
      turn.references.set(id, structuredClone(record));
    }
    if (new Set([...turn.references.values()].map((record) => record.value.documentId)).size > 1) stale("一次选区请求只支持一个文件，请分别发送");
    for (const record of turn.references.values()) {
      let execution = turn.executions.get(record.value.documentId);
      if (!execution) { execution = { references: [], baselines: new Map(), state: "ready" }; turn.executions.set(record.value.documentId, execution); }
      execution.references.push(record);
    }
    for (const execution of turn.executions.values()) {
      for (const record of execution.references) {
        const scope = domain(record.value.locator);
        if (execution.baselines.has(scope)) continue;
        const coverage = execution.references.filter((item) => domain(item.value.locator) === scope).map((item) => item.value.locator);
        execution.baselines.set(scope, await this.read(record, coverage));
      }
      for (const record of execution.references) if ((await this.read(record)).stamp !== record.proof.stamp) stale();
      for (const [scope, baseline] of execution.baselines) {
        const members = execution.references.filter((item) => domain(item.value.locator) === scope);
        if ((await this.read(members[0], members.map((item) => item.value.locator))).stamp !== baseline.stamp) stale();
      }
    }
    if (this.turns.size >= 4096) throw new ApiError(409, "office_selection_capacity", "选区任务记录已满，请重启应用后重新选择");
    let retained = 0;
    for (const item of [...this.turns.values(), turn]) for (const execution of item.executions.values()) for (const proof of execution.baselines.values()) retained += Buffer.byteLength(officeProofJson(proof.state));
    if (retained > 64 * 1024 * 1024) throw new ApiError(409, "office_selection_capacity", "选区内容记录过多，请关闭不再使用的文档后重试");
    this.turns.set(key, turn);
  }

  /** 按真实用户消息返回本轮引用；未登记的旧普通轮次不引入历史选区。 */
  context(workspaceId: string, sessionId: string, turnId: string) {
    const turn = this.turns.get(turnKey(workspaceId, sessionId, turnId));
    return { mode: turn?.references.size ? "selection" as const : "current-document" as const,
      references: turn ? [...turn.references.values()].map((record) => structuredClone(record.value)) : [], instructions: structuredClone(turn?.instructions ?? []),
      // 展示预览可能截断；模型改写使用证明中的完整选中文字和段落边界，不能凭预览补全文。
      contents: turn ? [...turn.references.values()].flatMap((record) => record.docContents ? [{
        referenceId: record.value.referenceId,
        ranges: structuredClone(record.docContents),
      }] : []) : [] };
  }
  private target(workspaceId: string, sessionId: string, turnId: string, referenceId?: string) {
    const turn = this.turns.get(turnKey(workspaceId, sessionId, turnId));
    if (!turn?.references.size) {
      if (referenceId) stale("该选区不属于本轮消息");
      return null;
    }
    if (!referenceId) stale("本轮必须指定 selectionRef，不能改用当前文件");
    const record = turn.references.get(referenceId);
    if (!record) stale("该选区不属于本轮消息");
    return { record, execution: turn.executions.get(record.value.documentId)! };
  }

  /** 本轮工具发现必须使用有效引用；返回空表示该真实轮次按现有普通文档规则处理。 */
  async tools(workspaceId: string, sessionId: string, turnId: string, referenceId?: string): Promise<readonly string[] | null> {
    const target = this.target(workspaceId, sessionId, turnId, referenceId);
    if (!target) return null;
    await this.live(target.record);
    return officeSelectionToolNames(target.record.value.locator);
  }

  /** 选择工具的属性必须有完整读回适配；尚未验证的样式字段不能借原生 schema 绕过。 */
  private validatePayload(name: string, args: Record<string, unknown>): void {
    if (name === "doc_update_text_property" || name === "slide_set_text_property") {
      const keys = new Set(["file_id", "ranges", "page_index", "shape_id", "index", "count", "bold", "italic", "color", "font_size"]);
      if (Object.keys(args).some((key) => !keys.has(key))) stale("该文字样式尚不支持选区回读，请使用加粗、斜体、颜色或字号");
    }
    if (typeof args.text === "string") {
      if (name === "doc_replace_text") {
        args.text = args.text.replace(/\r\n|\n/g, "\r");
        if ((args.text as string).length > 4096 || (args.text as string).split("\r").some((text) => text.length > 200 || /[\u0000\ufffc]/.test(text))) stale("每段替换文字不能超过 200 字，请保留原有段落边界");
      } else if (args.text.length > 200 || /[\r\n\u0000\ufffc]/.test(args.text)) stale("请使用不超过 200 字的单段文字，结构修改请单独处理");
    }
    if (name === "sheet_set_cell_style" && args.is_clear === true) stale("选区暂不支持清除样式，请明确设置目标属性");
  }

  /** 仅对固定模型执行并回读；超时或回读失败保留待核对状态，不重试原生写入。 */
  async call(workspaceId: string, sessionId: string, turnId: string, messageId: string, name: string, input: Record<string, unknown>, referenceId?: string) {
    const target = this.target(workspaceId, sessionId, turnId, referenceId);
    if (!target) return null;
    const { record, execution } = target;
    if (execution.state !== "ready") stale(execution.state === "coordinates-changed" ? "上次修改改变了坐标，请重新选择后发送新要求" : "该任务的修改尚待核对，请检查文档后重新选择");
    const document = await this.live(record);
    const plan = planOfficeSelectionTool(record.value.locator, record.fileId, name, input);
    this.validatePayload(name, plan.args);
    if (plan.effect === "coordinates" && execution.references.length > 1) stale("改变坐标的多个选区修改请拆分发送");
    const readDomains = async () => {
      const proofs = new Map<string, OfficeSelectionProof>();
      for (const item of execution.references) {
        const key = domain(item.value.locator);
        if (proofs.has(key)) continue;
        const coverage = execution.references.filter((other) => domain(other.value.locator) === key).map((other) => other.readLocator ?? other.value.locator);
        proofs.set(key, await this.read(item, coverage));
      }
      return proofs;
    };
    if (execution.state !== "ready") stale("该文档正在处理另一项选区操作，请稍后再试");
    execution.state = "running";
    let before: Map<string, OfficeSelectionProof>;
    let nativeCalls: Array<{ name: string; args: Record<string, unknown> }> | undefined;
    try {
      before = await readDomains();
      for (const [scope, proof] of before) if (proof.stamp !== execution.baselines.get(scope)?.stamp) stale();
      if (name === "sheet_set_cell_value" || name === "sheet_set_cell_style") {
        if (name === "sheet_set_cell_style") {
          const state = before.get(domain(record.value.locator))!.state;
          const styles = state.formats as Array<Record<string, unknown>>;
          if (Object.keys(plan.args.format as object).some((key) => !styles.length || !styles.every((style) => Object.hasOwn(style, key)))) stale("该样式没有完整读取适配，暂不能按选区设置");
          const cells = state.cells as Array<{ row: number; col: number; formula?: string }>;
          const occupied = new Set(cells.map((cell) => `${cell.row}:${cell.col}`));
          const hasBlank = styles.some((style) => (style.row as number) >= (plan.args.start_row as number) && (style.row as number) <= (plan.args.end_row as number) &&
            (style.col as number) >= (plan.args.start_col as number) && (style.col as number) <= (plan.args.end_col as number) && !occupied.has(`${style.row}:${style.col}`));
          if (hasBlank && ((state.sheets as unknown[]).length !== 1 || cells.some((cell) => typeof cell.formula === "string"))) stale("空白单元格的样式可能影响公式，请仅选择已有内容的单元格，或单独处理工作簿");
        }
        const merges = before.get(domain(record.value.locator))!.state.merges as Array<{ start_row: number; end_row: number; start_col: number; end_col: number }>;
        for (const merge of merges) {
          if (name === "sheet_set_cell_value") {
            const cell = plan.args.cell as { row: number; col: number };
            if (cell.row >= merge.start_row && cell.row <= merge.end_row && cell.col >= merge.start_col && cell.col <= merge.end_col &&
              (cell.row !== merge.start_row || cell.col !== merge.start_col)) stale("合并单元格只能修改其左上角内容");
          } else {
            const args = plan.args as Record<string, number>;
            const intersects = args.start_row <= merge.end_row && args.end_row >= merge.start_row && args.start_col <= merge.end_col && args.end_col >= merge.start_col;
            if (intersects && !(args.start_row <= merge.start_row && args.end_row >= merge.end_row && args.start_col <= merge.start_col && args.end_col >= merge.end_col)) stale("请选择完整合并单元格后设置样式");
          }
        }
      }
      if (name === "sheet_delete_dimension") {
        const state = before.get(domain(record.value.locator))!.state;
        const sheet = (state.sheets as Array<Record<string, unknown>>)[0];
        if ((plan.args.count as number) >= (sheet[plan.args.dimension_type === "row" ? "row_count" : "col_count"] as number)) stale("不能删除整个工作表的全部行列");
      }
      if (plan.effect === "read") {
        const output = await this.options.tool(name, plan.args);
        execution.state = "ready";
        return { output };
      }
      if (name === "doc_replace_text" || name === "doc_insert_text") {
        const state = before.get("doc")!.state;
        const range = name === "doc_insert_text" ? { begin: plan.args.idx as number, end: plan.args.idx as number } : (plan.args.ranges as Array<{ begin: number; end: number }>)[0];
        const parts = officeDocRangeParts(state, range), texts = (plan.args.text as string).split("\r");
        if (parts.length !== texts.length) stale(`当前选择跨 ${parts.length} 个段落，请提供相同段数的改写内容；空段也需保留，暂不支持合并或拆分段落`);
        const nodes = state.nodes as Array<{ start_index: number; end_index: number }>;
        const resultingSize = (state.properties as unknown[]).length + texts.join("").length - parts.reduce((sum, part) => sum + part.end - part.begin, 0);
        if (resultingSize > 256 || parts.some((part, i) => nodes[part.nodeIndex].end_index - nodes[part.nodeIndex].start_index + texts[i].length - (part.end - part.begin) > 200)) stale("修改后的段落过长，请缩小本次修改");
        // TIPS: 原生替换拒绝跨段分隔符。先完整校验所有段，再从后向前改写，使未执行段仍使用原坐标。
        // 空段允许原位插入；不删除/重建段落，因此首尾未选文字及原有段落属性得以保留。
        nativeCalls = parts.flatMap((part, i) => part.begin === part.end && !texts[i].length ? [] : [{
          name: part.begin === part.end ? "doc_insert_text" : "doc_replace_text",
          args: part.begin === part.end ? { file_id: record.fileId, idx: part.begin, text: texts[i] }
            : { file_id: record.fileId, ranges: [{ begin: part.begin, end: part.end }], text: texts[i] },
        }]).reverse();
        if (!nativeCalls.length) stale("请选择需要修改的正文文字");
      }
      if (name === "doc_update_text_property") {
        const state = before.get("doc")!.state;
        const ranges = (plan.args.ranges as Array<{ begin: number; end: number }>).flatMap((range) => officeDocRangeParts(state, range))
          .filter((part) => part.end > part.begin).map(({ begin, end }) => ({ begin, end }));
        if (!ranges.length) stale("请选择需要修改的正文文字");
        plan.args.ranges = ranges;
      }
    } catch (error) { execution.state = "ready"; throw error; }
    try {
      const results = [];
      for (const call of nativeCalls ?? [{ name, args: plan.args }]) results.push(await this.options.tool(call.name, call.args));
      const output = results.length === 1 ? results[0] : { calls_executed: results.length, results };
      // TIPS: 修改后的读取范围只用于核对，不能成为后续写入授权；确认后原坐标引用整体失效。
      const oldLocator = record.value.locator;
      if (name === "doc_replace_text" || name === "doc_insert_text") {
        const begin = name === "doc_insert_text" ? plan.args.idx as number : (plan.args.ranges as Array<{ begin: number }>)[0].begin;
        record.readLocator = (plan.args.text as string).length ? { kind: "doc-text", ranges: [{ begin, end: begin + (plan.args.text as string).length }] } : { kind: "doc-caret", idx: begin };
      }
      if (name === "sheet_delete_dimension" && (oldLocator.kind === "sheet-rows" || oldLocator.kind === "sheet-columns")) {
        const state = before.get(domain(oldLocator))!.state;
        const sheet = (state.sheets as Array<Record<string, unknown>>)[0];
        const last = (sheet[oldLocator.kind === "sheet-rows" ? "row_count" : "col_count"] as number) - (plan.args.count as number) - 1;
        record.readLocator = { ...oldLocator, ranges: [{ start: Math.min(plan.args.index as number, last), end: Math.min(plan.args.index as number, last) }] };
      }
      let after: Map<string, OfficeSelectionProof>;
      after = await readDomains();
      for (const [scope, previous] of before) verifyOfficeSelectionEdit(previous, after!.get(scope)!, oldLocator, name, plan.args, nativeCalls?.length ?? 1);
      execution.baselines = after!;
      execution.state = plan.effect === "coordinates" ? "coordinates-changed" : "ready";
      await this.options.modified(document, messageId, name, plan.args, output);
      let location = record.readLocator ?? oldLocator;
      if (name === "doc_update_text_property") location = { kind: "doc-text", ranges: plan.args.ranges as Array<{ begin: number; end: number }> };
      if (name === "sheet_set_cell_value") {
        const cell = plan.args.cell as { row: number; col: number };
        location = { kind: "sheet-cells", sheetId: plan.args.sheet_id as string, ranges: [{ startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col }] };
      }
      if (name === "sheet_set_cell_style") location = { kind: "sheet-cells", sheetId: plan.args.sheet_id as string, ranges: [{ startRow: plan.args.start_row as number, endRow: plan.args.end_row as number, startCol: plan.args.start_col as number, endCol: plan.args.end_col as number }] };
      if (name === "slide_set_text_property") location = { kind: "slide-text", pageIndex: plan.args.page_index as number, shapeId: plan.args.shape_id as string, start: plan.args.index as number, count: plan.args.count as number };
      if (name === "slide_set_text") location = { kind: "slide-shapes", pageIndex: plan.args.page_index as number, shapeIds: [plan.args.shape_id as string] };
      return { output, receipt: { documentId: document.documentId, name: document.name, status: "modified", readback: "confirmed", location, saved: false, selectionRef: referenceId, requiresReselection: plan.effect === "coordinates" } };
    } catch (error) {
      execution.state = "needs-verification";
      throw new ApiError(409, "office_selection_edit_unconfirmed", "修改结果尚未确认，请检查文档后重新选择，不要重复执行", { documentId: document.documentId, cause: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 保存本轮引用对应原文件；缺少引用、未确认效果或旧模型均不能改存当前 tab。 */
  async save(workspaceId: string, sessionId: string, turnId: string, referenceId?: string) {
    const target = this.target(workspaceId, sessionId, turnId, referenceId);
    if (!target) return null;
    if (["running", "needs-verification"].includes(target.execution.state)) stale("修改尚未确认，暂不能确认保存");
    const document = await this.live(target.record);
    await this.options.prepare(document);
    for (const [scope, baseline] of target.execution.baselines) {
      const members = target.execution.references.filter((item) => domain(item.value.locator) === scope);
      const current = await this.read(members[0], members.map((item) => item.readLocator ?? item.value.locator));
      if (current.stamp !== baseline.stamp) stale("修改后文档内容已变化，请核对后手动保存或重新选择");
    }
    return { document: await this.options.save(document), receipt: { documentId: document.documentId, status: "saved", saved: true, selectionRef: referenceId } };
  }
}
