import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { isSupportedFileWindowPath, isSupportedWorkspaceTextFilePath } from "@jugglework/types/file-window";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import type { FileArtifact } from "@jugglework/types/file-artifacts";
import { ApiError } from "../errors.js";
import { workspaceIdForPath } from "../workspaces.js";
import { fileAssistantChildWorkspaceRoot, fileAssistantWorkspaceRoot, validateFileAssistantFileWorkspace } from "./file-assistant-workspace.js";
import type { WorkspaceInfo } from "../types.js";

export const LOCAL_TEXT_FILE_MAX_BYTES = 5_000_000;

/** 登记和保存均验证完整 UTF-8 字节，拒绝伪装成文本的二进制文件。 */
export function assertLocalTextFileBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > LOCAL_TEXT_FILE_MAX_BYTES)
    throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes: LOCAL_TEXT_FILE_MAX_BYTES, size: bytes.byteLength });
  try {
    if (bytes.includes(0)) throw new Error("NUL");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_text_file", "文件不是有效的 UTF-8 文本");
  }
}

export async function readLocalTextFile(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > LOCAL_TEXT_FILE_MAX_BYTES)
    throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes: LOCAL_TEXT_FILE_MAX_BYTES, size: info.size });
  const bytes = await readFile(path);
  assertLocalTextFileBytes(bytes);
  return bytes;
}

/** 原子替换前确认原件可写；r+ 只打开已有文件，不创建或截断内容。 */
export async function assertLocalTextFileWritable(path: string): Promise<void> {
  try {
    const handle = await open(path, "r+");
    await handle.close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      throw new ApiError(403, "file_access_denied", "没有写入此文件的权限");
    throw error;
  }
}

/** 可在任意测试宿主验证 Windows 输入；只接受普通盘符绝对路径或 UNC。 */
export function isPortableAbsoluteFilePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!path || path.includes("\0")) return false;
  if (platform !== "win32") return isAbsolute(path);
  const value = path.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/.test(value)) return false;
  const drive = /^[a-z]:\\/i.test(value);
  const unc = /^\\\\[^\\]+\\[^\\]+\\[^\\]+/.test(value);
  if ((!drive && !unc) || !win32.isAbsolute(value)) return false;
  const rest = drive ? value.slice(3) : value.slice(2);
  return !rest.includes(":") && rest.split("\\").every((part) =>
    !/[<>"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

/** realpath 的大小写仅在 Windows 身份 hash 中折叠，展示和磁盘访问保留原样。 */
export function localOfficeFileId(path: string, platform: NodeJS.Platform = process.platform): string {
  const identity = platform === "win32" ? win32.normalize(path).toLowerCase() : path;
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

async function inspectFile(path: string, canonical = false) {
  try {
    const absolutePath = canonical ? await realpath(path) : path;
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new ApiError(400, "invalid_path", "请选择文件");
    return { absolutePath, info };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ApiError(404, "file_not_found", "文件不存在或已移动");
    if (code === "EACCES" || code === "EPERM") throw new ApiError(403, "file_access_denied", "没有访问此文件的权限");
    throw error;
  }
}

export interface LocalOfficeFileBinding {
  workspaceId: string;
  workspaceRoot: string;
  sessionId?: string;
}

interface RegisteredFile extends LocalOfficeFileBinding {
  absolutePath: string;
  owner: "internal" | "external";
  legacyWorkspaceId?: string;
  legacyWorkspaceRoot?: string;
  legacySessionId?: string;
}

/** 原件登记不复制文件；每文件独立 child workspace 和真实 session。 */
export class LocalOfficeFiles {
  readonly id: string;
  readonly root: string;
  private readonly statePath: string;
  private loaded: Promise<void> | null = null;
  private legacySessionId: string | undefined;
  private readonly files = new Map<string, RegisteredFile>();

  constructor(private readonly options: {
    root?: string;
    statePath?: string;
    workspaceById?: (id: string) => { path: string; fileAssistantManaged?: boolean } | undefined;
  } = {}) {
    this.root = resolve(options.root ?? fileAssistantWorkspaceRoot());
    this.id = workspaceIdForPath(this.root);
    this.statePath = options.statePath ?? join(this.root, ".jugglework", "file-browser.json");
  }

  private childBinding(absolutePath: string): LocalOfficeFileBinding {
    const workspaceRoot = fileAssistantChildWorkspaceRoot(this.root, localOfficeFileId(absolutePath));
    return { workspaceId: workspaceIdForPath(workspaceRoot), workspaceRoot };
  }

  /** 启动时恢复命名空间，使冷启动后的 resolver 不会回退普通磁盘路径。 */
  load(): Promise<void> {
    return this.loaded ??= (async () => {
      let raw: string;
      try { raw = await readFile(this.statePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const value = JSON.parse(raw);
      const invalid = () => new ApiError(409, "file_assistant_state_invalid", "文件助手记录无法读取，请检查配置后重试");
      if (![1, 2].includes(value.version) || !Array.isArray(value.files)) throw invalid();
      this.legacySessionId = typeof (value.version === 1 ? value.sessionId : value.legacySessionId) === "string"
        ? (value.version === 1 ? value.sessionId : value.legacySessionId) : undefined;
      for (const file of value.files) {
        if (typeof file.key !== "string" || !file.key.startsWith("external-files/") ||
            typeof file.absolutePath !== "string" || !isPortableAbsoluteFilePath(file.absolutePath)) throw invalid();
        const binding = this.childBinding(file.absolutePath);
        if (value.version === 2 && (file.workspaceId !== binding.workspaceId || file.workspaceRoot !== binding.workspaceRoot ||
            (file.sessionId !== undefined && typeof file.sessionId !== "string") ||
            (file.legacyWorkspaceId !== undefined && file.legacyWorkspaceId !== this.id) ||
            (file.legacyWorkspaceRoot !== undefined && file.legacyWorkspaceRoot !== this.root) ||
            (file.legacySessionId !== undefined && typeof file.legacySessionId !== "string"))) throw invalid();
        this.files.set(file.key, {
          ...binding, absolutePath: file.absolutePath, owner: "internal",
          ...(value.version === 1 ? {
            legacyWorkspaceId: this.id, legacyWorkspaceRoot: this.root,
            legacySessionId: typeof file.sessionId === "string" ? file.sessionId : this.legacySessionId,
          } : {
            sessionId: file.sessionId, legacyWorkspaceId: file.legacyWorkspaceId,
            legacyWorkspaceRoot: file.legacyWorkspaceRoot, legacySessionId: file.legacySessionId,
          }),
        });
      }
    })();
  }

  /** 已持久登记的 child 必须先通过只读目录校验，不能借普通路由绕过打开入口。 */
  async invalidWorkspaceIds(workspaces: readonly WorkspaceInfo[]): Promise<Set<string>> {
    await this.load();
    const bindings = new Map([...this.files.values()].map((file) => [file.workspaceId, file]));
    const invalid = new Set<string>();
    for (const workspace of workspaces) {
      if (workspace.workspaceType === "remote" || workspace.id === this.id) continue;
      const binding = bindings.get(workspace.id);
      if (!binding && !(workspace.fileAssistantManaged && resolve(dirname(workspace.path)) === join(this.root, "files"))) continue;
      try {
        if (binding && resolve(workspace.path) !== binding.workspaceRoot) throw new Error("File assistant workspace path mismatch");
        await validateFileAssistantFileWorkspace(workspace.path);
      } catch {
        invalid.add(workspace.id);
      }
    }
    return invalid;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const value = { version: 2, legacySessionId: this.legacySessionId,
      files: [...this.files].map(([key, { owner: _owner, ...file }]) => ({ key, ...file })) };
    await writeFile(`${this.statePath}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${this.statePath}.tmp`, this.statePath);
  }

  owns(id: string): boolean {
    return id === this.id || this.options.workspaceById?.(id)?.fileAssistantManaged === true ||
      [...this.files.values()].some((file) => file.workspaceId === id);
  }

  isExternal(workspaceId: string, path: string): boolean {
    return this.owns(workspaceId) && path.startsWith("external-files/");
  }

  /** 根目录也必须属于登记过的命名空间，不接受原文件父目录。 */
  workspaceIdForRoot(root: string): string | undefined {
    const path = resolve(root);
    if (path === this.root) return this.id;
    return [...this.files.values()].find((file) => file.workspaceRoot === path)?.workspaceId;
  }

  async bindingFor(key: string): Promise<LocalOfficeFileBinding> {
    await this.load();
    const file = this.files.get(key);
    if (!file) throw new ApiError(404, "file_not_found", "文件尚未登记");
    return { workspaceId: file.workspaceId, workspaceRoot: file.workspaceRoot, sessionId: file.sessionId };
  }

  async bindSession(workspaceId: string, key: string, sessionId: string): Promise<void> {
    await this.load();
    const file = this.target(workspaceId, key);
    if (workspaceId !== file.workspaceId) throw new ApiError(409, "file_assistant_legacy_session", "旧文件会话不能绑定到新工作区");
    file.sessionId = sessionId;
    await this.persist();
  }

  async register(path: string): Promise<string> {
    await this.load();
    if (!isPortableAbsoluteFilePath(path) || !isSupportedFileWindowPath(path))
      throw new ApiError(400, "office_format_unavailable", "请选择支持的文档、文本或预览文件");
    const { absolutePath } = await inspectFile(path, true);
    if (!isPortableAbsoluteFilePath(absolutePath) || !isSupportedFileWindowPath(absolutePath))
      throw new ApiError(400, "office_format_unavailable", "请选择支持的文档、文本或预览文件");
    if (isSupportedWorkspaceTextFilePath(absolutePath) && !getOfficeDocumentKind(absolutePath))
      await readLocalTextFile(absolutePath);
    const id = localOfficeFileId(absolutePath);
    const existing = [...this.files].find(([, file]) => localOfficeFileId(file.absolutePath) === id);
    if (existing) return existing[0];
    const key = `external-files/${id}/${basename(absolutePath)}`;
    this.files.set(key, { ...this.childBinding(absolutePath), absolutePath, owner: "internal" });
    await this.persist();
    return key;
  }

  private target(workspaceId: string, key: string): RegisteredFile {
    const file = this.files.get(key);
    if (!file || (file.workspaceId !== workspaceId && file.legacyWorkspaceId !== workspaceId))
      throw new ApiError(404, "file_not_found", "文件未通过桌面宿主在此工作区打开");
    return file;
  }

  async resolve(workspaceId: string, key: string): Promise<{ absolutePath: string; file: FileArtifact }> {
    await this.load();
    const target = this.target(workspaceId, key);
    const { info } = await inspectFile(target.absolutePath);
    return { absolutePath: target.absolutePath, file: {
      artifactId: key, workspaceId, relativePath: key, name: basename(target.absolutePath), kind: "document",
      mimeType: "application/octet-stream", sizeBytes: info.size, updatedAt: info.mtimeMs, exists: true, editingOwner: target.owner,
    } };
  }

  setOwner(workspaceId: string, key: string, owner: "internal" | "external"): void {
    this.target(workspaceId, key).owner = owner;
  }
}
