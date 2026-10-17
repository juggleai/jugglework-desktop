import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import type { FileArtifact } from "@jugglework/types/file-artifacts";
import { ApiError } from "../errors.js";

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

/** 明确选择的本机文件集合；上下文不是工作区，不授予父目录访问能力。 */
export class LocalOfficeFiles {
  readonly id = `local-office-${randomUUID()}`;
  readonly sessionId = "file-browser";
  private readonly files = new Map<
    string,
    { absolutePath: string; owner: "internal" | "external" }
  >();

  /** 判断 Office API 的上下文是否属于本次 Server 的本机文件集合。 */
  owns(id: string): boolean {
    return id === this.id;
  }

  /** 仅供可信桌面宿主登记用户明确选择的绝对路径，规范化一次并保留文件名。 */
  async register(path: string): Promise<string> {
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
    const key = `${randomUUID()}/${basename(absolutePath)}`;
    this.files.set(key, { absolutePath, owner: "internal" });
    return key;
  }

  /** 按已登记标识解析文件；任意路径及目录均不能借此访问。 */
  async resolve(
    key: string,
  ): Promise<{ absolutePath: string; file: FileArtifact }> {
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
