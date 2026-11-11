const resource = /^[A-Za-z0-9_-]{1,128}$/;
const pageResource = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint = /^\d{1,8}:\d{1,10}$/;
const kinds = new Set([
  "page.user_mention",
  "comment.user_mention",
  "comment.created",
  "comment.resolved",
]);

function hasOnlyKeys(value, expected) {
  return Object.keys(value).every((key) => expected.has(key));
}

function safeServer(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * 校验系统通知点击动作；只允许固定云文档定位和接收时来源，不接受凭据或任意 URL。
 * @param {unknown} value 系统通知动作
 * @returns {import("@jugglework/types/desktop-ipc").DesktopNotificationAction | null}
 */
export function sanitizeDesktopNotificationAction(value) {
  if (!value || typeof value !== "object") return null;
  const action = /** @type {any} */ (value);
  if (!hasOnlyKeys(action, new Set(["type", "contractVersion", "source", "payload", "conversationId"]))) return null;
  if (action.type !== "docs.open" || action.contractVersion !== 1 || !pageResource.test(action.conversationId ?? "")) return null;
  const source = /** @type {any} */ (action.source);
  if (!source || typeof source !== "object" || !hasOnlyKeys(source, new Set(["server", "userId", "tenantId", "authFingerprint"]))) return null;
  const server = safeServer(source.server);
  if (!server || !resource.test(source.userId ?? "") || !resource.test(source.tenantId ?? "") || !fingerprint.test(source.authFingerprint ?? "")) return null;
  const payload = /** @type {any} */ (action.payload);
  if (!payload || typeof payload !== "object" || !hasOnlyKeys(payload, new Set(["contractVersion", "eventId", "tenantId", "pageId", "commentId", "kind", "occurredAt", "part"]))) return null;
  if (
    payload.contractVersion !== 1 ||
    !uuid.test(payload.eventId ?? "") ||
    payload.tenantId !== source.tenantId ||
    !pageResource.test(payload.pageId ?? "") ||
    (payload.commentId !== undefined && !pageResource.test(payload.commentId ?? "")) ||
    !kinds.has(payload.kind) ||
    typeof payload.occurredAt !== "string" ||
    payload.occurredAt.length > 40 ||
    !Number.isFinite(Date.parse(payload.occurredAt)) ||
    !["group", "direct"].includes(payload.part)
  ) return null;
  return Object.freeze({
    type: "docs.open",
    contractVersion: 1,
    source: Object.freeze({
      server,
      userId: source.userId,
      tenantId: source.tenantId,
      authFingerprint: source.authFingerprint,
    }),
    payload: Object.freeze({
      contractVersion: 1,
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      pageId: payload.pageId,
      ...(payload.commentId ? { commentId: payload.commentId } : {}),
      kind: payload.kind,
      occurredAt: payload.occurredAt,
      part: payload.part,
    }),
    conversationId: action.conversationId,
  });
}

/**
 * 创建系统通知动作交接队列，在渲染进程尚未就绪或发生重载时暂存点击动作。
 * @param {{ send: (owner: unknown, action: import("@jugglework/types/desktop-ipc").DesktopNotificationAction) => boolean, maxPending?: number }} options 发送实现和最大暂存数量
 * @returns {{ enqueue: (action: import("@jugglework/types/desktop-ipc").DesktopNotificationAction) => "delivered" | "queued", ready: (owner: unknown) => number, reset: (owner?: unknown) => void, pendingCount: () => number }}
 */
export function createDesktopNotificationActionRelay(options) {
  const maxPending = Number.isSafeInteger(options?.maxPending) && options.maxPending > 0
    ? options.maxPending
    : 32;
  const pending = new Map();
  let readyOwner = null;

  const actionKey = (action) => [
    action.source.server,
    action.source.userId,
    action.source.tenantId,
    action.payload.eventId,
  ].join("\u0000");

  const trySend = (owner, action) => {
    try {
      return options.send(owner, action) === true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    /**
     * 发送或暂存一个已校验动作。
     * @param {import("@jugglework/types/desktop-ipc").DesktopNotificationAction} action 已校验动作
     * @returns {"delivered" | "queued"} 交接结果
     */
    enqueue(action) {
      if (readyOwner !== null && trySend(readyOwner, action)) return "delivered";
      readyOwner = null;
      // TIPS: 以来源和事件号去重，避免渲染器启动期间重复点击生成重复导航。
      pending.set(actionKey(action), action);
      while (pending.size > maxPending) pending.delete(pending.keys().next().value);
      return "queued";
    },

    /**
     * 标记当前渲染器已安装监听，并按接收顺序交接暂存动作。
     * @param {unknown} owner 当前渲染器标识
     * @returns {number} 已交接数量
     */
    ready(owner) {
      readyOwner = owner;
      let delivered = 0;
      for (const [key, action] of pending) {
        if (!trySend(owner, action)) {
          readyOwner = null;
          break;
        }
        pending.delete(key);
        delivered += 1;
      }
      return delivered;
    },

    /**
     * 渲染器导航、卸载或销毁时停止直接发送，保留未交接动作。
     * @param {unknown} [owner] 需要失效的渲染器标识；省略时无条件失效
     */
    reset(owner) {
      if (owner === undefined || Object.is(owner, readyOwner)) readyOwner = null;
    },

    /** @returns {number} 当前暂存动作数量。 */
    pendingCount() {
      return pending.size;
    },
  });
}

/**
 * 绑定 Electron 系统通知点击，并保证聚焦失败不会丢失已校验动作。
 * @param {{ on: (event: "click", callback: () => void) => unknown }} notification 系统通知实例
 * @param {{ action: import("@jugglework/types/desktop-ipc").DesktopNotificationAction | null, relay: ReturnType<typeof createDesktopNotificationActionRelay>, focus: (href?: unknown) => Promise<unknown> | unknown, href?: unknown, onFocusError?: (error: unknown) => void }} options 点击交接依赖
 */
export function bindDesktopNotificationClick(notification, options) {
  notification.on("click", () => {
    // TIPS: 动作先进入交接队列；窗口尚未创建、页面重载或聚焦失败都不能吞掉用户点击。
    if (options.action) options.relay.enqueue(options.action);
    Promise.resolve()
      .then(() => options.focus(options.href))
      .catch(error => options.onFocusError?.(error));
  });
}
