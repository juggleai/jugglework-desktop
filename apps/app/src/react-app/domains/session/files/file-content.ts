import {
  JuggleWorkServerError,
  type JuggleWorkServerClient,
} from "@/app/lib/jugglework-server";

/**
 * 文件在面板中的呈现形态
 *
 * - `markdown` / `text`：可编辑的文本
 * - `image` / `pdf` / `html`：只读预览
 * - `binary`：不可预览，只提供下载与在系统中打开
 */
export type FilePresentation = "markdown" | "text" | "image" | "pdf" | "html" | "binary";

/**
 * 已加载的文件内容
 *
 * @param presentation 呈现形态
 * @param text 文本内容，二进制文件为 null
 * @param bytes 原始字节，文本文件同样保留（供下载与二进制预览使用）
 * @param contentType 服务端返回的 MIME 类型
 * @param updatedAt 服务端文件 mtime，保存时作为乐观并发校验基准
 * @param size 文件字节数
 */
export type LoadedFile = {
  presentation: FilePresentation;
  text: string | null;
  bytes: ArrayBuffer;
  contentType: string | null;
  updatedAt: number | null;
  size: number;
};

/** 面板可读取的最大字节数，与服务端 `/files/raw` 的上限保持一致 */
export const MAX_READABLE_FILE_BYTES = 5_000_000;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"];
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const HTML_EXTENSIONS = [".html", ".htm"];
const BINARY_EXTENSIONS = [
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".xlsx", ".xls", ".ods", ".docx", ".doc", ".pptx", ".ppt", ".key", ".odp",
  ".class", ".jar", ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm", ".node",
  ".db", ".sqlite", ".sqlite3", ".pack", ".idx", ".keystore", ".jks", ".p12",
  ".heic", ".psd", ".sketch", ".apk", ".ipa", ".aab", ".dmg", ".pdf",
];

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const index = name.lastIndexOf(".");

  return index > 0 ? name.slice(index).toLowerCase() : "";
}

/**
 * 判断字节流是否是可安全按 UTF-8 展示的文本
 *
 * TIPS: 目录树可以打开任意文件，扩展名不足以判定类型（Dockerfile、LICENSE 等无扩展名）。
 * 这里先看前 8KB 有没有 NUL 字节，再用 `TextDecoder(fatal)` 校验编码，
 * 两关都过才当文本，避免把二进制内容塞进编辑器后保存导致文件损坏。
 *
 * @param bytes 文件字节
 */
export function looksLikeText(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  const probe = view.subarray(0, Math.min(view.length, 8192));

  for (const byte of probe) {
    if (byte === 0) return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(view);

    return true;
  } catch {
    return false;
  }
}

/**
 * 推断文件的呈现形态
 *
 * @param path 工作区相对路径
 * @param bytes 已读取的文件字节
 */
export function resolvePresentation(path: string, bytes: ArrayBuffer): FilePresentation {
  const ext = extensionOf(path);

  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (BINARY_EXTENSIONS.includes(ext)) return "binary";
  if (!looksLikeText(bytes)) return "binary";
  if (MARKDOWN_EXTENSIONS.includes(ext)) return "markdown";
  if (HTML_EXTENSIONS.includes(ext)) return "html";

  return "text";
}

/**
 * 面板文件读写失败的归一化错误
 *
 * @param kind 失败类型：文件缺失、超出大小上限、保存冲突、其它
 */
export class FileAccessError extends Error {
  kind: "not_found" | "too_large" | "conflict" | "unknown";

  constructor(kind: FileAccessError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function normalizeError(cause: unknown): FileAccessError {
  if (cause instanceof JuggleWorkServerError) {
    if (cause.status === 404 || cause.code === "file_not_found") {
      return new FileAccessError("not_found", cause.message);
    }
    if (cause.status === 413 || cause.code === "file_too_large") {
      return new FileAccessError("too_large", cause.message);
    }
    if (cause.status === 409 || cause.code === "conflict") {
      return new FileAccessError("conflict", cause.message);
    }

    return new FileAccessError("unknown", cause.message);
  }

  return new FileAccessError("unknown", cause instanceof Error ? cause.message : String(cause));
}

/**
 * 读取工作区文件
 *
 * TIPS: 走 `/files/raw` 而不是 `/files/content` —— 后者有扩展名白名单，
 * `.py`/`.kt`/`.gradle` 等常见文件会被直接拒绝，而目录树可以打开任意文件。
 * `updatedAt` 只有 `/files/stat` 才返回，因此两个请求并发发出。
 *
 * @param client JuggleWork 服务端客户端
 * @param workspaceId 工作区 id
 * @param path 工作区相对路径
 * @returns 已加载的文件内容
 */
export async function loadWorkspaceFile(
  client: JuggleWorkServerClient,
  workspaceId: string,
  path: string,
): Promise<LoadedFile> {
  try {
    const [raw, info] = await Promise.all([
      client.downloadWorkspaceFile(workspaceId, path),
      client.statWorkspaceFile(workspaceId, path).catch(() => null),
    ]);
    const presentation = resolvePresentation(path, raw.data);

    return {
      presentation,
      text: presentation === "binary" || presentation === "image" || presentation === "pdf"
        ? null
        : new TextDecoder("utf-8").decode(raw.data),
      bytes: raw.data,
      contentType: raw.contentType,
      updatedAt: info?.updatedAt ?? null,
      size: info?.size ?? raw.data.byteLength,
    };
  } catch (cause) {
    throw normalizeError(cause);
  }
}

/**
 * 保存文本文件
 *
 * TIPS: 同样走 `/files/raw` 的二进制写入，避开 `/files/content` 的扩展名白名单；
 * `baseUpdatedAt` 由服务端做乐观并发校验，文件被外部改动时返回 409。
 *
 * @param client JuggleWork 服务端客户端
 * @param workspaceId 工作区 id
 * @param path 工作区相对路径
 * @param content 待写入的文本
 * @param baseUpdatedAt 打开文件时的 mtime
 * @returns 写入后的 mtime
 */
export async function saveWorkspaceTextFile(
  client: JuggleWorkServerClient,
  workspaceId: string,
  path: string,
  content: string,
  baseUpdatedAt: number | null,
): Promise<number> {
  try {
    const bytes = new TextEncoder().encode(content);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const result = await client.writeWorkspaceBinaryFile(workspaceId, {
      path,
      data: buffer,
      baseUpdatedAt,
    });

    return result.updatedAt;
  } catch (cause) {
    throw normalizeError(cause);
  }
}
