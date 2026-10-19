import { getOfficeDocumentKind } from "@jugglework/types/office";
import { WebContentsView, dialog, session } from "electron";
import { waitForOfficeTransfer } from "./office-transfer.mjs";
import { readOfficePageSelection } from "./office-page-selection.mjs";
import {
  waitForSheetPageCommit,
  waitForSlidePageCommit,
  waitForWordPageCommit,
  isSlidePageComposing,
  installSlideKeyboardGuard,
} from "./office-page-commit.mjs";

/**
 * 承载唯一存活的 Office 页面；隐藏或切换标签时保留模型和撤销记录。
 * @param {{ getWindow: () => Electron.BrowserWindow | null, getWindows?: () => Electron.BrowserWindow[], resolveWindow?: (sender: Electron.WebContents) => Electron.BrowserWindow | null, onDocumentClosed?: (id: string) => void, onOpenFile?: (window: Electron.BrowserWindow, input: { workspaceId: string, sessionId: string }) => Promise<void>, client: { getJson: (path: string, options?: { signal?: AbortSignal }) => Promise<any>, postJson: (path: string, body: unknown) => Promise<any> }, resources: ReturnType<import('./office-resources.mjs').createOfficeResources> | (() => ReturnType<import('./office-resources.mjs').createOfficeResources>), platform?: NodeJS.Platform, arch?: string }} options 宿主窗口、资源服务、已有 Server 客户端及平台能力
 */
export function createOfficePanel({
  getWindow,
  getWindows = () => [],
  resolveWindow,
  onDocumentClosed,
  onOpenFile,
  client,
  resources,
  platform = process.platform,
  arch = process.arch,
}) {
  const views = new Map();
  const assignedWindows = new Map();
  const visibleDocuments = new Map();
  const hosts = new Map();
  const getResources = () =>
    typeof resources === "function" ? resources() : resources;
  const requireTransferSupport = () => {
    // TIPS: 首次创建页面不等于跨窗口迁移；仅开放已验证平台，不能关闭重开来冒充状态保留。
    if (platform !== "darwin" || arch !== "arm64")
      throw new Error(
        "当前平台暂不支持跨窗口接续编辑，请先保存并关闭文档，再在目标窗口重新打开",
      );
  };
  const windows = () =>
    [...new Set([getWindow(), ...getWindows()])].filter(
      (window) => window && !window.isDestroyed(),
    );
  const publishLocation = (documentId) => {
    for (const window of windows())
      window.webContents.send("jugglework:office:location", {
        documentId,
        here: assignedWindows.get(documentId) === window.id,
      });
  };
  const base = (workspaceId, documentId) =>
    `/workspace/${encodeURIComponent(workspaceId)}/office/${encodeURIComponent(documentId)}`;
  const publishDocument = (document) => {
    for (const window of windows())
      window.webContents.send("jugglework:office:document", document);
  };
  const save = async (workspaceId, documentId) =>
    (await client.postJson(`${base(workspaceId, documentId)}/save`, {}))
      .document;
  const hide = (documentId, window) => {
    const entry = views.get(documentId);
    if (
      window &&
      (entry
        ? entry.window.id !== window.id
        : assignedWindows.get(documentId) !== window.id)
    )
      return;
    for (const [id, visible] of visibleDocuments)
      if (visible === documentId && (!window || window.id === id))
        visibleDocuments.delete(id);
    if (entry) {
      const host = hosts.get(entry.window.id);
      if (
        host?.focusedDocument === documentId &&
        (!window ||
          window.isDestroyed() ||
          (window.isVisible() && !window.isMinimized()))
      )
        host.focusedDocument = null;
      entry.view.setVisible(false);
      // TIPS: SDK 页面隐藏后仍可能请求输入焦点；临时卸下存活 view，避免菜单点击被原生层截走。
      if (entry.attached && !entry.window.isDestroyed())
        entry.window.contentView.removeChildView(entry.view);
      entry.attached = false;
    }
  };
  /** 宿主布局随页面生命周期失效；只卸下原生视图，不关闭文档模型。 */
  const observeHost = (window) => {
    const existing = hosts.get(window.id);
    if (existing) return existing;
    const host = {
      revision: 0,
      active: window.isFocused(),
      focusedDocument: null,
      focusRevision: 0,
      dispose: () => {},
    };
    const suspend = (preserveFocus = false) => {
      const focusedDocument = preserveFocus ? host.focusedDocument : null;
      host.revision++;
      visibleDocuments.delete(window.id);
      for (const [id, entry] of views)
        if (entry.window.id === window.id) hide(id, window);
      host.focusedDocument = focusedDocument;
    };
    const navigate = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) suspend();
    };
    const requestLayout = () => {
      // TIPS: 聚焦只要求重新测量；卸下有效视图会丢失原输入焦点。隐藏及导航由各自事件卸载。
      host.revision++;
      if (!window.isDestroyed())
        window.webContents.send("jugglework:office:layout-invalidated");
    };
    const focus = () => {
      host.active = true;
      requestLayout();
    };
    const suspendWindow = () => {
      host.active = false;
      suspend(true);
    };
    const releaseFocus = () => {
      host.focusedDocument = null;
      // TIPS: 用户已开始操作宿主页，之前仍在等待 Server 的显式激活也必须放弃抢焦点。
      host.focusRevision++;
    };
    const hostInput = (_event, input) => {
      if (input.type === "mouseDown" || input.type === "keyDown")
        releaseFocus();
    };
    const closed = () => {
      suspend();
      host.dispose();
    };
    const events = [
      [window.webContents, "did-start-navigation", navigate],
      [window.webContents, "render-process-gone", () => suspend()],
      // TIPS: 失活窗口切回时，Electron 可能先聚焦宿主页再发窗口 focus；这不是用户切换输入目标。
      [
        window.webContents,
        "focus",
        () => {
          if (host.active) releaseFocus();
        },
      ],
      [window.webContents, "before-input-event", hostInput],
      [window.webContents, "before-mouse-event", hostInput],
      [
        window,
        "blur",
        () => {
          host.active = false;
        },
      ],
      [window, "hide", suspendWindow],
      [window, "minimize", suspendWindow],
      [window, "show", requestLayout],
      [window, "restore", requestLayout],
      [window, "focus", focus],
      [window, "closed", closed],
    ];
    for (const [source, event, listener] of events) source.on(event, listener);
    host.dispose = () => {
      for (const [source, event, listener] of events)
        source.removeListener(event, listener);
      hosts.delete(window.id);
    };
    hosts.set(window.id, host);
    return host;
  };
  const destroy = (documentId) => {
    hide(documentId);
    assignedWindows.delete(documentId);
    const entry = views.get(documentId);
    if (!entry) return;
    // TIPS: 先废弃身份再关闭页面，避免关闭事件或旧加载结果影响恢复后的新 view。
    views.delete(documentId);
    if (entry.attached && !entry.window.isDestroyed())
      entry.window.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    entry.disposeProtocol();
  };
  const bounds = (entry, value) => {
    const zoom = entry.window.webContents.getZoomFactor();
    entry.view.setBounds({
      x: Math.round(value.x * zoom),
      y: Math.round(value.y * zoom),
      width: Math.max(1, Math.round(value.width * zoom)),
      height: Math.max(1, Math.round(value.height * zoom)),
    });
  };
  const assign = (documentId, window) => {
    if (!window || window.isDestroyed()) throw new Error("目标文件窗口已关闭");
    observeHost(window);
    const entry = views.get(documentId);
    if (entry && entry.window.id !== window.id) {
      requireTransferSupport();
      const previous = entry.window;
      const attached = entry.attached;
      const visible = entry.view.getVisible();
      // TIPS: 重挂成功才提交宿主归属；失败仍保留原页面和模型，不能用关闭重开补救。
      try {
        entry.view.setVisible(false);
        if (attached && !previous.isDestroyed()) {
          previous.contentView.removeChildView(entry.view);
          entry.attached = false;
        }
        window.contentView.addChildView(entry.view);
      } catch (error) {
        if (!previous.isDestroyed()) {
          if (attached && !entry.attached) {
            previous.contentView.addChildView(entry.view);
            entry.attached = true;
          }
          entry.view.setVisible(visible);
        }
        throw error;
      }
      if (visibleDocuments.get(previous.id) === documentId)
        visibleDocuments.delete(previous.id);
      const previousHost = hosts.get(previous.id);
      if (previousHost?.focusedDocument === documentId)
        previousHost.focusedDocument = null;
      entry.window = window;
      entry.attached = true;
    }
    assignedWindows.set(documentId, window.id);
    publishLocation(documentId);
  };
  const transfer = async (documentId, window, isCurrent = () => true) => {
    if (!window || window.isDestroyed()) return false;
    const entry = views.get(documentId);
    if (entry && entry.window.id !== window.id) {
      requireTransferSupport();
      if (entry.window.isDestroyed()) return false;
      const controller = new AbortController();
      const stop = () => controller.abort();
      const source = entry.window;
      source.once("closed", stop);
      window.once("closed", stop);
      try {
        const ready = await waitForOfficeTransfer({
          documentId,
          signal: controller.signal,
          readStatus: (signal) =>
            client.getJson(
              `${base(entry.workspaceId, documentId)}/transfer-status`,
              { signal },
            ),
          showWait: (signal) =>
            dialog.showMessageBox(source, {
              type: "info",
              title: "等待文档任务完成",
              message: "文档任务或保存尚未完成，正在等待…",
              detail:
                "完成后会在目标窗口继续编辑。取消等待会保留原窗口的内容和编辑状态。",
              buttons: ["取消等待"],
              cancelId: 0,
              defaultId: 0,
              noLink: true,
              signal,
            }),
        });
        if (!ready || views.get(documentId) !== entry) return false;
      } finally {
        source.removeListener("closed", stop);
        window.removeListener("closed", stop);
      }
    }
    if (!isCurrent()) return false;
    assign(documentId, window);
    return true;
  };
  const show = async (
    { workspaceId, documentId, bounds: rectangle, activate = false },
    window = getWindow(),
  ) => {
    if (!window || window.isDestroyed()) return;
    const host = observeHost(window);
    const revision = host.revision;
    const focusRevision = host.focusRevision;
    // TIPS: 刷新/隐藏使旧布局失效；异步查询返回后也不能把旧视图重新挂回聊天界面。
    const isCurrent = () =>
      host.revision === revision &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized();
    /** 仅恢复所属可见页面的原焦点；用户已经转向聊天或请求过期时不接管输入。 */
    const restoreFocus = (entry) => {
      if (
        isCurrent() &&
        views.get(documentId) === entry &&
        visibleDocuments.get(window.id) === documentId &&
        assignedWindows.get(documentId) === window.id &&
        window.isFocused() &&
        ((activate && host.focusRevision === focusRevision) ||
          host.focusedDocument === documentId)
      )
        entry.view.webContents.focus();
    };
    if (!isCurrent()) return;
    const wasVisible = visibleDocuments.get(window.id) === documentId;
    // TIPS: 只在用户激活内容区时交接编辑页面；后台尺寸更新不能抢走另一窗口的输入焦点。
    if (activate && assignedWindows.get(documentId) !== window.id) {
      const transferred = await transfer(documentId, window, isCurrent);
      if (!isCurrent()) return;
      if (!transferred) return { here: false };
    }
    if (
      assignedWindows.has(documentId) &&
      assignedWindows.get(documentId) !== window.id
    )
      return { here: false };
    assignedWindows.set(documentId, window.id);
    visibleDocuments.set(window.id, documentId);
    for (const [id, entry] of views)
      if (id !== documentId && entry.window.id === window.id) hide(id, window);
    let entry = views.get(documentId);
    if (!entry) {
      const document = (await client.getJson(base(workspaceId, documentId)))
        .document;
      if (
        !document?.previewUrl ||
        !["opening", "ready", "saving"].includes(document.state)
      )
        throw new Error(document?.error ?? "文档不可用");
      const preview = new URL(document.previewUrl);
      if (
        preview.protocol !== "http:" ||
        preview.hostname !== "127.0.0.1" ||
        preview.pathname !==
          `/static/${getOfficeDocumentKind(document.relativePath)}/pc.html`
      )
        throw new Error("Office 页面地址无效");
      // TIPS: 查询期间可能切换标签或关闭面板，过期请求不能重新显示页面。
      if (
        visibleDocuments.get(window.id) !== documentId ||
        assignedWindows.get(documentId) !== window.id ||
        !isCurrent()
      )
        return;
      entry = views.get(documentId);
      if (entry) {
        if (!entry.attached) {
          window.contentView.addChildView(entry.view);
          entry.attached = true;
        }
        bounds(entry, rectangle);
        entry.view.setVisible(true);
        restoreFocus(entry);
        return { here: true };
      }
      const partition = session.fromPartition(`office-${documentId}`);
      const kind = getOfficeDocumentKind(document.relativePath);
      const commit = { error: null };
      const resourceService = getResources();
      const resourceHost = {
        documentId,
        origin: preview.origin,
        filePath: preview.searchParams.get("localFilePath"),
        kind,
        commit,
        save: () => save(workspaceId, documentId),
        onCoreFailure: () => failPage(),
      };
      const resourceSession = resourceService.attach(partition, resourceHost);
      const preventDownload = (event) => {
        event.preventDefault();
      };
      partition.on("will-download", preventDownload);
      let view;
      try {
        view = new WebContentsView({
          webPreferences: {
            session: partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
      } catch (error) {
        resourceSession.dispose();
        partition.removeListener("will-download", preventDownload);
        throw error;
      }
      entry = {
        view,
        window,
        workspaceId,
        pageId: document.pageId,
        kind,
        commit,
        resourceSession,
        attached: true,
        disposeProtocol() {
          resourceSession.dispose();
          partition.removeListener("will-download", preventDownload);
        },
      };
      // TIPS: 先登记存活页面再加载，重复 show 不会并发建立第二份文档模型。
      views.set(documentId, entry);
      window.contentView.addChildView(view);
      view.webContents.on("focus", () => {
        const currentHost = hosts.get(entry.window.id);
        if (
          currentHost &&
          views.get(documentId) === entry &&
          entry.attached &&
          visibleDocuments.get(entry.window.id) === documentId
        )
          currentHost.focusedDocument = documentId;
      });
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", (event, target) => {
        if (target !== document.previewUrl) event.preventDefault();
      });
      view.webContents.on("before-input-event", async (event, input) => {
        if (!(input.control || input.meta) || input.type !== "keyDown") return;
        const key = input.key.toLowerCase();
        if (["s", "w", "o"].includes(key)) event.preventDefault();
        // TIPS: 组合期间只阻止文档快捷键，不执行宿主动作；直接放行会触发 SDK 自身保存。
        if (input.isComposing) return;
        if (kind === "slide" && ["s", "w", "o"].includes(key)) {
          try {
            const composing = await view.webContents.executeJavaScript(
              `(${isSlidePageComposing.toString()})()`,
            );
            if (composing !== false || views.get(documentId) !== entry) return;
          } catch {
            return;
          }
        }
        if (key === "s" && !input.shift)
          void save(workspaceId, documentId).catch((error) =>
            dialog.showErrorBox("文档保存失败", error.message),
          );
        if (key === "w")
          void close(workspaceId, documentId).catch((error) =>
            dialog.showErrorBox("文档关闭失败", error.message),
          );
        if (key === "o" && !input.shift)
          void onOpenFile?.(entry.window, {
            workspaceId,
            sessionId: document.ownerSessionId,
          }).catch((error) =>
            dialog.showErrorBox("文件打开失败", error.message),
          );
      });
      const failPage = () => {
        if (views.get(documentId) !== entry) return;
        destroy(documentId);
        // TIPS: 页面与原生进程分别存活；页面故障也必须由 Server 停写，不能仅隐藏空白视图。
        void client
          .postJson(`${base(workspaceId, documentId)}/page-failed`, {})
          .then(({ document }) => publishDocument(document))
          .catch((error) =>
            dialog.showErrorBox("文档故障状态同步失败", error.message),
          );
      };
      view.webContents.on("render-process-gone", failPage);
      if (kind === "slide")
        view.webContents.on("dom-ready", () => {
          void view.webContents
            .executeJavaScript(`(${installSlideKeyboardGuard.toString()})()`)
            .catch(failPage);
        });
      void view.webContents.loadURL(document.previewUrl).catch(failPage);
    }
    if (
      !isCurrent() ||
      !views.has(documentId) ||
      visibleDocuments.get(window.id) !== documentId ||
      assignedWindows.get(documentId) !== window.id
    )
      return;
    if (!entry.attached) {
      window.contentView.addChildView(entry.view);
      entry.attached = true;
    }
    bounds(entry, rectangle);
    entry.view.setVisible(true);
    if (!wasVisible || activate)
      await client.postJson(`${base(workspaceId, documentId)}/context`, {
        pageId: entry.pageId,
        activate: true,
      });
    if (!isCurrent()) return;
    restoreFocus(entry);
    return { here: true };
  };
  const close = async (workspaceId, documentId) => {
    const document = (await client.getJson(base(workspaceId, documentId)))
      .document;
    let decision = "save";
    if (
      document.dirty ||
      document.state === "opening" ||
      document.state === "error"
    ) {
      const options = {
        type: /** @type {const} */ ("question"),
        title: "关闭文档",
        message: `是否保存“${document.name}”的修改？`,
        buttons: ["保存并关闭", "放弃修改", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const window = views.get(documentId)?.window ?? getWindow();
      const result = await (window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options));
      if (result.response === 2) return false;
      decision = result.response === 0 ? "save" : "discard";
    }
    try {
      await client.postJson(`${base(workspaceId, documentId)}/close`, {
        decision,
      });
    } catch (error) {
      // A running agent may still use the model. Keep its view and tab intact,
      // but surface the server's actionable 409 instead of a generic IPC error.
      if (error?.status === 409 && error?.serverCode === "office_run_active")
        throw new Error("请等待文档相关任务结束及交付完成后重试");
      throw error;
    }
    destroy(documentId);
    for (const window of windows())
      window.webContents.send("jugglework:office:closed", {
        documentId,
        workspaceId,
        path: document.relativePath,
        sessionId: document.ownerSessionId,
      });
    // TIPS: 退出或重启中途取消时，已经关闭的模型也必须同步移除标签。
    onDocumentClosed?.(documentId);
    return true;
  };
  return {
    /** 原生页面已绑定身份，渲染层只报告显示区域。 */
    registerIpc(ipcMain) {
      const owner = (event) => {
        const window =
          resolveWindow?.(event.sender) ??
          (event.sender.id === getWindow()?.webContents.id
            ? getWindow()
            : null);
        if (!window) throw new Error("Office view requires its host window");
        return window;
      };
      ipcMain.handle("jugglework:office:show", async (event, input) => {
        return show(input, owner(event));
      });
      ipcMain.handle(
        "jugglework:office:resources",
        async (event, input = {}) => {
          owner(event);
          const service = getResources();
          if (!input.documentId || !views.has(input.documentId)) return null;
          return service.state(input.documentId);
        },
      );
      ipcMain.handle("jugglework:office:font-retry", async (event, id) => {
        owner(event);
        const entry = views.get(id);
        await entry?.resourceSession?.retry();
      });
      ipcMain.handle("jugglework:office:recover", async (event, input) => {
        const window = owner(event);
        const document = (
          await client.getJson(base(input.workspaceId, input.documentId))
        ).document;
        if (document.state !== "error") throw new Error("文档无需故障恢复");
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          title: "重新打开已保存版本",
          message: `重新打开“${document.name}”的已保存版本？`,
          detail: "未保存的修改和撤销记录将丢失。取消后保留当前状态。",
          buttons: ["重新打开已保存版本", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (result.response !== 0) return null;
        const recovered = (
          await client.postJson(
            `${base(input.workspaceId, input.documentId)}/recover`,
            {},
          )
        ).document;
        destroy(input.documentId);
        assignedWindows.set(input.documentId, window.id);
        publishLocation(input.documentId);
        publishDocument(recovered);
        return recovered;
      });
      ipcMain.handle("jugglework:office:snapshot", async (event, id) => {
        owner(event);
        const entry = views.get(id);
        if (!entry || entry.view.webContents.isDestroyed()) return null;
        return (await entry.view.webContents.capturePage()).toDataURL();
      });
      ipcMain.handle(
        "jugglework:office:hide",
        async (event, id, snapshot = false) => {
          const window = owner(event);
          const entry = views.get(id);
          if (
            snapshot &&
            entry?.window.id === window.id &&
            visibleDocuments.get(window.id) === id
          )
            visibleDocuments.delete(window.id);
          const image =
            snapshot &&
            entry?.window.id === window.id &&
            !entry.view.webContents.isDestroyed()
              ? await entry.view.webContents.capturePage().catch(() => null)
              : null;
          if (!snapshot || visibleDocuments.get(window.id) !== id) {
            hide(id, window);
            if (snapshot) window.webContents.focus();
          }
          return image?.toDataURL();
        },
      );
      ipcMain.handle("jugglework:office:close", async (event, input) => {
        const window = owner(event);
        const host = views.get(input.documentId)?.window;
        if (host && host.id !== window.id) {
          host.show();
          host.focus();
          return false;
        }
        return close(input.workspaceId, input.documentId);
      });
      ipcMain.handle("jugglework:office:destroy", (event, id) => {
        owner(event);
        destroy(id);
      });
    },
    /** 查询所属文档的可见存活页面；不使用全局窗口焦点，也不沿用后台页面选区。 */
    async readSelection({ workspaceId, documentId, pageId }) {
      const entry = views.get(documentId);
      const current = () =>
        entry &&
        views.get(documentId) === entry &&
        entry.workspaceId === workspaceId &&
        entry.pageId === pageId &&
        !entry.view.webContents.isDestroyed() &&
        entry.attached &&
        visibleDocuments.get(entry.window.id) === documentId &&
        entry.view.getVisible();
      if (!current()) return null;
      const selection = await entry.view.webContents.executeJavaScript(
        `(${readOfficePageSelection.toString()})(${JSON.stringify(entry.kind)})`,
      );
      return current() ? selection : null;
    },
    /** 保存前等待调用文档的真实页面提交完成，旧页面不能确认恢复后的新模型。 */
    async prepareSave({ workspaceId, documentId, pageId }) {
      const entry = views.get(documentId);
      if (
        !entry ||
        entry.workspaceId !== workspaceId ||
        entry.pageId !== pageId ||
        entry.view.webContents.isDestroyed()
      )
        throw new Error("文档编辑页面已失效，不能确认保存");
      const prepare =
        entry.kind === "doc"
          ? waitForWordPageCommit
          : entry.kind === "sheet"
            ? waitForSheetPageCommit
            : entry.kind === "slide"
              ? waitForSlidePageCommit
              : null;
      if (!prepare) throw new Error("此文档格式没有页面提交适配");
      await entry.view.webContents.executeJavaScript(
        `(${prepare.toString()})()`,
      );
      if (
        views.get(documentId) !== entry ||
        entry.view.webContents.isDestroyed()
      )
        throw new Error("文档编辑页面已失效，不能确认保存");
      if (entry.commit.error) throw entry.commit.error;
    },
    /** 将同一个存活页面重挂到新宿主，不保存关闭、不重新导入模型。 */
    assign,
    /** 等待所属运行、交付与保存结束再交接；取消时保持原页面和模型。 */
    transfer,
    /** 由独立窗口管理器关闭已确认属于该窗口的模型。 */
    close,
    /** 只关闭指定窗口拥有的文档；任一取消或失败都保持窗口存活。 */
    async closeWindow(window) {
      for (const [id, windowId] of [...assignedWindows]) {
        if (windowId !== window.id) continue;
        const entry = views.get(id);
        if (entry && !(await close(entry.workspaceId, id))) return false;
        if (!entry) assignedWindows.delete(id);
      }
      return true;
    },
    /** 应用退出前处理所有文档，取消或保存失败时保持运行。 */
    async prepareQuit() {
      const { items } = await client
        .getJson("/office/documents")
        .catch((error) => {
          if (views.size) throw error;
          return { items: [] };
        });
      for (const document of items)
        if (!(await close(document.workspaceId, document.documentId)))
          return false;
      return true;
    },
    /** 主窗口实际销毁前需要先处理仍存活的文档。 */
    hasViews() {
      return views.size > 0;
    },
    /** Runtime 已完成关闭后释放所有视图。 */
    destroy() {
      for (const id of [...views.keys()]) destroy(id);
      for (const host of [...hosts.values()]) host.dispose();
    },
  };
}
