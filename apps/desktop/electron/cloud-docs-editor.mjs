import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebContentsView, session } from "electron";
import { validateCloudDocsLaunch } from "./cloud-docs-panel.mjs";

const commands = new Set([
  "editor.original",
  "editor.attach",
  "editor.restore",
  "editor.apply",
  "editor.structure",
  "editor.project",
  "editor.ack",
  "editor.discard",
  "editor.bind",
  "editor.state",
  "editor.checkpoint",
  "editor.detach",
]);
/**
 * 承载每份 Word 的独立原生编辑视图；与用户可见的云文档产品视图分别管理。
 * @param {{onEvent:(attachmentId:string,message:any)=>void,onScopeRevoked?:(scope:any)=>Promise<void>|void}} options 主进程当前关联事件接收器
 */
export function createCloudDocsEditors({ onEvent, onScopeRevoked }) {
  const entries = new Map();
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const current = (entry) =>
    entries.get(entry.id) === entry &&
    !entry.closed &&
    !entry.view.webContents.isDestroyed();
  /** 释放指定原生实例；在途响应不转发给其他关联或新页面。 */
  function close(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.closed = true;
    clearTimeout(entry.readyTimer);
    entry.rejectReady?.(Error("editor_closed"));
    for (const task of entry.pending.values()) {
      clearTimeout(task.timer);
      task.reject(Error("editor_closed"));
    }
    entry.pending.clear();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }
  /**
   * 在源授权交接后打开独立的后台原生编辑器；不持有源登录令牌。
   * @param {any} input 明确账号／租户／页面及一次性交接，attachmentId 不得复用于其他文件
   */
  async function open(input) {
    if (
      !/^[a-f0-9-]{36}$/i.test(input?.attachmentId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input?.pageId)
    )
      throw Error("invalid_editor_context");
    const target = validateCloudDocsLaunch(input);
    close(input.attachmentId);
    const nativeSession = session.fromPartition(target.partition);
    nativeSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    const view = new WebContentsView({
      webPreferences: {
        session: nativeSession,
        preload: path.join(directory, "cloud-docs-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const entry = {
      id: input.attachmentId,
      input,
      view,
      origin: target.origin,
      pending: new Map(),
      closed: false,
      bridgeId: null,
      workspaceId: null,
    };
    const ready = new Promise((resolve, reject) => {
      entry.resolveReady = resolve;
      entry.rejectReady = reject;
    });
    // TIPS: 加载失败或关闭可能先于 await ready，提前接收拒绝，避免未处理异常。
    void ready.catch(() => {});
    entry.readyTimer = setTimeout(() => {
      entry.rejectReady?.(Error("editor_timeout"));
      close(entry.id);
    }, 15000);
    entry.readyTimer.unref?.();
    entries.set(entry.id, entry);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin === entry.origin) return;
      } catch {}
      event.preventDefault();
    });
    view.webContents.on("render-process-gone", () => {
      if (current(entry)) {
        onEvent(entry.id, {
          type: "editor.paused",
          payload: { reason: "editor_process_gone" },
        });
        close(entry.id);
      }
    });
    try {
      await view.webContents.loadURL(input.bootstrapUrl, {
        postData: [
          {
            type: "rawData",
            bytes: Buffer.from(
              new URLSearchParams({ grant: input.launchGrant }).toString(),
            ),
          },
        ],
        extraHeaders: "Content-Type: application/x-www-form-urlencoded\r\n",
      });
      await ready;
      if (!current(entry)) throw Error("editor_closed");
      const bridgeId = entry.bridgeId;
      return {
        /** 固定业务请求，绑定此次原生页面代次；页面重建后绝不自动重发正文。 */
        async call(type, payload) {
          if (
            !commands.has(type) ||
            !current(entry) ||
            entry.bridgeId !== bridgeId
          )
            throw Error("editor_generation_changed");
          const requestId = randomUUID(),
            message = {
              type,
              contractVersion: 1,
              instanceId: input.instanceId,
              bridgeId,
              tenantId: input.tenantId,
              workspaceId: entry.workspaceId,
              pageId: input.pageId,
              requestId,
              payload,
            };
          if (
            JSON.stringify(message).length >
            (type === "editor.restore" ? 48 * 1024 * 1024 : 1024 * 1024)
          )
            throw Error("editor_message_too_large");
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              entry.pending.delete(requestId);
              reject(Error("editor_response_unknown"));
            }, 15000);
            timer.unref?.();
            entry.pending.set(requestId, { resolve, reject, timer });
            try {
              view.webContents.send("jugglework:docs:editor-command", message);
            } catch (error) {
              clearTimeout(timer);
              entry.pending.delete(requestId);
              reject(error);
            }
          });
        },
        /** 关闭当前关联拥有的原生视图。 */
        close() {
          if (current(entry)) close(entry.id);
        },
        context: {
          bridgeId,
          workspaceId: entry.workspaceId,
          instanceId: input.instanceId,
        },
      };
    } catch (error) {
      close(entry.id);
      throw error;
    }
  }
  return {
    open,
    close,
    /** 只接受实际后台视图主框架的固定实例消息，不信任载荷声明的来源。 */
    registerIpc(ipcMain) {
      ipcMain.on("jugglework:docs:editor-message", (event, message) => {
        const entry = [...entries.values()].find(
          (e) => event.sender === e.view.webContents,
        );
        if (
          !entry ||
          !current(entry) ||
          event.senderFrame !== entry.view.webContents.mainFrame
        )
          return;
        try {
          if (new URL(entry.view.webContents.getURL()).origin !== entry.origin)
            return;
        } catch {
          return;
        }
        if (
          message?.contractVersion !== 1 ||
          message.instanceId !== entry.input.instanceId ||
          message.tenantId !== entry.input.tenantId ||
          message.pageId !== entry.input.pageId ||
          !/^[a-f0-9-]{36}$/i.test(message.bridgeId) ||
          typeof message.workspaceId !== "string"
        )
          return;
        if (message.type === "editor.ready") {
          if (entry.bridgeId && entry.bridgeId !== message.bridgeId) {
            onEvent(entry.id, {
              type: "editor.paused",
              payload: { reason: "editor_generation_changed" },
            });
            close(entry.id);
            return;
          }
          if (
            message.payload?.canEdit !== true ||
            message.payload?.capability !== "word-relative-plain-v1"
          ) {
            entry.rejectReady?.(Error("editor_readonly"));
            close(entry.id);
            return;
          }
          entry.bridgeId = message.bridgeId;
          entry.workspaceId = message.workspaceId;
          clearTimeout(entry.readyTimer);
          entry.resolveReady?.();
          return;
        }
        if (
          message.bridgeId !== entry.bridgeId ||
          message.workspaceId !== entry.workspaceId
        )
          return;
        if (message.type === "editor.response") {
          const task = entry.pending.get(message.payload?.requestId);
          if (!task) return;
          entry.pending.delete(message.payload.requestId);
          clearTimeout(task.timer);
          task.resolve(message.payload.result);
          return;
        }
        if (
          ["editor.pending", "editor.structure", "editor.paused"].includes(
            message.type,
          )
        ) {
          onEvent(entry.id, message);
          if (
            message.type === "editor.paused" &&
            message.payload?.reason === "session_expired"
          ) {
            // TIPS: 后台编辑器可能在产品页关闭时先收到撤权；关闭同一组织全部视图后仅清该 Origin。
            const affected = [...entries.values()].filter(
              item =>
                item.input.sourceServerOrigin ===
                  entry.input.sourceServerOrigin &&
                item.input.sourceUserId === entry.input.sourceUserId &&
                item.input.tenantId === entry.input.tenantId,
            );
            for (const item of affected) {
              if (item !== entry)
                onEvent(item.id, {
                  type: "editor.paused",
                  payload: { reason: "session_expired" },
                });
              close(item.id);
            }
            void Promise.resolve(
              onScopeRevoked?.({
                sourceServerOrigin: entry.input.sourceServerOrigin,
                sourceUserId: entry.input.sourceUserId,
                tenantId: entry.input.tenantId,
              }),
            ).catch(() => undefined);
            const nativeSession = session.fromPartition(
              validateCloudDocsLaunch(entry.input).partition,
            );
            void nativeSession
              .clearStorageData({ origin: entry.origin })
              .then(() => nativeSession.flushStorageData())
              .catch(() => undefined);
          }
        }
      });
    },
    /** 账号退出或进程关闭时释放全部原生会话，不保留可自动重放的调用。 */
    dispose() {
      for (const id of [...entries.keys()]) close(id);
    },
  };
}
