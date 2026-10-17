import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FileArtifact } from "@jugglework/types/file-artifacts";
import {
  getOfficeDocumentKind,
  type OfficeDocumentSession,
  type OfficeTransferStatus,
  type OfficeSelection,
} from "@jugglework/types/office";
import { parseOfficeSelection } from "./selection.js";
import { isOfficeContentTool } from "./content-tools.js";
import { ApiError } from "../errors.js";
import type { OfficeEngine } from "./engine.js";

type Engine = Pick<
  OfficeEngine,
  | "capabilities"
  | "ensureStarted"
  | "previewUrl"
  | "editor"
  | "save"
  | "close"
  | "tool"
  | "dispose"
  | "listTools"
>;
interface DocumentRecord {
  session: OfficeDocumentSession;
  absolutePath: string;
  identity: FileIdentity;
  loadingStartedAt: number | null;
}

const CONTENT_QUERY = {
  doc: "doc_get_last_operable_pos",
  sheet: "sheet_get_sheet_info",
  slide: "slide_get_info",
} as const;

/** 读取文件的真实路径和磁盘身份；尚不存在的目标保留绝对路径供比较。 */
async function fileIdentity(path: string) {
  try {
    return {
      path: await realpath(path),
      info: await stat(path, { bigint: true }),
    };
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    return { path: resolve(path), info: null };
  }
}
type FileIdentity = Awaited<ReturnType<typeof fileIdentity>>;

/** 比较已有身份；磁盘未提供有效 inode 时只能使用路径，不能把零值当成共享身份。 */
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  const key = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  return (
    key(left.path) === key(right.path) ||
    Boolean(
      left.info &&
        right.info &&
        left.info.ino !== 0n &&
        left.info.dev === right.info.dev &&
        left.info.ino === right.info.ino,
    )
  );
}

/** 单一 Server 管理的 Office 会话，页面先创建模型，所有保存绑定原路径。 */
export class OfficeDocuments {
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly saves = new Map<string, Promise<OfficeDocumentSession>>();
  private readonly activeDocuments = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      engine: Engine;
      resolveFile: (
        workspaceId: string,
        path: string,
        allowMissing?: boolean,
      ) => Promise<{ absolutePath: string; file: FileArtifact }>;
      onSaved: (workspaceId: string, path: string) => Promise<void>;
      prepareSave?: (document: OfficeDocumentSession) => Promise<void>;
      readSelection?: (document: OfficeDocumentSession) => Promise<unknown>;
      checkFile?: (path: string) => Promise<void>;
      onModified: (
        workspaceId: string,
        sessionId: string,
        messageId: string,
        callId: string,
        documentId: string,
        path: string,
      ) => Promise<void>;
      isBusy: (workspaceId: string, sessionId: string) => boolean;
      activityBlocker?: (
        workspaceId: string,
        sessionId: string,
        documentId: string,
      ) => Promise<"running" | "finalizing" | null>;
      onOwnership?: (
        workspaceId: string,
        path: string,
        owner: "internal" | "external",
      ) => Promise<void>;
    },
  ) {}

  /** 查询资源可用性，不因缺少 SDK 阻塞普通文件功能。 */
  capabilities() {
    return this.options.engine.capabilities();
  }

  /** 系统打开沿用真实文件身份对应的存活模型，覆盖符号链接和硬链接入口。 */
  async findByAbsolutePath(
    path: string,
  ): Promise<OfficeDocumentSession | null> {
    const record = await this.findRecordByIdentity(await fileIdentity(path));
    return record ? structuredClone(record.session) : null;
  }

  private async findRecordByIdentity(
    target: FileIdentity,
  ): Promise<DocumentRecord | undefined> {
    for (const record of [...this.documents.values()].reverse()) {
      if (record.session.state === "closed") continue;
      if (await this.matchesFile(record, target)) return record;
    }
    return undefined;
  }

  /** 旧位置失效只影响相关身份；未知别名不能复用或覆盖仍由旧模型持有的文件。 */
  private async matchesFile(
    record: DocumentRecord,
    target: FileIdentity,
  ): Promise<boolean> {
    let current: FileIdentity;
    try {
      current = await fileIdentity(record.absolutePath);
    } catch (error) {
      // 此边界只执行文件系统查询，带错误码的失败保留为不可用身份，不枚举平台错误码。
      if (typeof (error as NodeJS.ErrnoException)?.code !== "string") throw error;
      current = { path: record.identity.path, info: null };
    }
    // TIPS: 保留最后一次可靠身份。旧目录不可访问时，不能拖垮无关文件，也不能把疑似同一硬链接当成新文件。
    if (!current.info && sameFileIdentity(record.identity, target))
      throw new ApiError(
        409,
        "office_file_identity_unavailable",
        `“${record.session.name}”的原位置暂不可访问，请先关闭该文档后重试`,
      );
    if (current.info) record.identity = current;
    return sameFileIdentity(current, target);
  }

  /** 打开已支持格式的 Office 文件，先返回 opening 页面地址，真实模型由后续状态查询确认。 */
  async open(
    workspaceId: string,
    sessionId: string,
    path: string,
    reopening = false,
  ): Promise<OfficeDocumentSession> {
    if (!getOfficeDocumentKind(path))
      throw new ApiError(
        400,
        "office_format_unavailable",
        "当前支持 DOCX、CSV、XLSX 和 PPTX 原生编辑",
      );
    const resolved = await this.options.resolveFile(workspaceId, path);
    if (!resolved.file.exists)
      throw new ApiError(404, "file_not_found", "文档已不存在");
    const identity = await fileIdentity(resolved.absolutePath);
    const existing = await this.findRecordByIdentity(identity);
    if (
      existing &&
      (existing.session.ownerSessionId !== sessionId ||
        existing.session.workspaceId !== workspaceId)
    )
      throw new ApiError(
        409,
        "office_document_in_use",
        "此文档已在另一聊天中打开，请先在原聊天保存并关闭",
      );
    if (existing && existing.session.state !== "closed") {
      if (existing.session.state === "external")
        throw new ApiError(
          409,
          "office_document_external",
          "请先在外部应用保存并关闭文档，再重新载入",
        );
      this.activateRecord(existing);
      return structuredClone(existing.session);
    }
    if (resolved.file.editingOwner === "external" && !reopening)
      throw new ApiError(
        409,
        "office_document_external",
        "请先在外部应用保存并关闭文档，再重新载入",
      );
    try {
      await this.options.checkFile?.(resolved.absolutePath);
    } catch (error) {
      // TIPS: 只读预览没有编辑模型，不能让 AI 继续修改该聊天之前的活动文档。
      if (
        error instanceof ApiError &&
        error.code === "office_readonly_required"
      )
        this.activeDocuments.delete(JSON.stringify([workspaceId, sessionId]));
      throw error;
    }
    const session: OfficeDocumentSession = {
      documentId: `od_${randomUUID()}`,
      pageId: randomUUID(),
      artifactId: resolved.file.artifactId,
      workspaceId,
      ownerSessionId: sessionId,
      relativePath: resolved.file.relativePath,
      name: resolved.file.name,
      state: "opening",
      engineFileId: null,
      previewUrl: null,
      dirty: false,
      savedAt: resolved.file.updatedAt,
    };
    const record: DocumentRecord = {
      session,
      absolutePath: resolved.absolutePath,
      identity,
      loadingStartedAt: null,
    };
    this.documents.set(session.documentId, record);
    this.activateRecord(record);
    return this.loadRecord(record);
  }

  /** 创建空白 DOCX 并保存后释放临时模型；编辑模型仍由页面首次打开建立。 */
  async create(
    workspaceId: string,
    sessionId: string,
    path: string,
  ): Promise<OfficeDocumentSession> {
    if (!path.toLowerCase().endsWith(".docx"))
      throw new ApiError(
        400,
        "office_format_unavailable",
        "当前仅支持创建 DOCX",
      );
    const resolved = await this.options.resolveFile(workspaceId, path, true);
    if (resolved.file.exists)
      throw new ApiError(
        409,
        "file_exists",
        "目标文件已存在，请打开编辑或使用新文件名",
      );
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    const created = await this.options.engine.tool("create_doc", {});
    const fileId =
      typeof created.file_id === "string" ? created.file_id : undefined;
    if (!fileId) throw new Error("创建文档没有返回模型 ID");
    try {
      // TIPS: create_doc 返回时导入可能尚未完成，必须用真实内容查询确认后再保存。
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await this.options.engine.tool("doc_get_last_operable_pos", {
            file_id: fileId,
          });
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      await this.options.engine.tool("save_file", {
        file_id: fileId,
        file_path: resolved.absolutePath,
      });
    } finally {
      await this.options.engine.close(fileId, true);
    }
    await this.options.onSaved(workspaceId, resolved.file.relativePath);
    return this.open(workspaceId, sessionId, resolved.file.relativePath);
  }

  /** 按文档身份刷新模型，load 事件不能代替内容查询的就绪确认。 */
  async get(
    workspaceId: string,
    documentId: string,
  ): Promise<OfficeDocumentSession> {
    const record = this.require(workspaceId, documentId);
    const session = record.session;
    if (["external", "closed", "error"].includes(session.state))
      return structuredClone(session);
    const editor = await this.options.engine.editor(record.absolutePath);
    if (record.session !== session) return structuredClone(record.session);
    if (editor) {
      if (session.state === "opening") {
        // TIPS: 后台标签可能仅登记、尚未创建页面；只有页面挂载或实际模型开始导入才计时。
        record.loadingStartedAt ??= Date.now();
        try {
          const kind = getOfficeDocumentKind(session.relativePath)!;
          const content = await this.options.engine.tool(CONTENT_QUERY[kind], {
            file_id: editor.file_id,
          });
          if (record.session !== session)
            return structuredClone(record.session);
          // TIPS: PPT 导入中也会返回成功响应，只有 is_open 才表示内容模型真正可用。
          if (kind === "slide" && content.is_open !== true)
            throw new Error("幻灯片模型仍在导入");
          if (
            kind === "sheet" &&
            (!Array.isArray(content.sheets) || content.sheets.length === 0)
          )
            throw new Error("表格模型仍在导入");
        } catch {
          if (record.session !== session)
            return structuredClone(record.session);
          if (Date.now() - record.loadingStartedAt > 60_000) {
            session.state = "error";
            session.error = "文档加载超时，请关闭后重新打开";
          }
          return structuredClone(session);
        }
        session.state = "ready";
        await this.options.onOwnership?.(
          workspaceId,
          session.relativePath,
          "internal",
        );
        if (record.session !== session) return structuredClone(record.session);
      }
      session.engineFileId = editor.file_id;
      session.dirty = editor.is_dirty;
    } else if (session.engineFileId) {
      session.state = "error";
      session.engineFileId = null;
      session.error = "文档模型已失效，请关闭后重新打开";
    } else if (
      record.loadingStartedAt !== null &&
      Date.now() - record.loadingStartedAt > 60_000
    ) {
      session.state = "error";
      session.error = "文档加载超时，请关闭后重新打开";
    }
    return structuredClone(session);
  }

  /** 查询迁移等待原因，保留原页面及模型，不执行保存、关闭或任务取消。 */
  async transferStatus(
    workspaceId: string,
    documentId: string,
  ): Promise<OfficeTransferStatus> {
    const record = this.require(workspaceId, documentId);
    const document = await this.get(workspaceId, documentId);
    if (!["opening", "ready", "saving"].includes(document.state))
      throw new ApiError(
        409,
        "office_not_ready",
        document.error ?? "文档不可迁移",
      );
    const reason = await this.activity(record);
    if (["closed", "external", "error"].includes(record.session.state))
      throw new ApiError(409, "office_not_ready", "文档已不可迁移");
    return {
      documentId,
      reason:
        reason ??
        (this.saves.has(documentId) || record.session.state === "saving"
          ? "saving"
          : null),
    };
  }

  /** 重命名、覆盖或删除之前拒绝影响存活 Office 模型的文件及目录；先由用户保存关闭。 */
  assertFileMutationAllowed(workspaceId: string, paths: string[]): void {
    const key = (path: string) =>
      process.platform === "win32" ? path.toLowerCase() : path;
    const affected = paths.map(key);
    for (const { session } of this.documents.values()) {
      if (
        session.workspaceId !== workspaceId ||
        ["closed", "external"].includes(session.state)
      )
        continue;
      const path = key(session.relativePath);
      if (
        affected.some(
          (parent) => path === parent || path.startsWith(`${parent}/`),
        )
      )
        throw new ApiError(
          409,
          "office_document_in_use",
          `请先保存并关闭“${session.name}”，再重命名、覆盖或删除文件及所在目录`,
        );
    }
  }

  /**
   * 原生另存副本覆盖前检查所有聊天的存活模型，包含符号链接及硬链接指向的同一文件。
   * @param path 用户在保存对话框中选择的绝对目标路径
   */
  async assertCopyTargetAllowed(path: string): Promise<void> {
    if (!isAbsolute(path))
      throw new ApiError(400, "invalid_path", "副本目标必须是绝对路径");
    const target = await fileIdentity(path);
    for (const record of this.documents.values()) {
      if (["closed", "external"].includes(record.session.state)) continue;
      // TIPS: 只比较路径会漏过别名，copyFile 也会透过硬链接覆盖仍由模型持有的文件。
      if (await this.matchesFile(record, target))
        throw new ApiError(
          409,
          "office_document_in_use",
          `请先保存并关闭目标文档“${record.session.name}”，再覆盖该文件`,
        );
    }
  }

  /** 当前文档按所属聊天查询，不使用全局焦点；关闭后不再作为 Agent 目标。 */
  async current(
    workspaceId: string,
    sessionId: string,
  ): Promise<OfficeDocumentSession | null> {
    const id = this.activeDocuments.get(
      JSON.stringify([workspaceId, sessionId]),
    );
    const record = id ? this.documents.get(id) : undefined;
    if (record && ["closed", "external"].includes(record.session.state))
      return null;
    return record ? this.get(workspaceId, record.session.documentId) : null;
  }

  /** 读取本轮聊天文档及其存活模型的选区；故障、关闭及重新导入后不返回旧坐标。 */
  async context(workspaceId: string, sessionId: string) {
    const document = await this.current(workspaceId, sessionId);
    const record = document
      ? this.require(workspaceId, document.documentId)
      : undefined;
    if (document?.state === "ready" && record && this.options.readSelection) {
      const model = record.session;
      let selection: OfficeSelection | null = null;
      try {
        const value = await this.options.readSelection(document);
        selection = parseOfficeSelection(
          getOfficeDocumentKind(document.relativePath)!,
          value,
        );
      } catch {
        // TIPS: 实时读取失败不能回退到通知缓存，否则 AI 会使用切换或修改前的坐标。
      }
      const current = await this.current(workspaceId, sessionId);
      return {
        document: current,
        selection:
          record.session === model &&
          current?.state === "ready" &&
          current.documentId === document.documentId &&
          current.pageId === document.pageId &&
          current.engineFileId === document.engineFileId
            ? selection
            : null,
      };
    }
    return { document, selection: null };
  }

  /** 原生宿主按页面身份激活文档；页面不能替换当前聊天或原生模型 ID。 */
  updateContext(
    workspaceId: string,
    documentId: string,
    pageId: string,
    activate = false,
  ): void {
    const record = this.require(workspaceId, documentId);
    const session = record.session;
    if (
      !["opening", "ready", "saving"].includes(session.state) ||
      session.pageId !== pageId
    )
      throw new ApiError(409, "office_page_invalidated", "选区所属页面已失效");
    if (activate) this.activateRecord(record);
    if (session.state === "opening") record.loadingStartedAt ??= Date.now();
  }

  /** 当前文档按聊天保存，选区仅在查询时读取，不缓存标签切换前的坐标。 */
  private activateRecord(record: DocumentRecord): void {
    const session = record.session;
    const documentId = session.documentId;
    const key = JSON.stringify([session.workspaceId, session.ownerSessionId]);
    this.activeDocuments.set(key, documentId);
  }

  /** 按已登记路径查找自己的文档，不打开模型、不改变当前文档。 */
  async find(
    workspaceId: string,
    sessionId: string,
    path: string,
  ): Promise<OfficeDocumentSession | null> {
    const record = [...this.documents.values()]
      .reverse()
      .find(
        (record) =>
          record.session.workspaceId === workspaceId &&
          record.session.ownerSessionId === sessionId &&
          record.session.relativePath === path &&
          record.session.state !== "closed",
      );
    return record ? this.get(workspaceId, record.session.documentId) : null;
  }

  /** 页面、快捷键、自动保存和最终交付共用此入口；保存路径不可由调用方指定。 */
  async save(
    workspaceId: string,
    documentId: string,
    final = false,
  ): Promise<OfficeDocumentSession> {
    const pending = this.saves.get(documentId);
    if (pending) {
      await pending;
      return final
        ? this.save(workspaceId, documentId, true)
        : this.get(workspaceId, documentId);
    }
    const operation = this.saveDocument(workspaceId, documentId, final).finally(
      () => this.saves.delete(documentId),
    );
    this.saves.set(documentId, operation);
    return operation;
  }
  private async saveDocument(
    workspaceId: string,
    documentId: string,
    final: boolean,
  ): Promise<OfficeDocumentSession> {
    const record = this.require(workspaceId, documentId);
    let session = await this.get(workspaceId, documentId);
    if (session.state !== "ready" || !session.engineFileId)
      throw new ApiError(409, "office_not_ready", "文档尚未就绪，不能确认保存");
    const model = record.session;
    const fileId = session.engineFileId;
    const requireLiveModel = () => {
      if (record.session !== model || record.session.engineFileId !== fileId)
        throw new ApiError(
          409,
          "office_model_invalidated",
          "文档模型已失效，不能确认保存",
        );
    };
    try {
      await this.options.checkFile?.(record.absolutePath);
      await this.options.prepareSave?.(structuredClone(model));
      requireLiveModel();
      if (/\.csv$/i.test(session.relativePath)) {
        const info = await this.options.engine.tool("sheet_get_sheet_info", {
          file_id: session.engineFileId,
        });
        // TIPS: CSV 只能保存一张表，不能把用户新建的其他工作表静默丢弃。
        if (!Array.isArray(info.sheets) || info.sheets.length !== 1)
          throw new ApiError(
            409,
            "office_csv_single_sheet_required",
            "CSV 仅支持单个工作表，请保留一张工作表后保存",
          );
      }
      for (let attempt = 0; attempt < (final ? 3 : 1); attempt++) {
        requireLiveModel();
        record.session.state = "saving";
        await this.options.engine.save(fileId);
        // TIPS: 引擎退出会替换会话状态；旧请求即使晚到成功，也不能发布交付或恢复旧模型。
        requireLiveModel();
        if (!(await stat(record.absolutePath)).isFile())
          throw new Error("保存结果不存在");
        requireLiveModel();
        await this.options.onSaved(workspaceId, session.relativePath);
        requireLiveModel();
        record.session.state = "ready";
        record.session.savedAt = Date.now();
        delete record.session.error;
        session = await this.get(workspaceId, documentId);
        requireLiveModel();
        if (!session.dirty) return session;
      }
      if (final && session.dirty)
        throw new Error("文档仍有未保存修改，请稍后重试确认");
      return session;
    } catch (error) {
      if (record.session === model && record.session.engineFileId === fileId) {
        record.session.state = "ready";
        record.session.dirty = true;
        record.session.error =
          error instanceof Error ? error.message : "文档保存失败";
      }
      throw error;
    }
  }

  /** 用户确认丢弃未保存内容后，从原路径恢复故障文档；保留文档身份，重新建立原生模型。 */
  async recover(
    workspaceId: string,
    documentId: string,
  ): Promise<OfficeDocumentSession> {
    const record = this.require(workspaceId, documentId);
    if (record.session.state !== "error")
      throw new ApiError(
        409,
        "office_recovery_not_required",
        "文档无需故障恢复",
      );
    await this.requireIdle(record);
    await this.saves.get(documentId)?.catch(() => {});
    const resolved = await this.options.resolveFile(
      workspaceId,
      record.session.relativePath,
    );
    if (!resolved.file.exists)
      throw new ApiError(404, "file_not_found", "文档已不存在");
    await this.options.checkFile?.(resolved.absolutePath);
    const editor = await this.options.engine.editor(record.absolutePath);
    if (editor) await this.options.engine.close(editor.file_id, true);
    const next: OfficeDocumentSession = {
      ...record.session,
      pageId: randomUUID(),
      state: "opening",
      engineFileId: null,
      previewUrl: null,
      dirty: false,
      error: undefined,
    };
    record.session = next;
    record.loadingStartedAt = null;
    return this.loadRecord(record);
  }

  /** 首次打开及故障恢复使用同一启动边界，退出前的请求不得返回失效页面。 */
  private async loadRecord(
    record: DocumentRecord,
  ): Promise<OfficeDocumentSession> {
    const session = record.session;
    try {
      const previewUrl = await this.options.engine.previewUrl(
        record.absolutePath,
      );
      if (record.session !== session) return structuredClone(record.session);
      session.previewUrl = previewUrl;
      this.startAutoSave();
    } catch (error) {
      if (record.session === session) {
        session.state = "error";
        session.error =
          error instanceof Error ? error.message : "Office 引擎启动失败";
      }
    }
    return structuredClone(record.session);
  }

  /** 关闭前由用户选择保存、放弃或取消；正在编辑的 Agent 运行不能被静默释放。 */
  async close(
    workspaceId: string,
    documentId: string,
    decision: "save" | "discard" | "cancel",
  ): Promise<OfficeDocumentSession> {
    const record = this.require(workspaceId, documentId);
    if (decision === "cancel" || record.session.state === "closed")
      return structuredClone(record.session);
    await this.requireIdle(record);
    const session = await this.get(workspaceId, documentId);
    if (
      decision === "save" &&
      session.state === "opening" &&
      record.loadingStartedAt !== null
    )
      throw new ApiError(409, "office_not_ready", "文档正在载入，请稍候再关闭");
    if (decision === "save" && session.state === "ready")
      await this.save(workspaceId, documentId, true);
    else if (decision === "save" && session.dirty)
      throw new Error("文档未就绪，无法保存关闭");
    const editor = session.engineFileId
      ? { file_id: session.engineFileId }
      : await this.options.engine.editor(record.absolutePath);
    if (editor)
      await this.options.engine.close(editor.file_id, decision === "discard");
    record.session.state = "closed";
    record.session.engineFileId = null;
    record.session.previewUrl = null;
    return structuredClone(record.session);
  }

  /** 导出或添加附件之前保存已打开的模型；没有模型时继续使用原文件流程。 */
  async prepareFile(
    workspaceId: string,
    sessionId: string,
    path: string,
  ): Promise<void> {
    const record = [...this.documents.values()].find(
      (record) =>
        record.session.workspaceId === workspaceId &&
        record.session.relativePath === path &&
        !["closed", "external"].includes(record.session.state),
    );
    if (!record) return;
    await this.requireIdle(record);
    await this.save(workspaceId, record.session.documentId, true);
  }

  /** 保存并释放原模型后持久化外部接管状态；系统打开失败也不恢复过期页面。 */
  async external(
    workspaceId: string,
    sessionId: string,
    path: string,
  ): Promise<OfficeDocumentSession | null> {
    const resolved = await this.options.resolveFile(workspaceId, path);
    const record = [...this.documents.values()].find(
      (record) =>
        record.session.workspaceId === workspaceId &&
        record.session.artifactId === resolved.file.artifactId &&
        record.session.state !== "closed" &&
        record.session.state !== "external",
    );
    if (record) {
      await this.close(workspaceId, record.session.documentId, "save");
      record.session.state = "external";
    }
    await this.options.onOwnership?.(
      workspaceId,
      resolved.file.relativePath,
      "external",
    );
    return record ? structuredClone(record.session) : null;
  }

  /** 用户明确返回内置编辑后重新导入；模型就绪才恢复内部编辑权。 */
  async reopen(
    workspaceId: string,
    sessionId: string,
    path: string,
  ): Promise<OfficeDocumentSession> {
    const existing = [...this.documents.values()].find(
      (record) =>
        record.session.workspaceId === workspaceId &&
        record.session.relativePath === path &&
        record.session.state === "external",
    );
    if (existing) existing.session.state = "closed";
    return this.open(workspaceId, sessionId, path, true);
  }

  /** Agent 内容调用前限定当前聊天模型，禁止原生生命周期及绕过宿主的保存。 */
  async beforeTool(
    workspaceId: string,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isOfficeContentTool(tool))
      throw new ApiError(
        409,
        "office_tool_host_owned",
        "请通过 JuggleWork Office 动作管理文档生命周期和导出",
      );
    const session = await this.current(workspaceId, sessionId);
    if (!session || session.state !== "ready" || !session.engineFileId)
      throw new ApiError(
        409,
        "office_not_ready",
        "请先在当前聊天打开并等待文档就绪",
      );
    if (!tool.startsWith(`${getOfficeDocumentKind(session.relativePath)}_`))
      throw new ApiError(
        409,
        "office_wrong_document_type",
        "工具类型与当前文档不匹配",
      );
    if (args.file_id && args.file_id !== session.engineFileId)
      throw new ApiError(
        409,
        "office_wrong_document",
        "目标模型不属于当前聊天文档",
      );
    return { ...args, file_id: session.engineFileId };
  }

  /** 按当前聊天格式返回精简工具目录，指定名称时只返回该项真实 schema。 */
  async tools(workspaceId: string, sessionId: string, name?: string) {
    const document = await this.current(workspaceId, sessionId);
    if (!document || document.state !== "ready")
      throw new ApiError(
        409,
        "office_not_ready",
        "请先在当前聊天打开并等待文档就绪",
      );
    const prefix = `${getOfficeDocumentKind(document.relativePath)}_`;
    const tools = (await this.options.engine.listTools()).filter(
      (tool) => tool.name.startsWith(prefix) && isOfficeContentTool(tool.name),
    );
    if (!name)
      return {
        tools: tools.map(({ name, description }) => ({ name, description })),
      };
    const tool = tools.find((tool) => tool.name === name);
    if (!tool)
      throw new ApiError(
        400,
        "office_tool_unavailable",
        "工具不属于当前文档的内容通道",
      );
    return { tool };
  }

  /** 执行实际模型内容工具并登记原始调用归属；保存仍由独立宿主动作完成。 */
  async call(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    tool: string,
    input: Record<string, unknown>,
  ) {
    const args = await this.beforeTool(workspaceId, sessionId, tool, input);
    // TIPS: 保存调用前绑定的 ID；模型返回时即使切换标签，也不能把修改记到新文档。
    const output = await this.options.engine.tool(tool, args);
    await this.afterTool(
      workspaceId,
      sessionId,
      messageId,
      randomUUID(),
      tool,
      args,
      output,
    );
    return { output };
  }

  /** 仅成功的内容修改登记本轮目标，查询工具和失败结果不产生交付。 */
  async afterTool(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    output: unknown,
  ): Promise<void> {
    if (
      /^(?:doc|sheet|slide)_(?:get_|list_|find$|resolve_|calculate_|audit_)/.test(
        tool,
      )
    )
      return;
    let result = output;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        /* 文本成功结果仍按工具状态处理。 */
      }
    }
    if (
      result &&
      typeof result === "object" &&
      ((result as { isError?: boolean }).isError ||
        (result as { success?: boolean }).success === false ||
        (result as { code?: number }).code === -1)
    )
      return;
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { content?: unknown }).content)
    ) {
      for (const entry of (result as { content: Array<{ text?: string }> })
        .content) {
        if (typeof entry.text !== "string") continue;
        try {
          const value = JSON.parse(entry.text);
          if (value?.code === -1 || value?.success === false) return;
        } catch {
          /* 非 JSON 成功文本不影响修改登记。 */
        }
      }
    }
    // TIPS: 工具运行期间用户可能切换标签，完成结果必须绑定调用前已填入的 file_id。
    const original = [...this.documents.values()].find(
      (record) =>
        record.session.workspaceId === workspaceId &&
        record.session.ownerSessionId === sessionId &&
        record.session.engineFileId === args.file_id,
    );
    const session = original
      ? await this.get(workspaceId, original.session.documentId)
      : null;
    if (!session || session.state !== "ready") return;
    const record = this.require(workspaceId, session.documentId);
    record.session.dirty = true;
    await this.options.onModified(
      workspaceId,
      sessionId,
      messageId,
      callId,
      session.documentId,
      session.relativePath,
    );
  }

  /** 引擎崩溃后清除全部失效模型身份，禁止继续使用旧坐标。 */
  invalidate(): void {
    for (const record of this.documents.values())
      if (!["closed", "external"].includes(record.session.state)) {
        record.session = {
          ...record.session,
          state: "error",
          engineFileId: null,
          previewUrl: null,
          error: "Office 引擎已退出，请重新打开最后保存的版本",
        };
      }
  }

  /** 原生页面崩溃或加载失败时停止该文档写入；残留模型只在用户确认恢复后释放。 */
  failPage(workspaceId: string, documentId: string): OfficeDocumentSession {
    const record = this.require(workspaceId, documentId);
    if (!["closed", "external", "error"].includes(record.session.state))
      record.session = {
        ...record.session,
        state: "error",
        engineFileId: null,
        previewUrl: null,
        error: "文档编辑页面已退出或加载失败，请重新打开已保存版本",
      };
    return structuredClone(record.session);
  }
  /** 批量查询退出所需状态，原生宿主负责显示保存、放弃和取消。 */
  async list(): Promise<OfficeDocumentSession[]> {
    return Promise.all(
      [...this.documents.values()]
        .filter(
          (record) =>
            record.session.state !== "closed" &&
            record.session.state !== "external",
        )
        .map((record) =>
          this.get(record.session.workspaceId, record.session.documentId),
        ),
    );
  }
  /** 停止自动保存并释放本 Server 引擎；退出前的决定由原生宿主处理。 */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.saves.values()]);
    await this.options.engine.dispose();
  }

  private require(workspaceId: string, documentId: string): DocumentRecord {
    const record = this.documents.get(documentId);
    if (!record || record.session.workspaceId !== workspaceId)
      throw new ApiError(404, "office_document_not_found", "文档会话不存在");
    return record;
  }
  private async activity(
    record: DocumentRecord,
  ): Promise<"running" | "finalizing" | null> {
    const session = record.session;
    if (this.options.isBusy(session.workspaceId, session.ownerSessionId))
      return "running";
    return (
      (await this.options.activityBlocker?.(
        session.workspaceId,
        session.ownerSessionId,
        session.documentId,
      )) ?? null
    );
  }
  private async requireIdle(record: DocumentRecord): Promise<void> {
    // TIPS: 引擎队列可能没有宿主 run；关闭、接管和恢复必须与迁移使用同一活动判定。
    if (await this.activity(record))
      throw new ApiError(
        409,
        "office_run_active",
        "请等待文档相关任务结束及交付完成后重试",
      );
  }
  private startAutoSave(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.list()
        .then(async (sessions) => {
          for (const session of sessions)
            if (session.state === "ready" && session.dirty)
              await this.save(session.workspaceId, session.documentId).catch(
                () => {},
              );
        })
        .catch(() => {});
    }, 30_000);
    this.timer.unref?.();
  }
}
