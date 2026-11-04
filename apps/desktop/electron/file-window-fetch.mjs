import { mainProcessFetchBody } from "./main-fetch.mjs";
import { authorizeConversationModel, authorizeConversationRequest, conversationDenied, ownedInteraction, ownedRun, projectConversationResponse } from "./file-window-conversation.mjs";

export const FILE_WINDOW_RESPONSE_LIMITS_V1 = Object.freeze({
  json: 8 * 1024 * 1024,
  raw: 64 * 1024 * 1024,
});
const MAX_REQUEST_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;
const denied = () => new Error("文件窗口请求超出已登记文件范围");

function assertKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw denied();
}

function registeredPath(entry, value) {
  if (typeof value !== "string" || !value || value.includes("\\") ||
      value.includes("\0") || value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) throw denied();
  const tab = entry.tabs.find((item) => item.path === value);
  if (!tab) throw denied();
  return tab;
}

/**
 * 校验登记窗口所需的最小 HTTP 集合；认证及传输选项由 Main 重建。
 * @param {object} entry Main 登记的工作区、聊天及文件标签
 * @param {object} access 当前本地服务连接
 * @param {string} input Renderer 请求 URL
 * @param {object} init Renderer 请求参数
 */
export function authorizeFileWindowFetch(entry, access, input, init = {}) {
  if (!access?.baseUrl || !access.clientToken || !entry?.workspaceId || !entry.sessionId) throw denied();
  const base = new URL(access.baseUrl);
  const url = new URL(input);
  // 不接受别名、userinfo、fragment、URL 规范化后的绕路或其他本地端口。
  if (input !== url.href || url.origin !== base.origin || url.username || url.password || url.hash ||
      !["http:", "https:"].includes(base.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw denied();
  const prefix = `${base.pathname.replace(/\/$/, "")}/workspace/${encodeURIComponent(entry.workspaceId)}`;
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    const name = key.toLowerCase();
    if (!((name === "accept" && ["application/json", "*/*"].includes(value)) ||
        (name === "content-type" && value === "application/json") ||
        (name === "x-opencode-directory" && [entry.workspaceRoot, encodeURIComponent(entry.workspaceRoot)].includes(value)))) throw denied();
  }
  const method = init.method ?? "GET";
  if (!["GET", "POST"].includes(method)) throw denied();
  if (init.bodyBytes !== undefined && !(init.bodyBytes instanceof Uint8Array)) throw denied();
  if (init.body !== undefined && typeof init.body !== "string") throw denied();
  if (init.bodyBytes !== undefined && init.body !== undefined) throw denied();
  // 在复制字节及 JSON 解析前限制输入。
  if ((init.bodyBytes?.byteLength ?? 0) > MAX_REQUEST_BYTES ||
      (typeof init.body === "string" && Buffer.byteLength(init.body) > MAX_REQUEST_BYTES)) throw denied();
  let body = mainProcessFetchBody(init);
  if (method === "GET" && body !== undefined) throw denied();
  let parsed;
  if (method === "POST") {
    parsed = JSON.parse(body?.toString() ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw denied();
  }
  const query = url.searchParams;
  let tab;
  let bindsDocument = false;
  let maxResponseBytes = FILE_WINDOW_RESPONSE_LIMITS_V1.json;
  let conversation;
  if (method === "GET" && ["raw", "stat", "content"].some((name) => url.pathname === `${prefix}/files/${name}`)) {
    if ([...query.keys()].length !== 1 || !query.has("path")) throw denied();
    tab = registeredPath(entry, query.get("path"));
    if (url.pathname === `${prefix}/files/raw`) maxResponseBytes = FILE_WINDOW_RESPONSE_LIMITS_V1.raw;
  } else if (method === "GET" && url.pathname === `${prefix}/office/capabilities` && !url.search) {
    // 工作区能力不暴露其他文件。
  } else if (method === "POST" && ["open", "reopen"].some((name) => url.pathname === `${prefix}/office/${name}`) && !url.search) {
    assertKeys(parsed, ["sessionId", "path"]);
    if (parsed.sessionId !== entry.sessionId) throw denied();
    tab = registeredPath(entry, parsed.path);
    bindsDocument = true;
  } else {
    tab = entry.tabs.find((item) => item.documentId && (
      (method === "GET" && url.pathname === `${prefix}/office/${encodeURIComponent(item.documentId)}`) ||
      (method === "POST" && url.pathname === `${prefix}/office/${encodeURIComponent(item.documentId)}/save`)
    ));
    if (tab) {
      if (url.search) throw denied();
      if (method === "POST") assertKeys(parsed, []);
    } else conversation = authorizeConversationRequest(entry, url, prefix, method, parsed);
  }
  const headers = { Authorization: `Bearer ${access.clientToken}`, Accept: "application/json" };
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (conversation && ["provider", "agent"].includes(conversation.kind)) headers["x-opencode-directory"] = encodeURIComponent(entry.workspaceRoot);
  if (conversation?.kind === "start") body = Buffer.from(JSON.stringify({ ...parsed, whenBusy: "reject" }));
  if (conversation?.kind === "interactions") url.search = "?includeDescendants=true";
  return { url: url.href, init: { method, headers, body, redirect: "error", credentials: "omit", cache: "no-store" }, tab, bindsDocument, maxResponseBytes, conversation, prefix };
}

/** 限制完整响应（含流式 body）的字节数与时间，不将 renderer 传输/诊断选项透传。 */
export async function fetchFileWindowResponse(entry, access, url, init, fetchImpl, signal, beforeAbort) {
  const request = authorizeFileWindowFetch(entry, access, url, init);
  const requestedTimeout = Number(init?.timeoutMs);
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, TIMEOUT_MS) : TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
  let reader;
  let mutationSent = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); rejectAbort(denied()); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new Error("文件窗口请求超时"));
    }, timeout);
  });
  try {
    return await Promise.race([deadline, aborted, (async () => {
      if (controller.signal.aborted) throw denied();
      // Ownership checks use the same bounded/abortable transport, before any mutation.
      const kind = request.conversation?.kind;
      if (kind === "start") {
        const check = await fetchFileWindowResponse(entry, access, `${new URL(access.baseUrl).origin}${request.prefix}/opencode/provider`, {}, fetchImpl, controller.signal);
        if (check.status !== 200) throw conversationDenied();
        authorizeConversationModel(entry, JSON.parse(request.init.body.toString()).prompt.model, JSON.parse(Buffer.from(check.body).toString()));
      }
      if (kind === "abort" || kind === "reply") {
        const route = kind === "abort" ? `${request.prefix}/session-runs`
          : `${request.prefix}/sessions/${encodeURIComponent(entry.sessionId)}/interactions/snapshot?includeDescendants=true`;
        const check = await fetchFileWindowResponse(entry, access, `${new URL(access.baseUrl).origin}${route}`, {}, fetchImpl, controller.signal);
        if (check.status !== 200) throw conversationDenied();
        const value = JSON.parse(Buffer.from(check.body).toString());
        const owned = kind === "abort" ? value.items?.some((run) => ownedRun(entry, run) && run.runId === request.conversation.runId)
          : value.item?.[request.conversation.interactionType === "permission" ? "permissions" : "questions"]?.some((item) => ownedInteraction(entry, item) &&
            item.targetSessionId === request.conversation.targetSessionId && item.id === request.conversation.interactionId);
        if (!owned || controller.signal.aborted) throw conversationDenied();
        if (kind === "abort") await beforeAbort?.(controller.signal);
      }
      if (controller.signal.aborted) throw conversationDenied();
      mutationSent = request.init.method === "POST";
      const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
      reader = response.body?.getReader();
      if (controller.signal.aborted) { await reader?.cancel().catch(() => {}); throw denied(); }
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw denied();
      if (Number(response.headers.get("content-length")) > request.maxResponseBytes) throw new Error("文件窗口响应过大");
      const chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > request.maxResponseBytes) throw new Error("文件窗口响应过大");
        chunks.push(Buffer.from(value));
      }
      let bytes = Buffer.concat(chunks, size);
      if (controller.signal.aborted || (request.tab && !entry.tabs.includes(request.tab))) throw denied();
      if (request.bindsDocument && response.ok) {
        const document = JSON.parse(bytes.toString()).document;
        // Main 已为当前标签登记的精确 ID 可复用同一文档的 canonical/alias 路径。
        // 新 ID 仍须匹配请求路径，其他标签的登记不能授予当前标签文档身份。
        if (typeof document?.documentId !== "string" || !document.documentId ||
            document.workspaceId !== entry.workspaceId || document.ownerSessionId !== entry.sessionId ||
            (document.relativePath !== request.tab.path && document.documentId !== request.tab.documentId)) throw denied();
        request.tab.documentId = document.documentId;
      }
      if (request.conversation) {
        if (response.ok) bytes = Buffer.from(JSON.stringify(projectConversationResponse(entry, request.conversation, JSON.parse(bytes.toString()))));
        else {
          if (request.conversation.kind === "interactions") entry.verifiedDescendants = new Set();
          // Error bodies and diagnostic headers may contain engine/provider credentials.
          let value;
          try { value = JSON.parse(bytes.toString()); } catch { value = {}; }
          bytes = Buffer.from(JSON.stringify({ error: "File-window session request failed", ...(typeof value.code === "string" && /^[a-z0-9_]{1,80}$/.test(value.code) ? { code: value.code } : {}) }));
        }
      }
      return { status: response.status, statusText: request.conversation ? "" : response.statusText,
        headers: request.conversation ? [["content-type", "application/json"]] : [...response.headers.entries()], body: Uint8Array.from(bytes).buffer };
    })()]);
  } catch (error) {
    // JSON parser errors can quote an upstream body; do not serialize it through Electron IPC.
    if (mutationSent && request.conversation) throw new Error("fetch failed: submission outcome unconfirmed");
    if (request.conversation?.kind === "interactions") entry.verifiedDescendants = new Set();
    if (request.conversation && error?.message !== "文件窗口请求超时") throw conversationDenied();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
