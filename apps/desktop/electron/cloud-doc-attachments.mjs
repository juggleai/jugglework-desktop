import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 50 * 1024 * 1024;

/** 附件文件名只保留末级名称，避免写出缓存目录。 */
function safeName(name) {
  const base = path.basename(String(name ?? "")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (base || "attachment").slice(0, 120);
}

/**
 * 云文档附件的下载缓存与只读打开。缓存位于 `<root>/<账号键>/<tenantId>/<blobId>/<原文件名>`，
 * blobId 为内容摘要，已存在则复用。
 * @param {{ root: string, openReadOnly: (file: string) => Promise<void>, closeUnder: (directory: string) => Promise<void> }} options 缓存根目录与文件窗口能力
 */
export function createCloudDocAttachments({ root, openReadOnly, closeUnder }) {
  const pending = new Map();
  const clearing = new Set();
  const accountKey = (scope) =>
    createHash("sha256").update(`${scope.sourceServerOrigin}\0${scope.sourceUserId}`).digest("hex").slice(0, 32);
  const scopeDirectory = (scope) => path.join(root, accountKey(scope), safeName(scope.tenantId));

  /** 通过云文档会话分区下载并以只读文件窗口打开。 */
  async function download({ scope, nativeSession, contextId, origin, workspaceId, docId, blobId, name }, signal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(contextId ?? '')) throw new Error('docs_context_required');
    for (const value of [workspaceId, docId, blobId])
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(value ?? "")) throw new Error("cloud_attachment_invalid");
    const directory = path.join(scopeDirectory(scope), contextId, blobId);
    const file = path.join(directory, safeName(name));
    const exists = await fs.stat(file).then(info => info.isFile(), () => false);
    {
      const response = await nativeSession.fetch(
        `${origin}/api/jw/session/attachments/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}/${encodeURIComponent(blobId)}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: "error", headers: { "X-Jugglework-Docs-Context": contextId } },
      );
      if (!response.ok) throw new Error(`cloud_attachment_download_failed:${response.status}`);
      // TIPS: 已缓存原件也先通过原生 ACL；内容摘要不代表当前仍有阅读权限。
      if (exists) { await response.body?.cancel(); signal.throwIfAborted(); await openReadOnly(file); return { file }; }
      const size = Number(response.headers.get("content-length") ?? 0);
      if (size > MAX_BYTES) throw new Error("cloud_attachment_too_large");
      const bytes = Buffer.from(await response.arrayBuffer());
      signal.throwIfAborted();
      if (bytes.byteLength > MAX_BYTES) throw new Error("cloud_attachment_too_large");
      await fs.mkdir(directory, { recursive: true });
      const temp = `${file}.${process.pid}.part`;
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, file);
    }
    signal.throwIfAborted();
    await openReadOnly(file);
    return { file };
  }

  /** 登记下载生命周期，撤权时先取消并等待落盘结束，防止迟到请求重新打开附件。 */
  function open(input) {
    const directory = path.join(scopeDirectory(input.scope), input.contextId || "invalid");
    if (clearing.has(directory) || clearing.has(scopeDirectory(input.scope))) return Promise.reject(new Error("cloud_attachment_scope_changed"));
    const controller = new AbortController();
    const entries = pending.get(directory) ?? new Set();
    const entry = { controller, task: download(input, controller.signal) };
    entries.add(entry);
    pending.set(directory, entries);
    return entry.task.finally(() => {
      entries.delete(entry);
      if (!entries.size) pending.delete(directory);
    });
  }

  /** 先关闭打开该范围缓存的只读窗口，再删除目录。 */
  async function clearDirectory(directory) {
    clearing.add(directory);
    try {
      const entries = [...pending].filter(([key]) => key === directory || key.startsWith(directory + path.sep)).flatMap(([, entries]) => [...entries]);
      for (const entry of entries) entry.controller.abort(new Error("cloud_attachment_scope_changed"));
      await Promise.allSettled(entries.map(entry => entry.task));
      await closeUnder(directory).catch(() => undefined);
      await fs.rm(directory, { recursive: true, force: true });
    } finally { clearing.delete(directory); }
  }

  /** 只清理已经撤销的页面绑定，不能关闭同组织的新会话附件。 */
  async function clearContext(scope, contextId) {
    if (/^[A-Za-z0-9_-]{43}$/.test(contextId ?? '')) await clearDirectory(path.join(scopeDirectory(scope), contextId));
  }
  /** 来源账号切换时清理其全部只读原件；不包含任何原生编辑数据。 */
  async function clearScope(scope) { await clearDirectory(scopeDirectory(scope)); }
  return { open, clearScope, clearContext };
}
