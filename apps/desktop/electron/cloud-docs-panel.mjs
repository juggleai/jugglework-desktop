import { createHash, randomUUID } from "node:crypto";
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
  const expected = new URL(input.docsOrigin);
  if (
    url.origin !== expected.origin || expected.href !== `${expected.origin}/` ||
    url.pathname !== "/api/jw/session/bootstrap" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Docs destination");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || ["127.0.0.1", "[::1]"].includes(url.hostname)))
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
    .update(`${input.sourceServerOrigin}\0${input.sourceUserId}\0${input.tenantId}`)
    .digest("hex");
  return {
    origin: url.origin,
    partition: `persist:jugglework-docs-affine-${partitionKey}`,
  };
}

/**
 * 独立受限原生视图承载云文档，来源／账号隔离，不复用通用浏览器会话。
 * @param {{getWindow:()=>any,getWindows?:()=>any[],onDocumentChanged?:(window:any,instanceId:string,document:{tenantId:string,workspaceId:string,docId:string,title:string})=>void,attachments?:{open:(input:any)=>Promise<any>,clearScope:(scope:any)=>Promise<void>,clearContext?:(scope:any,contextId:string)=>Promise<void>}}} options 宿主窗口与受限附件访问
 */
export function createCloudDocsPanel({ getWindow, getWindows = () => [getWindow()], onDocumentChanged, attachments }) {
  const currents = new Map();
  const backgrounds = new Map();
  const retained = new Map();
  const intakes = new Map();
  const revocations = new Map();
  const items = () => [...new Set([...currents.values(), ...retained.values(), ...backgrounds.values()])];
  const active = (item) => !!item && (currents.get(item.ownerWindow.id) === item || retained.get(item.input.instanceId) === item || backgrounds.get(item.input.instanceId) === item);
  const find = (input) => input?.instanceId
    ? items().find((item) => item.input.instanceId === input.instanceId)
    : currents.get(getWindow()?.id);
  const send = (value) => {
    const item = find(value);
    if (item && value.status) item.lastStatus = value.status;
    const win = item?.ownerWindow ?? getWindow();
    if (win && !win.isDestroyed())
      win.webContents.send("jugglework:docs:state", value);
  };
  const ownerFor = event => getWindows().find(win => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  const trusted = (event, input) => {
    const owner = ownerFor(event);
    const item = input?.instanceId ? find(input) : null;
    return !!owner && (input?.instanceId || owner === getWindow()) && (!item || item.ownerWindow === owner);
  };

  /** 从受限原生页的实际路由取得当前文档，不能让 Renderer 覆盖当前可写目标。 */
  function documentFor(instanceId, ownerWindow) {
    const item = find({ instanceId });
    if (!item?.ready || item.denied || (ownerWindow && item.ownerWindow !== ownerWindow)) return null;
    try {
      const url = new URL(item.view.webContents.getURL());
      const path = /^\/workspace\/([\w-]+)\/([\w-]+)\/?$/.exec(url.pathname);
      if (url.origin !== item.origin || !path || ['all','trash','settings','collection','tag','journal','journals','favorites','recent'].includes(path[2])) return null;
      return { tenantId: item.input.tenantId, workspaceId: path[1], docId: path[2], title: String(item.view.webContents.getTitle?.() || '').slice(0, 200) };
    } catch { return null; }
  }

  /** 原生页内部导航也更新宿主定位，避免 AI 继续把初始标签当成当前文档。 */
  function publishDocument(item) {
    if (!active(item) || !item.ready || item.denied) return;
    const document = documentFor(item.input.instanceId);
    if (document) onDocumentChanged?.(item.ownerWindow, item.input.instanceId, document);
    send({ instanceId: item.input.instanceId, status: 'ready', workspaceId: document?.workspaceId, docId: document?.docId ?? null, title: document?.title });
  }

  /** 释放指定实例；不带实例时清理全部前后台页面及其未完成请求。 */
  function close(instanceId) {
    if (!instanceId) {
      for (const item of items()) close(item.input.instanceId);
      return;
    }
    const old = find({ instanceId });
    if (!old) return;
    if (currents.get(old.ownerWindow.id) === old) currents.delete(old.ownerWindow.id);
    backgrounds.delete(instanceId);
    retained.delete(instanceId);
    for (const [id, task] of intakes) {
      if (task.item !== old) continue;
      clearTimeout(task.timer);
      task.reject(new Error("docs_view_closed"));
      intakes.delete(id);
    }
    const win = old.ownerWindow;
    if (!old.input.background && win && !win.isDestroyed()) win.contentView.removeChildView(old.view);
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close();
  }

  /** 仅等待原生本地存储确认；超时不销毁含未确认更新的视图。 */
  function prepareClose(instanceId) {
    const item = find({ instanceId });
    if (!item || !item.hasBeenReady || item.view.webContents.isDestroyed()) return Promise.resolve(true);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { intakes.delete(requestId); resolve(false); }, 5000);
      intakes.set(requestId, { item, timer, resolve: result => resolve(result?.persisted === true), reject: () => resolve(false) });
      item.view.webContents.send('jugglework:docs:prepare-close', { instanceId, requestId });
    });
  }

  /** 退出或更新前统一等待原生本地保存，任一页面未确认就取消退出。 */
  async function prepareQuit(ownerWindow) {
    const targets = items().filter(item => !ownerWindow || item.ownerWindow === ownerWindow);
    return (await Promise.all(targets.map(item => prepareClose(item.input.instanceId)))).every(Boolean);
  }

  /** 主窗口销毁只释放自己的视图，独立 File Browser 仍保持打开。 */
  function closeWindow(ownerWindow) {
    for (const item of items()) if (item.ownerWindow === ownerWindow) close(item.input.instanceId);
  }

  /** 关闭与明确来源账号和组织匹配的可见产品页，不影响同账号其他组织。 */
  async function closeScope(scope) {
    for (const item of items()) {
      if (item.input.sourceServerOrigin === scope?.sourceServerOrigin &&
        item.input.sourceUserId === scope?.sourceUserId && item.input.tenantId === scope?.tenantId)
        { item.view.setVisible(false); if (await prepareClose(item.input.instanceId)) close(item.input.instanceId); }
    }
  }

  /** 失权仅隐藏相同绑定，原生本地落盘确认后再释放，不清任何共享 Cookie 或数据库。 */
  function revoke(item) {
    const key = `${item.target.partition}\0${item.contextId || item.input.instanceId}`;
    if (revocations.has(key)) return revocations.get(key);
    const targets = items().filter(target => target === item || (item.contextId && target.contextId === item.contextId && target.target.partition === item.target.partition));
    for (const target of targets) { target.denied = true; target.ready = false; target.view.setVisible(false); }
    const task = (async () => {
      if (item.contextId) await attachments?.clearContext?.({ sourceServerOrigin: item.input.sourceServerOrigin, sourceUserId: item.input.sourceUserId, tenantId: item.input.tenantId }, item.contextId);
      for (const target of targets) if (await prepareClose(target.input.instanceId)) close(target.input.instanceId);
    })().finally(() => revocations.delete(key));
    revocations.set(key, task);
    return task;
  }

  function bounds(input) {
    const item = find(input);
    if (!item || item.input.background) return;
    const win = item.ownerWindow;
    const current = currents.get(win.id);
    if (!win || win.isDestroyed()) return;
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
    item.view.setBounds({ x, y, width, height });
    const visible = input.visible === true && item.ready && !item.denied && width > 0 && height > 0;
    if (visible && current !== item) {
      if (current) {
        current.view.setVisible(false);
        if (!current.input.retain) {
          retained.set(current.input.instanceId, current);
          void prepareClose(current.input.instanceId).then(saved => { if (saved && currents.get(win.id) !== current) close(current.input.instanceId); });
        }
      }
      currents.set(win.id, item);
    }
    const wasVisible = item.view.getVisible();
    item.view.setVisible(visible);
    // TIPS: 隐藏授权或宿主菜单结束后恢复原生页面焦点，触发原生引擎的恢复并接收编辑输入。
    if (visible && !wasVisible) item.view.webContents.focus();
  }

  /** 用表单 POST 短时凭据打开目标原生页面；长期源令牌不会进入此模块。 */
  async function open(input, ownerWindow = getWindow()) {
    const win = ownerWindow;
    const current = currents.get(win?.id);
    const target = validateCloudDocsLaunch(input);
    // TIPS: 上传和 AI 的后台产品页不替换可见页面，结束时也只释放自己的实例。
    const previous = find({ instanceId: input.instanceId });
    if (previous) {
      previous.view.setVisible(false);
      if (!await prepareClose(input.instanceId)) throw new Error('docs_local_save_pending');
      close(input.instanceId);
    }
    if (input.background === true) { /* 后台页不改变当前可见实例。 */ }
    else if (!input.retain && current?.input.retain) { current.view.setVisible(false); currents.delete(win.id); }
    else if (!input.retain && current && current !== previous) {
      current.view.setVisible(false);
      if (await prepareClose(current.input.instanceId)) close(current.input.instanceId);
      else { retained.set(current.input.instanceId, current); currents.delete(win.id); }
    }
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
      ownerWindow: win,
      view,
      input,
      target,
      nativeSession,
      origin: target.origin,
      ready: false,
      denied: false,
    };
    if (input.background === true) backgrounds.set(input.instanceId, item);
    else {
      // TIPS: 保留型标签可能在后台完成首次加载；只有可见范围请求才激活，不能抢走用户后来选中的页面。
      if (input.retain === true) retained.set(input.instanceId, item);
      else currents.set(win.id, item);
      win.contentView.addChildView(view);
    }
    // 后台页面仍需有正常视口，供原生导入器和 Workspace 布局完成初始化。
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).protocol === "https:") void shell.openExternal(url);
      } catch {
        /* 非 URL 不执行。 */
      }
      return { action: "deny" };
    });
    view.webContents.on("did-navigate-in-page", () => publishDocument(item));
    view.webContents.on("page-title-updated", () => publishDocument(item));
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
      if (!active(item) || !isMainFrame || isInPlace) return;
      // TIPS: 当前实例一旦失权，只能由宿主重新创建；迟到导航不能把拒绝态降级成 loading。
      if (item.denied) { view.setVisible(false); return; }
      item.ready = false;
      view.setVisible(false);
      send({ instanceId: input.instanceId, status: "loading" });
    });
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (active(item) && isMainFrame && code !== -3)
          send({
            instanceId: input.instanceId,
            status: "error",
            message: "云文档暂时无法连接",
          });
      },
    );
    view.webContents.on("did-navigate", (_event, _url, responseCode) => {
      if (active(item) && [401, 403, 404].includes(responseCode)) {
        item.ready = false;
        item.denied = true;
        view.setVisible(false);
        send({ instanceId: input.instanceId, status: "unauthorized" });
      }
    });
    view.webContents.on("render-process-gone", () => {
      if (!active(item)) return;
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
      if (active(item)) {
        close(input.instanceId);
        throw new Error("云文档暂时无法连接");
      }
    }
    return { instanceId: input.instanceId };
  }

  /** 注册主宿主操作和远程页面的最小只读状态消息。 */
  function registerIpc(ipcMain) {
    ipcMain.on("jugglework:docs:layout-command", (event, input) => {
      const current = find(input);
      if (!trusted(event, input) || !current?.ready || current.denied ||
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
      const current = find(input);
      if (
        !trusted(event, input) ||
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
      if (!trusted(event, input) || ownerFor(event) !== getWindow()) throw new Error("Forbidden");
      return open(input, ownerFor(event));
    });
    ipcMain.handle("jugglework:docs:status", (event, instanceId) => {
      if (!trusted(event, { instanceId })) throw new Error("Forbidden");
      const item = find({ instanceId }); return { ready: !!item?.ready && !item.denied, status: item?.lastStatus ?? (item ? "loading" : "error"), ...(documentFor(instanceId) ?? { docId: null }) };
    });
    ipcMain.handle("jugglework:docs:snapshot", async (event, instanceId) => {
      if (!trusted(event, { instanceId })) throw new Error("Forbidden");
      const item = find({ instanceId });
      if (!item?.ready || item.denied || item.input.background || item.view.webContents.isDestroyed()) return null;
      return (await item.view.webContents.capturePage()).toDataURL();
    });
    ipcMain.handle("jugglework:docs:close", async (event, instanceId) => {
      if (!trusted(event, { instanceId }) || (!instanceId && ownerFor(event) !== getWindow())) throw new Error("Forbidden");
      // TIPS: 不带实例的整体关闭发生在切换账号、组织或退出登录时，附件缓存随当前范围清理。
      const scopes = !instanceId ? items().map((item) => item.input) : [];
      const targets = instanceId ? [find({ instanceId })].filter(Boolean) : items();
      if (!instanceId) for (const item of targets) item.view.setVisible(false);
      let closed = true;
      for (const item of targets) {
        const saved = await prepareClose(item.input.instanceId);
        if (saved) close(item.input.instanceId);
        else closed = false;
      }
      for (const scope of scopes) await attachments?.clearScope(scope).catch(() => undefined);
      return { closed };
    });
    ipcMain.handle("jugglework:docs:file-intake", (event, input) => {
      if (!trusted(event, input)) throw new Error("Forbidden");
      const item = find(input);
      const upload = input?.action === "upload";
      if (
        !item?.ready || item.denied ||
        item.input.presentation?.mode !== "product" ||
        (input?.instanceId
          ? input.instanceId !== item.input.instanceId
          : input?.tenantId !== item.input.tenantId) ||
        !["lookup", "upload"].includes(input?.action) ||
        !/^[a-f0-9-]{36}$/i.test(input?.requestId ?? "") ||
        typeof input?.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(input.checksum) ||
        (upload &&
          (typeof input?.fileName !== "string" ||
            typeof input?.mimeType !== "string" ||
            !(input?.fileData instanceof ArrayBuffer || ArrayBuffer.isView(input?.fileData)) ||
            input.fileData.byteLength <= 0 ||
            input.fileData.byteLength > 50 * 1024 * 1024))
      )
        throw new Error("docs_product_view_unavailable");
      const requestId = input.requestId;
      if (intakes.has(requestId)) throw new Error("file_intake_in_progress");
      return new Promise((resolve, reject) => {
        // TIPS: preview、页面同步、commit 与 status 各有独立超时；宿主必须晚于完整状态机，不能先误报失败。
        const timer = setTimeout(() => {
          intakes.delete(requestId);
          reject(new Error("file_intake_timeout"));
        }, upload ? 300000 : 40000);
        timer.unref?.();
        intakes.set(requestId, { resolve, reject, timer, item });
        item.view.webContents.send("jugglework:docs:file-intake-command", {
          instanceId: item.input.instanceId,
          requestId,
          action: input.action,
          payload: {
            checksum: input.checksum,
            ...(upload
              ? { fileName: input.fileName, mimeType: input.mimeType, fileData: input.fileData }
              : {}),
          },
        });
      });
    });
    ipcMain.handle("jugglework:docs:api", (event, input) => {
      if (!trusted(event, input)) throw new Error("Forbidden");
      const item = find(input);
      if (
        !item?.ready ||
        item.denied ||
        item.input.presentation?.mode !== "product" ||
        (input?.instanceId
          ? input.instanceId !== item.input.instanceId
          : input?.tenantId !== item.input.tenantId) ||
        !/^[a-f0-9-]{36}$/i.test(input?.requestId ?? "") ||
        !["search", "read", "edit", "create"].includes(input?.op) ||
        typeof input?.params !== "object" ||
        input.params === null ||
        JSON.stringify(input.params).length > 300 * 1024
      )
        throw new Error("docs_product_view_unavailable");
      const requestId = input.requestId;
      if (intakes.has(requestId)) throw new Error("file_intake_in_progress");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          intakes.delete(requestId);
          reject(new Error("docs_api_timeout"));
        }, 40000);
        timer.unref?.();
        intakes.set(requestId, { resolve, reject, timer, item });
        item.view.webContents.send("jugglework:docs:api-command", {
          instanceId: item.input.instanceId,
          requestId,
          api: { op: input.op, params: input.params },
        });
      });
    });
    ipcMain.on("jugglework:docs:highlight-blocks", (event, input) => {
      const item = find(input);
      if (
        !trusted(event, input) ||
        !item?.ready ||
        item.denied ||
        input?.instanceId !== item.input.instanceId ||
        typeof input?.docId !== "string" ||
        !Array.isArray(input?.blockIds) ||
        input.blockIds.length > 200 ||
        !input.blockIds.every((id) => typeof id === "string" && id.length <= 64)
      )
        return;
      item.view.webContents.send("jugglework:docs:highlight-blocks", {
        instanceId: item.input.instanceId,
        docId: input.docId,
        blockIds: input.blockIds,
      });
    });
    ipcMain.on("jugglework:docs:bounds", (event, input) => {
      if (trusted(event, input)) bounds(input);
    });
    ipcMain.on("jugglework:docs:message", (event, message) => {
      const item = find(message);
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
        const win = item.ownerWindow;
        if (win && !win.isDestroyed()) win.webContents.send("jugglework:docs:layout", {
          instanceId: item.input.instanceId,
          layout: {
            leftOpen: layout.leftOpen,
            rightOpen: layout.rightOpen,
            leftWidth: layout.leftWidth * item.view.webContents.getZoomFactor() / win.webContents.getZoomFactor(),
          },
        });
      } else if (
        message.type === "docs.open-attachment" ||
        message.type === "docs.ai-reference"
      ) {
        if (!item.ready || item.denied || message.tenantId !== item.input.tenantId || item.input.presentation?.mode !== "product") return;
        if (message.type === "docs.open-attachment") {
          void attachments
            ?.open({
              scope: {
                sourceServerOrigin: item.input.sourceServerOrigin,
                sourceUserId: item.input.sourceUserId,
                tenantId: item.input.tenantId,
              },
              nativeSession: item.nativeSession,
              contextId: item.contextId,
              origin: item.origin,
              workspaceId: message.workspaceId,
              docId: message.docId,
              blobId: message.blobId,
              name: message.name,
            })
            .catch((error) => send({ instanceId: item.input.instanceId, status: "error", message: `附件打开失败：${error.message}` }));
        } else {
          const win = item.ownerWindow;
          if (win && !win.isDestroyed()) {
            // TIPS: 原生文档持有键盘焦点；先交还宿主，引用标签插入后输入框才能接收输入。
            win.webContents.focus();
            win.webContents.send("jugglework:docs:ai-reference", {
              instanceId: item.input.instanceId,
              tenantId: item.input.tenantId,
              workspaceId: message.workspaceId,
              docId: message.docId,
              title: String(message.title ?? "").slice(0, 200),
              action: message.action === "ask" ? "ask" : "add",
              blockIds: Array.isArray(message.blockIds) ? message.blockIds.filter((id) => typeof id === "string").slice(0, 200) : [],
            });
          }
        }
      } else if (message.type === "docs.ready") {
        if (
          message.tenantId !== item.input.tenantId ||
          typeof message.workspaceId !== "string" ||
          !message.workspaceId
        )
          return;
        // TIPS: 被拒绝的当前页面不能靠迟到的就绪消息重新显示，需重新进入并完成授权。
        if (item.denied) return;
        item.contextId = message.contextId;
        item.ready = true;
        item.hasBeenReady = true;
        const document = documentFor(item.input.instanceId);
        if (document) onDocumentChanged?.(item.ownerWindow, item.input.instanceId, document);
        send({ instanceId: message.instanceId, status: "ready", workspaceId: message.workspaceId, docId: document?.docId ?? null, title: document?.title });
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
    ipcMain.on("jugglework:docs:file-intake", (event, message) => {
      const task = intakes.get(message?.requestId);
      if (
        !task ||
        !active(task.item) ||
        event.sender !== task.item.view.webContents ||
        event.senderFrame !== task.item.view.webContents.mainFrame ||
        message.instanceId !== task.item.input.instanceId
      )
        return;
      intakes.delete(message.requestId);
      clearTimeout(task.timer);
      if (message.ok === true && message.result)
        task.resolve(message.result);
      else
        task.reject(
          new Error(
            message.error || message.result?.message || "file_intake_failed",
          ),
        );
    });
  }
  return { registerIpc, open, close, closeWindow, closeScope, prepareClose, prepareQuit, documentFor, hasViews: ownerWindow => items().some(item => !ownerWindow || item.ownerWindow === ownerWindow), hide: instanceId => find({ instanceId })?.view.setVisible(false) };
}
