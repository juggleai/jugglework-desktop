import { getOfficeDocumentKind } from "@jugglework/types/office";
import { BrowserWindow, dialog, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveArtifactFileCopy, resolveArtifactExternalSource } from "./artifact-file-operations.mjs";
import { fetchFileWindowResponse } from "./file-window-fetch.mjs";
import { fileWindowSessionEvent, validateFileWindowConversationOptions } from "./file-window-conversation.mjs";
import { createManagedRuntimeSseClient } from "./managed-runtime-sse-client.mjs";
import { randomUUID } from "node:crypto";
import { desktopConfigSchema } from "@jugglework/types/den/desktop-policies";
import { isDeepStrictEqual } from "node:util";

/** 将用户选择限定在当前工作区，保持真实文件路径大小写。 */
export function workspaceFilePath(root, absolute) {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("请选择当前工作区中的文件");
  return relative.split(path.sep).join("/");
}

/**
 * 独立文件窗口管理器；聊天及本机明确文件集合各自复用多标签窗口，共用 Server 和 Office 页面。
 * @param {object} options 运行时客户端、原生 Office 宿主及应用资源位置
 */
export function createFileWindows({
  client,
  getAccess,
  office,
  getMainWindow,
  loadWindow,
  preloadPath,
  iconPath,
  recentPath,
  dock,
  fileEditor,
  registerLocalFile,
  getDesktopConfig,
  getAppearance = async () => ({ lang: "en", theme: "light" }),
  openSession,
  fetcher = fetch,
}) {
  const entries = new Map();
  const pendingStops = new Map();
  // 与既有 composer 请求/确认模式一致，目标只取 Main 登记；不开放 file renderer 停止 IPC。
  const prepareSessionStop = (entry, signal) => {
    const main = getMainWindow();
    // TIPS: 文件模式可独立启动；主窗口不存在时也不存在其内存队列，可直接停止真实运行。
    if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return Promise.resolve();
    const sender = main.webContents;
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const finish = (ok) => {
        pendingStops.delete(requestId);
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        sender.removeListener("destroyed", cancel);
        if (ok) resolve(undefined); else reject(new Error("主窗口未确认停止，请重试"));
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 5000);
      pendingStops.set(requestId, { sender, finish });
      signal.addEventListener("abort", cancel, { once: true });
      sender.once("destroyed", cancel);
      if (signal.aborted) { cancel(); return; }
      sender.send("jugglework:file-window:session-stop-request", { requestId, workspaceId: entry.workspaceId, sessionId: entry.sessionId });
    });
  };
  let recent = [];
  const loaded = readFile(recentPath, "utf8")
    .then((text) => {
      const value = JSON.parse(text);
      if (Array.isArray(value))
        recent = value
          .filter(
            (item) =>
              typeof item.workspaceId === "string" &&
              typeof item.path === "string" &&
              typeof item.name === "string",
          )
          .slice(0, 30);
    })
    .catch(() => {});
  const base = (entry) =>
    `/workspace/${encodeURIComponent(entry.workspaceId)}/office`;
  const updateDock = () =>
    dock?.update(
      [...entries.values()]
        .filter((entry) => !entry.window.isDestroyed())
        .map((entry) => ({
          id: entry.window.id,
          title:
            entry.tabs.find((tab) => tab.path === entry.activePath)?.name ??
            "JuggleWork 文件浏览器",
        })),
    );
  const state = (entry) => ({
    workspaceId: entry.workspaceId,
    sessionId: entry.sessionId,
    workspaceRoot: entry.workspaceRoot,
    local: entry.local,
    tabs: entry.tabs,
    activePath: entry.activePath,
    recent: recent
      .filter(
        (item) =>
          item.workspaceId === (entry.local ? "local" : entry.workspaceId),
      )
      .map(({ path, name }) => ({ path, name })),
    platform: process.platform,
    ...(entry.conversation ? { conversation: entry.conversation } : {}),
  });
  const cancelEntry = (entry) => {
    entry.verifiedDescendants = new Set();
    for (const controller of entry.requests) controller.abort();
    entry.requests.clear();
    for (const controller of entry.subscriptions.values()) controller.abort();
    entry.subscriptions.clear();
  };
  const refreshConversation = async (entry) => {
    if (!entry.workspaceRoot || !entry.sessionId || entry.sessionId === "file-browser" || entry.workspaceId.startsWith("rem_") || !getDesktopConfig) return;
    const previous = entry.conversation;
    const controller = new AbortController();
    entry.requests.add(controller);
    try {
      const [{ item }, desktopConfig] = await Promise.all([
        client.getJson(`/workspace/${encodeURIComponent(entry.workspaceId)}/sessions/${encodeURIComponent(entry.sessionId)}`, { signal: controller.signal }),
        getDesktopConfig(),
      ]);
      if (entry.window.isDestroyed() || controller.signal.aborted) throw new Error("文件窗口已关闭");
      const policy = desktopConfigSchema.safeParse(desktopConfig);
      entry.conversation = item?.id === entry.sessionId && policy.success ? { ...entry.conversationOptions, desktopConfig: policy.data } : undefined;
    } catch { entry.conversation = undefined; }
    finally { entry.requests.delete(controller); }
    if (!entry.conversation) cancelEntry(entry);
    // Changed listeners may request state again. Publish transitions only, not every policy read.
    if (!isDeepStrictEqual(previous, entry.conversation)) publish(entry);
  };
  const publish = (entry) => {
    if (!entry.window.isDestroyed()) {
      entry.window.setTitle("JuggleWork 文件浏览器");
      entry.window.webContents.send(
        "jugglework:file-window:changed",
        state(entry),
      );
      updateDock();
    }
  };
  const remember = async (entry, tab) => {
    recent = [
      {
        workspaceId: entry.local ? "local" : entry.workspaceId,
        path: entry.local ? tab.absolutePath ?? path.join(entry.workspaceRoot, tab.path) : tab.path,
        name: tab.name,
      },
      ...recent.filter(
        (item) =>
          item.workspaceId !== (entry.local ? "local" : entry.workspaceId) ||
          item.path !== (entry.local ? tab.absolutePath ?? path.join(entry.workspaceRoot, tab.path) : tab.path),
      ),
    ].slice(0, 30);
    await writeFile(recentPath, JSON.stringify(recent)).catch(() => {});
  };
  const entryFor = (sender) =>
    [...entries.values()].find(
      (entry) =>
        !entry.window.isDestroyed() &&
        entry.window.webContents === sender &&
        !sender.isDestroyed(),
    );
  const assertTopLevel = (event) => {
    if (
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      event.sender.isDestroyed()
    )
      throw new Error("文件窗口宿主不可用");
  };
  const resolve = (event) => {
    assertTopLevel(event);
    const entry = entryFor(event.sender);
    if (!entry) throw new Error("文件窗口已关闭");
    return entry;
  };
  const resolveHost = (event) => {
    assertTopLevel(event);
    const main = getMainWindow();
    const window = entryFor(event.sender)?.window ??
      (main && !main.isDestroyed() && event.sender === main.webContents ? main : null);
    if (!window) throw new Error("文件窗口宿主不可用");
    return window;
  };
  const assertEntryContext = (entry, input) => {
    if (
      entry &&
      (input?.workspaceId !== entry.workspaceId ||
        input?.sessionId !== entry.sessionId)
    )
      throw new Error("文件窗口工作区或聊天不匹配");
  };
  const addFile = async (entry, relativePath, absolutePath) => {
    if ((!entry.local || entry.conversation) && office.confirmFileTarget && !await office.confirmFileTarget(entry.window, {
      workspaceId: entry.workspaceId, sessionId: entry.sessionId, path: relativePath,
    })) return null;
    const response = await client.getJson(
      `/workspace/${encodeURIComponent(entry.workspaceId)}/files/stat?path=${encodeURIComponent(relativePath)}`,
    );
    if (!response.exists || response.kind !== "file")
      throw new Error("文件不存在");
    // TIPS: Main 加入已有文件窗口时只携带稳定标识；每个标签仍须从同一登记取得原件，不能依赖首次开窗参数。
    absolutePath ??= await resolveArtifactExternalSource(client, entry.workspaceRoot, relativePath);
    if (absolutePath) entry.local = true;
    let tab = entry.tabs.find((tab) => tab.path === relativePath);
    if (!tab) {
      tab = {
        path: relativePath,
        name: path.basename(relativePath),
        ...(absolutePath ? { absolutePath } : {}),
      };
      if (getOfficeDocumentKind(relativePath)) {
        const { available } = await client.getJson(
          `${base(entry)}/capabilities`,
        );
        if (available) {
          try {
            const { document } = await client.postJson(`${base(entry)}/open`, {
              sessionId: entry.sessionId,
              path: relativePath,
            });
            if (document.state === "error")
              throw new Error(document.error ?? "文档打开失败");
            tab.documentId = document.documentId;
            if (!(await office.transfer(document.documentId, entry.window)))
              return null;
          } catch (error) {
            if (error?.serverCode !== "office_readonly_required") throw error;
            tab.readOnly = true;
          }
        }
      }
      entry.tabs.push(tab);
    } else if (
      tab.documentId &&
      !(await office.transfer(tab.documentId, entry.window))
    )
      return null;
    entry.activePath = tab.path;
    await remember(entry, tab);
    publish(entry);
    return tab;
  };
  const closeTab = async (entry, relativePath) => {
    const tab = entry.tabs.find((tab) => tab.path === relativePath);
    if (!tab) return true;
    if (
      !tab.documentId &&
      fileEditor &&
      !(await fileEditor.close(
        { workspaceId: entry.workspaceId, path: tab.path },
        entry.window,
      ))
    )
      return false;
    if (
      tab.documentId &&
      !(await office.close(entry.workspaceId, tab.documentId))
    )
      return false;
    // TIPS: 按路径移除；其余标签与原生页面保持存活。
    entry.tabs = entry.tabs.filter((item) => item.path !== relativePath);
    if (entry.activePath === relativePath)
      entry.activePath = entry.tabs.at(-1)?.path ?? null;
    publish(entry);
    return true;
  };
  const open = async ({
    workspaceId,
    sessionId,
    path: relativePath,
    local = false,
    absolutePath = undefined,
    conversationOptions = undefined,
  }) => {
    await loaded;
    const key = JSON.stringify([workspaceId, sessionId]);
    let entry = entries.get(key);
    if (!entry) {
      const options = validateFileWindowConversationOptions(conversationOptions);
      const workspaces = await client.getJson("/workspaces");
      const workspace = workspaces.items?.find(
        (item) => item.id === workspaceId && item.workspaceType !== "remote",
      );
      if (!local && !workspace?.path) throw new Error("工作区不可用");
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 680,
        minHeight: 500,
        title: "JuggleWork 文件浏览器",
        icon: iconPath,
        show: false,
        backgroundColor: "#f4f5f7",
        ...(process.platform === "darwin"
          ? {
              titleBarStyle: "hiddenInset",
              trafficLightPosition: { x: 12, y: 12 },
            }
          : {}),
        webPreferences: {
          // 每窗独立内存存储；不能继承主窗口的 localStorage、cookie 或持久化分区。
          partition: `file-window-${randomUUID()}`,
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          plugins: true,
        },
      });
      await dock?.prepareWindow(window);
      entry = {
        window,
        workspaceId,
        sessionId,
        workspaceRoot: workspace?.path ?? "",
        local,
        conversationOptions: options,
        tabs: [],
        activePath: null,
        closing: false,
        closed: false,
        requests: new Set(),
        subscriptions: new Map(),
      };
      entries.set(key, entry);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("render-process-gone", () => cancelEntry(entry));
      window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) cancelEntry(entry);
      });
      window.on("close", (event) => {
        if (entry.closed) return;
        event.preventDefault();
        if (entry.closing) return;
        entry.closing = true;
        void (async () => {
          try {
            for (const tab of [...entry.tabs])
              if (!(await closeTab(entry, tab.path))) return;
            entry.closed = true;
            window.destroy();
          } catch (error) {
            dialog.showErrorBox("文档关闭失败", error.message);
          } finally {
            entry.closing = false;
          }
        })();
      });
      window.on("closed", () => {
        cancelEntry(entry);
        entries.delete(key);
        updateDock();
      });
      try {
        await refreshConversation(entry);
        await loadWindow(window);
        if (!(await addFile(entry, relativePath, absolutePath))) {
          entry.closed = true;
          if (!window.isDestroyed()) window.destroy();
          return;
        }
      } catch (error) {
        const main = getMainWindow();
        if (main)
          for (const tab of entry.tabs)
            if (tab.documentId) office.assign(tab.documentId, main);
        entry.closed = true;
        window.destroy();
        throw error;
      }
    } else {
      await refreshConversation(entry);
      if (!(await addFile(entry, relativePath, absolutePath))) return;
    }
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
  };
  const openLocal = async (absolutePath) => {
    if (!registerLocalFile) throw new Error("本机文件入口不可用");
    await open(await registerLocalFile(absolutePath));
  };
  const openDialog = async (window, { workspaceId, sessionId }) => {
    const entry = [...entries.values()].find(
      (item) => item.window === window,
    );
    if (entry?.local) {
      const picked = await dialog.showOpenDialog(window, {
        title: "打开文件",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Office 文档", extensions: ["docx", "xlsx", "csv", "pptx"] },
        ],
      });
      if (!picked.canceled && !window.isDestroyed())
        for (const absolute of picked.filePaths) await openLocal(absolute);
      return;
    }
    const workspaceRoot =
      entry?.workspaceRoot ??
      (await client.getJson("/workspaces")).items?.find(
        (item) => item.id === workspaceId && item.workspaceType !== "remote",
      )?.path;
    if (!workspaceRoot) throw new Error("工作区不可用");
    const picked = await dialog.showOpenDialog(window, {
      title: "打开文件",
      defaultPath: workspaceRoot,
      properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || window.isDestroyed()) return;
    for (const absolute of picked.filePaths) {
      let relative;
      try {
        relative = workspaceFilePath(workspaceRoot, absolute);
      } catch {
        // TIPS: 原生选择器已明确选择原件；工作区外文件沿用默认文件助手，不改绑原窗口的聊天。
        await openLocal(absolute);
        continue;
      }
      if (entry) await addFile(entry, relative);
      else
        window.webContents.send("jugglework:file-window:open-in-panel", {
          workspaceId,
          sessionId,
          path: relative,
        });
    }
  };
  const createDocument = async (window, input) => {
    const entry = [...entries.values()].find(
      (item) => item.window === window,
    );
    if (entry?.local) throw new Error("请在聊天工作区中新建文档");
    const workspaceId = entry?.workspaceId ?? input?.workspaceId;
    const sessionId = entry?.sessionId ?? input?.sessionId;
    const kind = input?.kind;
    if (!workspaceId || !sessionId || !["docx", "pptx"].includes(kind))
      throw new Error("新建文档参数无效");
    const workspaceRoot =
      entry?.workspaceRoot ??
      (await client.getJson("/workspaces")).items?.find(
        (item) => item.id === workspaceId && item.workspaceType !== "remote",
      )?.path;
    if (!workspaceRoot) throw new Error("工作区不可用");
    const presentation = kind === "pptx";
    const picked = await dialog.showSaveDialog(window, {
      title: presentation ? "新建 PowerPoint 演示文稿" : "新建 Word 文档",
      defaultPath: path.join(
        workspaceRoot,
        presentation ? "未命名演示文稿.pptx" : "未命名文档.docx",
      ),
      filters: [
        presentation
          ? { name: "PowerPoint 演示文稿", extensions: ["pptx"] }
          : { name: "Word 文档", extensions: ["docx"] },
      ],
    });
    if (picked.canceled || !picked.filePath || window.isDestroyed()) return null;
    if (path.extname(picked.filePath).toLowerCase() !== `.${kind}`)
      throw new Error(`请选择 .${kind} 文件`);
    const relativePath = workspaceFilePath(workspaceRoot, picked.filePath);
    await client.postJson(
      `/workspace/${encodeURIComponent(workspaceId)}/office/create`,
      { sessionId, path: relativePath },
    );
    return { path: relativePath };
  };
  return {
    /** 打开或激活所属聊天的独立文件窗口。 */
    open,
    /** 从系统或本机文件选择器打开明确原件，由既有登记恢复文件助手或存活模型的会话。 */
    openLocal,
    /** 原生编辑区与标签菜单共用文件选择器；区内文件沿用当前宿主，区外原件进入文件助手窗口。 */
    openDialog,
    /** 返回当前存活文件窗口，供 Office 校验和迁移宿主。 */
    windows: () => [...entries.values()].map((entry) => entry.window),
    /** 点击 Dock 入口时激活指定窗口，默认选择最后聚焦的文档窗口。 */
    activate(windowId) {
      const values = [...entries.values()];
      const entry =
        values.find((item) => item.window.id === windowId) ??
        values.find((item) => item.window.isFocused()) ??
        values.at(-1);
      if (!entry || entry.window.isDestroyed()) return;
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
    },
    /** Dock 退出仍逐个确认未保存文件，取消时保留当前窗口和入口。 */
    async closeAll() {
      for (const entry of [...entries.values()]) {
        for (const tab of [...entry.tabs])
          if (!(await closeTab(entry, tab.path))) return false;
        entry.closed = true;
        entry.window.destroy();
      }
      return true;
    },
    /** 重启前共用退出保存确认；取消或失败保留服务与窗口，确认后释放旧上下文及页面。 */
    async prepareRuntimeStop() {
      if (fileEditor && !(await fileEditor.prepareQuit())) return false;
      if (!(await office.prepareQuit())) return false;
      this.dispose();
      office.destroy();
      return true;
    },
    /** 全局文档退出检查通过后销毁窗口，避免服务停止后再次调用保存接口。 */
    dispose() {
      for (const entry of [...entries.values()]) {
        entry.closed = true;
        entry.window.destroy();
      }
      dock?.dispose();
    },
    /** 按渲染进程查找可信文件宿主。 */
    windowFor: (sender) => entryFor(sender)?.window ?? null,
    /** 仅向同一工作区、聊天的已登记 AI 宿主投递选区；引用必须来自 Main 的真实采集。 */
    officeComposerWindow(input) {
      const entry = [...entries.values()].find((item) => item.window.id === input.windowId);
      if (!entry || !entry.conversation || entry.workspaceId !== input.workspaceId ||
          entry.sessionId !== input.sessionId || entry.window.isDestroyed()) return null;
      if (input.action === "append") {
        const ref = input.reference;
        if (ref?.workspaceId !== entry.workspaceId || ref.ownerSessionId !== entry.sessionId ||
            !entry.tabs.some((tab) => tab.documentId === ref.documentId)) return null;
        (entry.officeReferences ??= new Map()).set(ref.referenceId, ref.documentId);
      }
      return entry.window;
    },
    /** 关闭共享模型时同时检查两种宿主的独立草稿。 */
    officeComposerWindows(workspaceId, sessionId) {
      return [...entries.values()].filter((entry) => entry.conversation &&
        entry.workspaceId === workspaceId && entry.sessionId === sessionId && !entry.window.isDestroyed()).map((entry) => entry.window);
    },
    /** 文件窗口只能操作 Main 已投递到当前窗口的选区身份。 */
    authorizeOfficeReferences(event, input) {
      const entry = resolve(event);
      const ids = input.referenceIds ?? [input.referenceId];
      if (entry.workspaceId !== input.workspaceId || entry.sessionId !== input.sessionId || !Array.isArray(ids) ||
          ids.length > 16 || ids.some((id) => !entry.officeReferences?.has(id) ||
            !entry.tabs.some((tab) => tab.documentId === entry.officeReferences.get(id)))) throw new Error("选区不属于当前文件窗口");
    },
    /** 文本编辑 IPC 仅信任主窗口顶层或已登记文件窗口中的精确文件。 */
    authorizeFileEditor(event, input) {
      assertTopLevel(event);
      if (typeof input?.workspaceId !== "string" || !input.workspaceId ||
          typeof input?.path !== "string" || !input.path)
        throw new Error("文件编辑目标无效");
      const main = getMainWindow();
      if (main && !main.isDestroyed() && event.sender === main.webContents) return main;
      const entry = resolve(event);
      if (input.workspaceId !== entry.workspaceId || !entry.tabs.some((tab) => tab.path === input.path))
        throw new Error("文件编辑目标未授权");
      return entry.window;
    },
    /** 草稿正文只发送给可信主窗口及当前仍登记该文件的窗口。 */
    canReceiveFileEditor(window, input) {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      if (window === getMainWindow()) return true;
      const entry = entryFor(window.webContents);
      return entry?.window === window && input?.workspaceId === entry.workspaceId &&
        entry.tabs.some((tab) => tab.path === input.path);
    },
    /** 通用 desktop fetch 的文件窗口分支只使用 Main 登记的上下文。 */
    async fetch(event, url, init, fetchImpl) {
      const entry = resolve(event);
      if (typeof url === "string" && /\/(?:sessions|session-runs|opencode)(?:\/|\?|$)/.test(new URL(url).pathname)) {
        await refreshConversation(entry);
        if (resolve(event) !== entry) throw new Error("文件窗口已关闭");
      }
      const access = await getAccess();
      // getAccess 期间窗口可能已关闭；不能沿用已注销的登记。
      if (resolve(event) !== entry) throw new Error("文件窗口已关闭");
      const controller = new AbortController();
      entry.requests.add(controller);
      let response;
      try { response = await fetchFileWindowResponse(entry, access, url, init, fetchImpl, controller.signal, (signal) => prepareSessionStop(entry, signal)); }
      finally { entry.requests.delete(controller); }
      // 响应读取期间关闭窗口也会撤销登记，不能再向原宿主返回文件内容。
      if (resolve(event) !== entry) throw new Error("文件窗口已关闭");
      return response;
    },
    /** Office 快捷键关闭后同步对应标签。 */
    documentClosed(documentId) {
      for (const entry of entries.values()) {
        const tab = entry.tabs.find((tab) => tab.documentId === documentId);
        if (!tab) continue;
        entry.tabs = entry.tabs.filter((item) => item !== tab);
        if (entry.activePath === tab.path)
          entry.activePath = entry.tabs.at(-1)?.path ?? null;
        publish(entry);
      }
    },
    /** 注册最小窗口动作，文件选择和导出均使用原生对话框。 */
    registerIpc(ipcMain) {
      ipcMain.handle("jugglework:file-window:session-stop-reply", async (event, input) => {
        assertTopLevel(event);
        const pending = pendingStops.get(input?.requestId);
        if (!pending || event.sender !== pending.sender || event.sender !== getMainWindow()?.webContents) throw new Error("停止确认来源无效");
        pending.finish(input.ok === true);
      });
      ipcMain.handle("jugglework:file-window:available", (event) => {
        resolveHost(event);
        return true;
      });
      ipcMain.handle("jugglework:file-window:open", async (event, input) => {
        resolveHost(event);
        const entry = entryFor(event.sender);
        assertEntryContext(entry, input);
        // TIPS: Renderer 入口仍只能打开已有工作区文件；本机路径必须经过主进程登记。
        await open({
          workspaceId: entry?.workspaceId ?? input.workspaceId,
          sessionId: entry?.sessionId ?? input.sessionId,
          path: input.path,
          // 仅 resolveHost 确认的主窗口顶层可 seed；文件宿主只沿用已有 entry。
          conversationOptions: entry ? undefined : input.conversationOptions,
        });
      });
      ipcMain.handle("jugglework:file-window:state", async (event) => {
        const entry = resolve(event);
        await refreshConversation(entry);
        const access = await getAccess();
        if (!access) throw new Error("本地服务不可用");
        const appearance = await getAppearance();
        if (resolve(event) !== entry) throw new Error("文件窗口不存在");
        return {
          ...state(entry),
          baseUrl: access.baseUrl,
          appearance,
        };
      });
      ipcMain.handle("jugglework:file-window:session-subscribe", async (event) => {
        const entry = resolve(event);
        await refreshConversation(entry);
        if (resolve(event) !== entry) throw new Error("文件窗口已关闭");
        if (!entry.conversation || entry.subscriptions.size >= 4) throw new Error("文件窗口会话不可用");
        const id = randomUUID();
        const controller = new AbortController();
        entry.subscriptions.set(id, controller);
        const sse = createManagedRuntimeSseClient({ getAccess: async () => {
          const access = await getAccess();
          if (resolve(event) !== entry || controller.signal.aborted) throw new Error("文件窗口已关闭");
          const url = new URL(access.baseUrl);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("本地服务不可用");
          return access;
        }, fetcher, maxBufferBytes: 1024 * 1024 });
        void sse.subscribe({ workspaceId: entry.workspaceId, signal: controller.signal,
          onReconnectGap: () => {},
          onEvent: (raw) => {
            if (controller.signal.aborted || entryFor(event.sender) !== entry) return;
            const value = fileWindowSessionEvent(entry, raw);
            if (value) entry.window.webContents.send("jugglework:file-window:session-event", { id, event: value });
          },
        }).catch(() => {}).finally(() => { controller.abort(); entry.subscriptions.delete(id); });
        return id;
      });
      ipcMain.handle("jugglework:file-window:session-unsubscribe", (event, id) => {
        const entry = resolve(event);
        entry.subscriptions.get(id)?.abort();
        entry.subscriptions.delete(id);
      });
      ipcMain.handle("jugglework:file-window:create", async (event, input) => {
        const window = resolveHost(event);
        assertEntryContext(entryFor(event.sender), input);
        return createDocument(window, input);
      });
      ipcMain.handle(
        "jugglework:file-window:action",
        async (event, action, requestedPath) => {
          const entry = resolve(event);
          if (action === "open-session") {
            if (requestedPath !== undefined || !entry.conversation || !openSession) throw new Error("文件窗口会话不可用");
            await openSession({ workspaceId: entry.workspaceId, sessionId: entry.sessionId });
            return;
          }
          const tab = entry.tabs.find(
            (tab) => tab.path === (requestedPath ?? entry.activePath),
          );
          if (action === "select") {
            if (tab) {
              if ((!entry.local || entry.conversation) && entry.activePath !== tab.path && office.confirmFileTarget && !await office.confirmFileTarget(entry.window, {
                workspaceId: entry.workspaceId, sessionId: entry.sessionId, path: tab.path,
              })) return;
              entry.activePath = tab.path;
              publish(entry);
            }
            return;
          }
          if (action === "close") {
            if (tab) await closeTab(entry, tab.path);
            return;
          }
          if (action === "open") {
            if (requestedPath) {
              if (entry.local) {
                // Renderer cannot grant itself a new absolute source. Only
                // reopen a Main-recorded recent file; new files use the dialog.
                if (!recent.some((item) => item.workspaceId === "local" && item.path === requestedPath)) {
                  throw new Error("请通过文件选择框打开本机文件");
                }
                await openLocal(requestedPath);
              }
              else await addFile(entry, requestedPath);
              return;
            }
            await openDialog(entry.window, entry);
            return;
          }
          if (!tab) return;
          if (action === "reveal") {
            shell.showItemInFolder(
              tab.absolutePath ?? path.join(entry.workspaceRoot, tab.path),
            );
            return;
          }
          if (action === "save-copy") {
            if (
              !tab.documentId &&
              fileEditor &&
              !(await fileEditor.prepare(
                { workspaceId: entry.workspaceId, path: tab.path },
                entry.window,
              ))
            )
              return;
            if (getOfficeDocumentKind(tab.path))
              await client.postJson(`${base(entry)}/prepare-file`, {
                sessionId: entry.sessionId,
                path: tab.path,
              });
            await saveArtifactFileCopy({
              workspaceRoot: tab.absolutePath
                ? path.dirname(tab.absolutePath)
                : entry.workspaceRoot,
              relativePath: tab.absolutePath
                ? path.basename(tab.absolutePath)
                : tab.path,
              assertDestination: (destination) =>
                client.postJson("/office/check-copy-target", {
                  path: destination,
                }),
              choosePath: async (name) => {
                const result = await dialog.showSaveDialog(entry.window, {
                  title: "另存为",
                  defaultPath: name,
                });
                return result.canceled ? null : (result.filePath ?? null);
              },
            });
            return;
          }
          throw new Error("文件操作不可用");
        },
      );
    },
  };
}
