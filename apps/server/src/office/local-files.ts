import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import type { FileArtifact } from "@jugglework/types/file-artifacts";
import { ApiError } from "../errors.js";
import { workspaceIdForPath } from "../workspaces.js";
import { fileAssistantWorkspaceRoot } from "./file-assistant-workspace.js";

/** 统一解释本机文件系统失败；最近文件已移动及无权读取均属于明确的业务错误。 */
async function inspectFile(path: string, canonical = false) {
  try {
    const absolutePath = canonical ? await realpath(path) : path;
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new ApiError(400, "invalid_path", "请选择文件");
    return { absolutePath, info };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new ApiError(404, "file_not_found", "文件不存在或已移动");
    if (code === "EACCES" || code === "EPERM")
      throw new ApiError(403, "file_access_denied", "没有访问此文件的权限");
    throw error;
  }
}

/** 文件助手的原文件登记及会话关联；登记不复制文件，也不把父目录变为工作区。 */
export class LocalOfficeFiles {
  readonly id: string;
  readonly root: string;
  private readonly statePath: string;
  private loaded: Promise<void> | null = null;
  private currentSessionId: string | undefined;
  private readonly files = new Map<
    string,
    { absolutePath: string; owner: "internal" | "external"; sessionId?: string }
  >();

  constructor(options: { root?: string; statePath?: string } = {}) {
    this.root = resolve(options.root ?? fileAssistantWorkspaceRoot());
    this.id = workspaceIdForPath(this.root);
    this.statePath = options.statePath ?? join(this.root, ".jugglework", "file-browser.json");
  }

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      let raw: string;
      try { raw = await readFile(this.statePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.files)) throw new ApiError(409, "file_assistant_state_invalid", "文件助手记录无法读取，请检查配置后重试");
      this.currentSessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
      for (const file of value.files) {
        if (typeof file.key !== "string" || !file.key.startsWith("external-files/") || typeof file.absolutePath !== "string" || !isAbsolute(file.absolutePath))
          throw new ApiError(409, "file_assistant_state_invalid", "文件助手记录包含无效路径");
        this.files.set(file.key, { absolutePath: file.absolutePath, owner: "internal", ...(typeof file.sessionId === "string" ? { sessionId: file.sessionId } : {}) });
      }
    })();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const value = { version: 1, sessionId: this.currentSessionId, files: [...this.files].map(([key, file]) => ({ key, absolutePath: file.absolutePath, sessionId: file.sessionId })) };
    await writeFile(`${this.statePath}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${this.statePath}.tmp`, this.statePath);
  }

  /** 判断请求是否属于固定文件助手工作区。 */
  owns(id: string): boolean {
    return id === this.id;
  }

  /** 判断原文件命名空间；未知标识同样不可回退为默认目录内的磁盘文件。 */
  isExternal(workspaceId: string, path: string): boolean {
    return this.owns(workspaceId) && path.startsWith("external-files/");
  }

  /** 返回文件原有会话，未绑定的新文件使用当前文件浏览器会话。 */
  async sessionFor(key: string): Promise<string | undefined> {
    await this.load();
    return this.files.get(key)?.sessionId ?? this.currentSessionId;
  }

  /** 仅在真实会话创建或校验成功后持久化关联，不保存聊天历史。 */
  async bindSession(key: string, sessionId: string): Promise<void> {
    await this.load();
    const file = this.files.get(key);
    if (!file) throw new ApiError(404, "file_not_found", "文件尚未登记");
    file.sessionId = sessionId;
    this.currentSessionId = sessionId;
    await this.persist();
  }

  /** 仅供可信桌面宿主登记用户明确选择的绝对路径，规范化一次并保留文件名。 */
  async register(path: string): Promise<string> {
    await this.load();
    if (
      !isAbsolute(path) ||
      path.includes("\0") ||
      !getOfficeDocumentKind(path)
    )
      throw new ApiError(
        400,
        "office_format_unavailable",
        "请选择 DOCX、XLSX、CSV 或 PPTX 文件",
      );
    const { absolutePath } = await inspectFile(path, true);
    const existing = [...this.files].find(
      ([, file]) => file.absolutePath === absolutePath,
    );
    if (existing) return existing[0];
    const key = `external-files/${createHash("sha256").update(absolutePath).digest("hex").slice(0, 32)}/${basename(absolutePath)}`;
    this.files.set(key, { absolutePath, owner: "internal" });
    await this.persist();
    return key;
  }

  /** 按已登记标识解析文件；任意路径及目录均不能借此访问。 */
  async resolve(
    key: string,
  ): Promise<{ absolutePath: string; file: FileArtifact }> {
    await this.load();
    const target = this.files.get(key);
    if (!target)
      throw new ApiError(404, "file_not_found", "文件未通过桌面宿主打开");
    const { info } = await inspectFile(target.absolutePath);
    return {
      absolutePath: target.absolutePath,
      file: {
        artifactId: key,
        workspaceId: this.id,
        relativePath: key,
        name: basename(target.absolutePath),
        kind: "document",
        mimeType: "application/octet-stream",
        sizeBytes: info.size,
        updatedAt: info.mtimeMs,
        exists: true,
        editingOwner: target.owner,
      },
    };
  }

  /** 记录外部编辑交接，与工作区文件使用相同模型保护规则。 */
  setOwner(key: string, owner: "internal" | "external"): void {
    const target = this.files.get(key);
    if (target) target.owner = owner;
  }
}
