import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebContentsView, session, shell } from "electron";

const directory = path.dirname(fileURLToPath(import.meta.url));

/** 校验仅用于 Docs 的启动目标，HTTP 仅允许明确的本机开发域。 */
export function validateCloudDocsLaunch(input) {
  if (
    !input ||
    typeof input.tenantId !== "string" ||
    !input.tenantId ||
    typeof input.sourceUserId !== "string" ||
    !input.sourceUserId ||
    typeof input.sourceServerOrigin !== "string"
  )
    throw new Error("Invalid Docs context");
  const url = new URL(input.bootstrapUrl);
  const key = `t-${createHash("sha256").update(input.tenantId).digest("hex").slice(0, 32)}`;
  if (
    !url.hostname.startsWith(`${key}.`) ||
    url.pathname !== "/api/jw/session/bootstrap" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Docs destination");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))
  )
    throw new Error("Docs requires HTTPS");
  if (
    !/^[a-f0-9-]{36}$/i.test(input.instanceId) ||
    typeof input.launchGrant !== "string" ||
    !input.launchGrant ||
    input.launchGrant.length > 512
  )
    throw new Error("Invalid Docs launch");
  const partitionKey = createHash("sha256")
    .update(`${input.sourceServerOrigin}\0${input.sourceUserId}`)
    .digest("hex");
  return {
    origin: url.origin,
    partition: `persist:jugglework-docs-affine-${partitionKey}`,
  };
}

/**
 * 独立受限原生视图承载云文档，来源／账号隔离，不复用通用浏览器会话。
 * @param {{getWindow:()=>any,onScopeRevoked?:(scope:any)=>Promise<void>|void}} options 宿主窗口和组织撤权回调
 */
export function createCloudDocsPanel({ getWindow, onScopeRevoked }) {
  let current = null;
  const wordIntakes = new Map();
  const revocations = new Map();
  const send = (value) => {
    const win = getWindow();
    if (win && !win.isDestroyed())
      win.webContents.send("jugglework:docs:state", value);
  };
  const trusted = (event) => {
    const win = getWindow();
    return (
      !!win &&
      !win.isDestroyed() &&
      event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame
    );
  };

  /** 释放当前原生页面；实例参数防止旧 React 清理销毁新租户视图。 */
  function close(instanceId) {
    if (!current || (instanceId && current.input.instanceId !== instanceId))
      return;
    const old = current;
    current = null;
    for (const [id, task] of wordIntakes) {
      clearTimeout(task.timer);
      task.reject(new Error("docs_view_closed"));
      wordIntakes.delete(id);
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(old.view);
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close();
  }

  /** 关闭与明确来源账号和组织匹配的可见产品页，不影响同账号其他组织。 */
  function closeScope(scope) {
    if (
      current?.input.sourceServerOrigin === scope?.sourceServerOrigin &&
      current.input.sourceUserId === scope?.sourceUserId &&
      current.input.tenantId === scope?.tenantId
    )
      close(current.input.instanceId);
  }

  /** TIPS: 先关闭所有该组织原生视图，再按 Origin 清缓存；同账号其他组织使用不同 Origin，不受影响。 */
  function revoke(item) {
    const key = `${item.target.partition}\0${item.origin}`;
    if (revocations.has(key)) return revocations.get(key);
    close(item.input.instanceId);
    const task = Promise.resolve(
      onScopeRevoked?.({
        sourceServerOrigin: item.input.sourceServerOrigin,
        sourceUserId: item.input.sourceUserId,
        tenantId: item.input.tenantId,
      }),
    )
      .catch(() => undefined)
      .then(() => item.nativeSession.clearStorageData({ origin: item.origin }))
      .then(() => item.nativeSession.flushStorageData())
      // TIPS: 清理失败不能形成未处理拒绝，也不能阻塞同范围重新授权；服务端仍会重新核对权限。
      .catch(() => undefined)
      .finally(() => revocations.delete(key));
    revocations.set(key, task);
    return task;
  }

  function bounds(input) {
    if (!current) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (!input || input.instanceId !== current.input.instanceId) return;
    const zoom = win.webContents.getZoomFactor();
    const rect = win.getContentBounds();
    const x = Math.max(0, Math.round(Number(input.x) * zoom));
    const y = Math.max(0, Math.round(Number(input.y) * zoom));
    const width = Math.max(
      0,
      Math.min(rect.width - x, Math.round(Number(input.width) * zoom)),
    );
    const height = Math.max(
      0,
      Math.min(rect.height - y, Math.round(Number(input.height) * zoom)),
    );
    if (![x, y, width, height].every(Number.isFinite)) return;
    current.view.setBounds({ x, y, width, height });
    const visible = input.visible === true && current.ready && width > 0 && height > 0;
    const wasVisible = current.view.getVisible();
    current.view.setVisible(visible);
    // TIPS: 隐藏授权或宿主菜单结束后恢复原生页面焦点，触发原生引擎的恢复并接收编辑输入。
    if (visible && !wasVisible) current.view.webContents.focus();
  }

  /** 用表单 POST 短时凭据打开目标原生页面；长期源令牌不会进入此模块。 */
  async function open(input) {
    const target = validateCloudDocsLaunch(input);
    close();
    await revocations.get(`${target.partition}\0${target.origin}`);
    const win = getWindow();
    if (!win || win.isDestroyed())
      throw new Error("Desktop window unavailable");
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
        // TIPS: 授权期间视图暂时隐藏，初始化与弹层动画仍需运行，避免首屏等待或弹层不绘制。
        backgroundThrottling: false,
      },
    });
    const item = {
      view,
      input,
      target,
      nativeSession,
      origin: target.origin,
      ready: false,
      denied: false,
    };
    current = item;
    win.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).protocol === "https:") void shell.openExternal(url);
      } catch {
        /* 非 URL 不执行。 */
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin === target.origin) return;
      } catch {
        /* 拒绝非预期协议。 */
      }
      event.preventDefault();
    });
    // TIPS: 跨原生 Workspace 整页导航时，等待本次授权就绪，不能显示上一页的缓存。
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (current !== item || !isMainFrame || isInPlace) return;
      item.ready = false;
      item.denied = false;
      view.setVisible(false);
    });
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (current === item && isMainFrame && code !== -3)
          send({
            instanceId: input.instanceId,
            status: "error",
            message: "云文档暂时无法连接",
          });
      },
    );
    view.webContents.on("did-navigate", (_event, _url, responseCode) => {
      if (current === item && [401, 403, 404].includes(responseCode)) {
        item.ready = false;
        item.denied = true;
        view.setVisible(false);
        send({ instanceId: input.instanceId, status: "unauthorized" });
      }
    });
    view.webContents.on("render-process-gone", () => {
      if (current !== item) return;
      // TIPS: 崩溃后的 WebContents 不会再发 ready；立即恢复宿主错误页，允许用户显式重建视图。
      item.ready = false;
      item.denied = true;
      view.setVisible(false);
      send({
        instanceId: input.instanceId,
        status: "error",
        message: "云文档暂时无法连接",
      });
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
    } catch {
      if (current === item) {
        close(input.instanceId);
        throw new Error("云文档暂时无法连接");
      }
    }
    return { instanceId: input.instanceId };
  }

  /** 注册主宿主操作和远程页面的最小只读状态消息。 */
  function registerIpc(ipcMain) {
    ipcMain.on("jugglework:docs:layout-command", (event, input) => {
      if (!trusted(event) || !current?.ready || current.denied ||
        current.input.presentation?.mode !== "product" ||
        input?.instanceId !== current.input.instanceId ||
        !["toggle-left", "toggle-right", "search", "request-state"].includes(input.action)) return;
      // TIPS: 顶部按钮位于宿主中；先恢复编辑器焦点，再执行原生展示操作。
      if (input.action !== "request-state") current.view.webContents.focus();
      current.view.webContents.send("jugglework:docs:layout-command", {
        instanceId: input.instanceId, action: input.action,
      });
    });
    ipcMain.on("jugglework:docs:appearance", (event, input) => {
      if (
        !trusted(event) ||
        !current ||
        !current.ready ||
        input?.instanceId !== current.input.instanceId
      )
        return;
      const appearance = input.appearance;
      if (
        !appearance ||
        !["light", "dark"].includes(appearance.theme) ||
        typeof appearance.locale !== "string" ||
        appearance.locale.length > 20 ||
        typeof appearance.fontFamily !== "string" ||
        appearance.fontFamily.length > 300
      )
        return;
      const colors = {};
      for (const key of [
        "background",
        "foreground",
        "sidebar",
        "border",
        "muted",
        "accent",
        "accentForeground",
      ]) {
        const value = appearance.colors?.[key];
        if (typeof value !== "string" || value.length > 150) return;
        colors[key] = value;
      }
      current.view.webContents.send("jugglework:docs:appearance", {
        instanceId: input.instanceId,
        appearance: {
          theme: appearance.theme,
          locale: appearance.locale,
          fontFamily: appearance.fontFamily,
          colors,
        },
      });
    });
    ipcMain.handle("jugglework:docs:open", (event, input) => {
      if (!trusted(event)) throw new Error("Forbidden");
      return open(input);
    });
    ipcMain.handle("jugglework:docs:close", (event, instanceId) => {
      if (!trusted(event)) throw new Error("Forbidden");
      close(instanceId);
    });
    ipcMain.handle("jugglework:docs:word-create", (event, input) => {
      if (!trusted(event)) throw new Error("Forbidden");
      const item = current;
      if (
        !item?.ready ||
        item.input.presentation?.mode !== "product" ||
        input?.instanceId !== item.input.instanceId ||
        !/^[a-f0-9-]{36}$/i.test(input?.requestId ?? "") ||
        typeof input?.title !== "string" ||
        !Array.isArray(input?.blocks) ||
        typeof input?.fileName !== "string" ||
        !/\.docx$/i.test(input.fileName) ||
        typeof input?.mimeType !== "string" ||
        typeof input?.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(input.checksum) ||
        !(
          input?.fileData instanceof ArrayBuffer ||
          ArrayBuffer.isView(input?.fileData)
        ) ||
        input.fileData.byteLength <= 0 ||
        input.fileData.byteLength > 10 * 1024 * 1024
      )
        throw new Error("docs_product_view_unavailable");
      const requestId = input.requestId;
      if (wordIntakes.has(requestId)) throw new Error("word_intake_in_progress");
      return new Promise((resolve, reject) => {
        // TIPS: preview、commit 和未知结果 status 各有独立超时；宿主必须晚于完整状态机，不能先误报失败。
        const timer = setTimeout(() => {
          wordIntakes.delete(requestId);
          reject(new Error("word_intake_timeout"));
        }, 95000);
        timer.unref?.();
        wordIntakes.set(requestId, { resolve, reject, timer, item });
        item.view.webContents.send("jugglework:docs:word-intake-command", {
          instanceId: item.input.instanceId,
          requestId,
          payload: {
            requestId,
            title: input.title,
            blocks: input.blocks,
            fileName: input.fileName,
            mimeType: input.mimeType,
            fileData: input.fileData,
            checksum: input.checksum,
          },
        });
      });
    });
    ipcMain.on("jugglework:docs:bounds", (event, input) => {
      if (trusted(event)) bounds(input);
    });
    ipcMain.on("jugglework:docs:message", (event, message) => {
      const item = current;
      if (
        !item ||
        event.sender !== item.view.webContents ||
        event.senderFrame !== item.view.webContents.mainFrame
      )
        return;
      if (
        message?.contractVersion !== 1 ||
        message.instanceId !== item.input.instanceId
      )
        return;
      if (new URL(item.view.webContents.getURL()).origin !== item.origin)
        return;
      if (message.type === "docs.layout") {
        const layout = message.layout;
        if (!item.ready || item.denied || message.tenantId !== item.input.tenantId ||
          item.input.presentation?.mode !== "product" ||
          typeof layout?.leftOpen !== "boolean" || typeof layout?.rightOpen !== "boolean" ||
          !Number.isFinite(layout.leftWidth) || layout.leftWidth < 248 || layout.leftWidth > 480) return;
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send("jugglework:docs:layout", {
          instanceId: item.input.instanceId,
          layout: {
            leftOpen: layout.leftOpen,
            rightOpen: layout.rightOpen,
            leftWidth: layout.leftWidth * item.view.webContents.getZoomFactor() / win.webContents.getZoomFactor(),
          },
        });
      } else if (message.type === "docs.ready") {
        if (
          message.tenantId !== item.input.tenantId ||
          typeof message.workspaceId !== "string" ||
          !message.workspaceId
        )
          return;
        // TIPS: 被拒绝的当前页面不能靠迟到的就绪消息重新显示，需重新进入并完成授权。
        if (item.denied) return;
        item.ready = true;
        send({
          instanceId: message.instanceId,
          status: "ready",
          workspaceId: message.workspaceId,
        });
      } else if (
        message.type === "docs.session-expired" ||
        message.type === "docs.error"
      ) {
        item.ready = false;
        if (message.type === "docs.session-expired") item.denied = true;
        item.view.setVisible(false);
        send({
          instanceId: message.instanceId,
          status:
            message.type === "docs.session-expired" ? "unauthorized" : "error",
          message: "云文档连接已失效，请重新打开",
        });
        if (message.type === "docs.session-expired") void revoke(item);
      }
    });
    ipcMain.on("jugglework:docs:word-intake", (event, message) => {
      const task = wordIntakes.get(message?.requestId);
      if (
        !task ||
        current !== task.item ||
        event.sender !== task.item.view.webContents ||
        event.senderFrame !== task.item.view.webContents.mainFrame ||
        message.instanceId !== task.item.input.instanceId
      )
        return;
      wordIntakes.delete(message.requestId);
      clearTimeout(task.timer);
      if (message.ok === true && message.result?.pageId)
        task.resolve(message.result);
      else
        task.reject(
          new Error(
            message.error || message.result?.message || "word_intake_failed",
          ),
        );
    });
  }
  return { registerIpc, close, closeScope };
}
