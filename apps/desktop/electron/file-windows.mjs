import { getOfficeDocumentKind } from "@jugglework/types/office";
import { FILE_WINDOW_EXTENSIONS } from "../dist/runtime/file-window.js";
import { BrowserWindow, clipboard, dialog, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveArtifactFileCopy, resolveArtifactExternalSource } from "./artifact-file-operations.mjs";
import { authorizeFileWindowFetch, fetchFileWindowResponse } from "./file-window-fetch.mjs";
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
  uploadCloud,
  lookupCloud,
  cloudDocs,
  fetcher = fetch,
}) {
  const entries = new Map();
  const pendingAdds = new Map();
  const pendingOpens = new Map();
  const sourceKey = (source) => JSON.stringify([source.workspaceId, source.sessionId]);
  const activeTab = (entry) => entry.tabs.find(tab => tab.tabId === entry.activeTabId);
  // 顶层仅用于旧 UI 投影；异步操作始终捕获独立 source context。
  const selectTab = (entry, tab) => {
    entry.activeTabId = tab?.tabId ?? null;
    entry.activePath = tab?.path ?? null;
    Object.assign(entry, tab?.source ?? { workspaceId: "", sessionId: "", workspaceRoot: "" });
    entry.local = tab?.local ?? (entry.group.kind === "file-assistant");
    entry.conversation = tab ? entry.sources.get(sourceKey(tab.source))?.conversation : undefined;
  };
  const contextFor = (entry, input) => {
    const contexts = [...entry.sources.values()].filter(context => context.workspaceId === input?.workspaceId &&
      (input?.sessionId === undefined || context.sessionId === input.sessionId) && context.tabs.length);
    if (contexts.length !== 1) throw new Error("文件窗口工作区或聊天不匹配");
    return contexts[0];
  };
  const requestContext = (entry, url) => {
    const match = /\/workspace\/([^/]+)(?:\/|$)/.exec(new URL(url).pathname);
    if (!match) throw new Error("文件窗口请求超出已登记文件范围");
    return contextFor(entry, { workspaceId: decodeURIComponent(match[1]) });
  };
  const registered = (entry, context) => !entry.window.isDestroyed() && entry.sources.get(sourceKey(context)) === context && context.tabs.length > 0;
  let cloudUploads = [];
  let cloudScope = null;
  const cloudLookups = new Set();
  const lookupUpload = (entry) => {
    const tab = activeTab(entry);
    if (!cloudScope || !lookupCloud || !tab || tab.cloudDoc || tab.cloudAttachment || uploaded(tab.source.workspaceId, tab.path)) return;
    const key = JSON.stringify([cloudScope, tab.source.workspaceId, tab.path]);
    if (cloudLookups.has(key)) return;
    cloudLookups.add(key);
    void lookupCloud({ workspaceId: tab.source.workspaceId, path: tab.path });
  };
  const uploaded = (workspaceId, filePath) => cloudUploads.find(item => item.localWorkspaceId === workspaceId && item.path === filePath);
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
            activeTab(entry)?.name ??
            "JuggleWork 文件浏览器",
        })),
    );
  const state = (entry) => ({
    group: entry.group,
    activeTabId: entry.activeTabId,
    workspaceId: entry.workspaceId,
    sessionId: entry.sessionId,
    workspaceRoot: entry.workspaceRoot,
    local: entry.local,
    tabs: entry.tabs.map(({ local, ...tab }) => ({ ...tab, ...(entry.sources.get(sourceKey(tab.source))?.conversation ? { conversation: entry.sources.get(sourceKey(tab.source)).conversation } : {}), ...(uploaded(tab.source.workspaceId, tab.path) ? { cloudUpload: { url: uploaded(tab.source.workspaceId, tab.path).url, tenantId: uploaded(tab.source.workspaceId, tab.path).tenantId } } : {}) })),
    activePath: entry.activePath,
    recent: recent
      .filter(
        (item) =>
          item.workspaceId === (entry.local ? "local" : entry.workspaceId || entry.groupSource?.workspaceId),
      )
      .map(({ path, name }) => ({ path, name })),
    platform: process.platform,
    ...(entry.conversation ? { conversation: entry.conversation } : {}),
  });
  const cancelEntry = (entry) => {
    if (entry.sources) { for (const context of entry.sources.values()) cancelEntry(context); return; }
    entry.verifiedDescendants = new Set();
    for (const controller of entry.requests) controller.abort();
    entry.requests.clear();
    for (const controller of entry.subscriptions.values()) controller.abort();
    entry.subscriptions.clear();
  };
  const refreshConversation = async (entry, context) => {
    if (!context) { await Promise.all([...entry.sources.values()].map(context => refreshConversation(entry, context))); return; }
    if (!context.workspaceRoot || !context.sessionId || context.sessionId === "file-browser" || context.workspaceId.startsWith("rem_") || !getDesktopConfig) return;
    const previous = context.conversation;
    const controller = new AbortController();
    context.requests.add(controller);
    try {
      const [{ item }, desktopConfig] = await Promise.all([
        client.getJson(`/workspace/${encodeURIComponent(context.workspaceId)}/sessions/${encodeURIComponent(context.sessionId)}`, { signal: controller.signal }),
        getDesktopConfig(),
      ]);
      if (entry.window.isDestroyed() || controller.signal.aborted || entry.sources.get(sourceKey(context)) !== context) throw new Error("文件窗口已关闭");
      const policy = desktopConfigSchema.safeParse(desktopConfig);
      context.conversation = item?.id === context.sessionId && policy.success ? { ...context.conversationOptions, desktopConfig: policy.data } : undefined;
    } catch { context.conversation = undefined; }
    finally { context.requests.delete(controller); }
    if (!context.conversation) cancelEntry(context);
    selectTab(entry, activeTab(entry));
    // Changed listeners may request state again. Publish transitions only, not every policy read.
    if (!isDeepStrictEqual(previous, context.conversation)) publish(entry);
  };
  const publish = (entry) => {
    if (!entry.window.isDestroyed()) {
      entry.window.setTitle("JuggleWork 文件浏览器");
      entry.window.webContents.send(
        "jugglework:file-window:changed",
        state(entry),
      );
      updateDock();
      lookupUpload(entry);
    }
  };
  const remember = async (entry, tab) => {
    entry = { ...tab.source, local: tab.local };
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
    if (!input || typeof input.workspaceId !== "string" || typeof input.sessionId !== "string") throw new Error("文件窗口工作区或聊天不匹配");
    if (entry) return contextFor(entry, input);
  };
  /** 空 conversation 窗只保留原始组的文件打开/创建能力，不恢复会话请求授权。 */
  const captureFileOperation = (entry, input) => {
    const context = entry.tabs.length ? contextFor(entry, input) : null;
    const source = context?.source ?? entry.groupSource;
    if (!source || (!context && input &&
      !((input.workspaceId === "" && input.sessionId === "") ||
        (input.workspaceId === source.workspaceId && input.sessionId === source.sessionId)))) throw new Error("文件窗口工作区或聊天不匹配");
    const group = entry.group;
    const verify = () => {
      if (entryFor(entry.window.webContents) !== entry || entry.group !== group ||
        (context && !registered(entry, context)) || (!context && entry.groupSource !== source)) throw new Error("文件窗口来源已关闭");
    };
    verify();
    return { entry, source, verify };
  };
  const registerSource = (entry, origin, local, conversationOptions) => {
    let context = entry.sources.get(sourceKey(origin));
    if (!context) {
      if ([...entry.sources.values()].some(item => item.workspaceId === origin.workspaceId && item.sessionId !== origin.sessionId)) throw new Error("文件窗口同一工作区只能登记唯一聊天");
      context = { ...origin, source: origin, local, conversationOptions, requests: new Set(), subscriptions: new Map(), officeReferences: new Map(), verifiedDescendants: new Set(), cloudDocument: entry.cloudDocument };
      Object.defineProperty(context, "tabs", { get: () => entry.tabs.filter(tab => sourceKey(tab.source) === sourceKey(origin)) });
      Object.defineProperty(context, "activePath", { get: () => context.tabs.find(tab => tab.tabId === entry.activeTabId)?.path ?? null });
      entry.sources.set(sourceKey(origin), context);
    }
    return context;
  };
  const addCapturedFile = async (entry, captured, relativePath) => {
    captured.verify();
    const context = registerSource(entry, captured.source, false, entry.groupConversationOptions);
    try {
      await refreshConversation(entry, context);
      captured.verify();
      return await addFile(entry, context, relativePath, undefined, false, captured.verify);
    } finally {
      if (!context.tabs.length) { cancelEntry(context); entry.sources.delete(sourceKey(context)); }
    }
  };
  const addFile = (entry, context, relativePath, absolutePath, readOnly = false, verifySource = () => {}) => {
    // TIPS: 同来源同路径的预检及 Windows 保存关闭重开共用一个操作，其他 source 不合并。
    const key = JSON.stringify([entry.window.id, sourceKey(context), relativePath]);
    const pending = pendingAdds.get(key);
    if (pending) return pending;
    const operation = addFileToEntry(entry, context, relativePath, absolutePath, readOnly, verifySource)
      .finally(() => pendingAdds.delete(key));
    pendingAdds.set(key, operation);
    return operation;
  };
  const addFileToEntry = async (entry, context, relativePath, absolutePath, readOnly, verifySource) => {
    const verify = () => {
      verifySource();
      if (entry.window.isDestroyed() || entry.sources.get(sourceKey(context)) !== context) throw new Error("文件窗口来源已关闭");
    };
    let createdDocument;
    let cleanupPrepared;
    const cleanupNewDocument = async () => {
      if (!createdDocument || [...entries.values()].some(item => item.tabs.some(tab => tab.documentId === createdDocument.documentId))) return;
      if (cleanupPrepared) return cleanupPrepared();
      await client.postJson(`${base(context)}/${encodeURIComponent(createdDocument.documentId)}/close`, {
        decision: "discard", onlyIfClean: true, sessionId: context.sessionId,
      });
    };
    try {
      verify();
      if ((!context.local || context.conversation) && office.confirmFileTarget && !await office.confirmFileTarget(entry.window, {
        workspaceId: context.workspaceId, sessionId: context.sessionId, path: relativePath, ...(readOnly ? { readOnly: true } : {}),
      }, verify, (document, cleanup) => { createdDocument = document; cleanupPrepared = cleanup; })) return null;
      verify();
      const response = await client.getJson(
        `/workspace/${encodeURIComponent(context.workspaceId)}/files/stat?path=${encodeURIComponent(relativePath)}`,
      );
      verify();
      if (!response.exists || response.kind !== "file")
        throw new Error("文件不存在");
      // TIPS: Main 加入已有文件窗口时只携带稳定标识；每个标签仍须从同一登记取得原件，不能依赖首次开窗参数。
      absolutePath ??= await resolveArtifactExternalSource(client, context.workspaceRoot, relativePath);
      verify();
      let tab = context.tabs.find((tab) => tab.path === relativePath);
      const existing = tab;
      const previous = activeTab(entry);
      let openingDocument;
      if (!tab) {
        tab = {
          tabId: randomUUID(),
          source: context.source,
          local: Boolean(absolutePath) || context.local,
          path: relativePath,
          name: path.basename(relativePath),
          ...(absolutePath ? { absolutePath } : {}),
        };
        if (readOnly) {
          // 云端附件副本只读预览，不打开可编辑的 Office 文档。
          tab.readOnly = true;
          tab.cloudAttachment = true;
        } else if (getOfficeDocumentKind(relativePath)) {
          const { available } = await client.getJson(
            `${base(context)}/capabilities`,
          );
          verify();
          if (available) {
            try {
              const { document, created } = await client.postJson(`${base(context)}/open`, {
                sessionId: context.sessionId,
                path: relativePath,
              });
              if (created === true && document.workspaceId === context.workspaceId && document.ownerSessionId === context.sessionId) {
                createdDocument = document;
                cleanupPrepared = undefined;
              }
              verify();
              if (document.state === "error")
                throw new Error(document.error ?? "文档打开失败");
              openingDocument = document;
            } catch (error) {
              if (error?.serverCode !== "office_readonly_required") throw error;
              tab.readOnly = true;
            }
          }
        }
        entry.tabs.push(tab);
      }
      selectTab(entry, tab);
      const rollback = () => {
        const selected = activeTab(entry);
        if (!existing) removeTab(entry, tab);
        if (selected === tab) selectTab(entry, entry.tabs.includes(previous) ? previous : activeTab(entry));
      };
      try {
        await entry.prepareWindow();
        verify();
        const isCurrent = () => {
          verify();
          return entry.tabs.includes(tab);
        };
        let opened = openingDocument;
        if (openingDocument) {
          opened = office.openInWindow
            ? await office.openInWindow(openingDocument, entry.window, async (source, restored) => {
                const original = entryFor(source.webContents);
                if (original) {
                  const origin = Object.freeze({ workspaceId: restored.workspaceId, sessionId: restored.ownerSessionId, workspaceRoot: context.workspaceRoot });
                  const restoredContext = registerSource(original, origin, context.local, context.conversationOptions);
                  try { await addFile(original, restoredContext, restored.relativePath, absolutePath, readOnly); }
                  finally {
                    if (!restoredContext.tabs.length) { cancelEntry(restoredContext); original.sources.delete(sourceKey(restoredContext)); }
                  }
                } else {
                  await openSession?.({ workspaceId: restored.workspaceId, sessionId: restored.ownerSessionId, exact: true });
                  if (!source.isDestroyed()) source.webContents.send("jugglework:file-window:open-in-panel", {
                    workspaceId: restored.workspaceId, sessionId: restored.ownerSessionId, path: restored.relativePath,
                  });
                }
              }, isCurrent, document => { createdDocument = document; cleanupPrepared = undefined; })
            : await office.transfer(openingDocument.documentId, entry.window, isCurrent) ? openingDocument : null;
          if (opened) tab.documentId = opened.documentId;
        }
        if ((openingDocument && !opened) || (!openingDocument && tab.documentId && !await office.transfer(tab.documentId, entry.window, isCurrent))) {
          rollback();
          publish(entry);
          return null;
        }
        verify();
        if (!entry.tabs.includes(tab)) throw new Error("文件窗口来源已关闭");
      } catch (error) {
        rollback();
        publish(entry);
        throw error;
      }
      await remember(entry, tab);
      publish(entry);
      return tab;
    } finally {
      // 包含预检返回后的 verify/stat/resolve/open；复用模型从不获得清理责任。
      try { await cleanupNewDocument(); }
      catch (error) { console.warn("Office 打开模型清理失败，保留服务端记录", createdDocument?.documentId, String(error)); }
    }
  };
  const removeTab = (entry, tab) => {
    entry.tabs = entry.tabs.filter(item => item !== tab);
    const context = entry.sources.get(sourceKey(tab.source));
    if (context) {
      for (const [id, documentId] of context.officeReferences ?? []) if (documentId === tab.documentId) context.officeReferences.delete(id);
      if (!context.tabs.length) { cancelEntry(context); entry.sources.delete(sourceKey(context)); }
    }
    selectTab(entry, activeTab(entry) ?? entry.tabs.at(-1));
  };
  const closeTab = async (entry, tabId) => {
    const tab = entry.tabs.find((tab) => tab.tabId === tabId);
    if (!tab) return true;
    if (tab.cloudDoc) {
      if (!await cloudDocs.prepareClose(tab.cloudDoc.instanceId)) throw new Error("文档尚未保存完成，请稍后再试");
      cloudDocs.close(tab.cloudDoc.instanceId);
    }
    if (
      !tab.cloudDoc &&
      !tab.documentId &&
      !tab.readOnly &&
      fileEditor &&
      !(await fileEditor.close(
        { workspaceId: tab.source.workspaceId, path: tab.path },
        entry.window,
      ))
    )
      return false;
    if (
      tab.documentId &&
      !(await office.close(tab.source.workspaceId, tab.documentId, () => {
        if (entry.window.isDestroyed() || !entry.tabs.includes(tab)) throw new Error("文件窗口来源已关闭");
      }))
    )
      return false;
    // TIPS: 只移除当前标签身份；同名路径的其他来源保持存活。
    removeTab(entry, tab);
    publish(entry);
    return true;
  };
  const openWindow = async ({
    source = undefined,
    workspaceId = undefined,
    sessionId = undefined,
    workspaceRoot = undefined,
    group: trustedGroup = undefined,
    path: relativePath,
    local = false,
    absolutePath = undefined,
    conversationOptions = undefined,
    readOnly = false,
    cloudDoc = undefined,
    launch = undefined,
    captured = undefined,
    verifyCloudSource = undefined,
  }) => {
    await loaded;
    captured?.verify();
    workspaceId = source?.workspaceId ?? workspaceId;
    sessionId = source?.sessionId ?? sessionId;
    workspaceRoot = source?.workspaceRoot ?? workspaceRoot;
    const group = trustedGroup?.kind === "file-assistant" ? { kind: "file-assistant" }
      : trustedGroup?.kind === "conversation" ? { kind: "conversation", workspaceId: trustedGroup.workspaceId, sessionId: trustedGroup.sessionId }
      : { kind: "conversation", workspaceId, sessionId };
    const key = group.kind === "file-assistant" ? "file-assistant" : JSON.stringify([group.workspaceId, group.sessionId]);
    const options = validateFileWindowConversationOptions(conversationOptions);
    const workspaces = await client.getJson("/workspaces");
    captured?.verify();
    verifyCloudSource?.();
    const workspace = workspaces.items?.find(item => item.id === workspaceId && item.workspaceType !== "remote");
    if (!local && !workspace?.path) throw new Error("工作区不可用");
    if (workspaceRoot && workspace?.path && workspaceRoot !== workspace.path) throw new Error("工作区不可用");
    const origin = Object.freeze({ workspaceId, sessionId, workspaceRoot: workspace?.path ?? workspaceRoot ?? "" });
    let entry = captured?.entry ?? entries.get(key);
    if (!entry) {
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
      entry = {
        window,
        group: Object.freeze(group),
        groupSource: group.kind === "conversation" ? origin : undefined,
        groupConversationOptions: options,
        sources: new Map(),
        workspaceId: "", sessionId: "", workspaceRoot: "",
        tabs: [],
        cloudDocument: tab => tab?.cloudDoc ? cloudDocs?.documentFor(tab.cloudDoc.instanceId, window) : null,
        activePath: null,
        activeTabId: null,
        closing: false,
        closed: false,
        opening: 0,
        opened: false,
        loading: undefined,
        // 首个标签登记后才加载；所有复用者等待同一初始化结果。
        prepareWindow: () => entry.loading ??= Promise.resolve().then(async () => {
          await dock?.prepareWindow(window);
          if (window.isDestroyed()) throw new Error("文件窗口已关闭");
          await loadWindow(window);
        }),
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
              if (!(await closeTab(entry, tab.tabId))) return;
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
        if (entries.get(key) === entry) entries.delete(key);
        updateDock();
      });
    }
    entry.opening++;
    let context;
    try {
      context = registerSource(entry, origin, local, options);
      await refreshConversation(entry, context);
      captured?.verify();
      verifyCloudSource?.();
      if (!cloudDoc && !(await addFile(entry, context, relativePath, absolutePath, readOnly, captured?.verify))) return;
      if (cloudDoc) {
        const id = `cloud:${launch.presentation.instanceId}`;
        const existing = !verifyCloudSource && entry.tabs.find(tab => { const current = entry.cloudDocument(tab); return current?.tenantId === cloudDoc.tenantId && current.workspaceId === cloudDoc.workspaceId && current.docId === cloudDoc.docId; });
        if (existing) { selectTab(entry, existing); publish(entry); }
        else {
          const previous = activeTab(entry);
          const instanceId = launch.presentation.instanceId;
          const tab = { tabId: randomUUID(), source: context.source, kind: 'cloud-document', path: id, name: cloudDoc.title || 'Untitled', cloudScope: JSON.stringify([launch.sourceServerOrigin, launch.sourceUserId, cloudDoc.tenantId]), cloudDoc: { tenantId: cloudDoc.tenantId, workspaceId: cloudDoc.workspaceId, docId: cloudDoc.docId, instanceId, docsOrigin: launch.docsOrigin } };
          entry.tabs.push(tab);
          selectTab(entry, tab); publish(entry);
          try {
            await entry.prepareWindow();
            verifyCloudSource?.();
            await cloudDocs.open({ ...launch, instanceId, retain: true }, entry.window);
          }
          catch (error) {
            const selected = activeTab(entry) === tab;
            removeTab(entry, tab);
            if (selected && entry.tabs.includes(previous)) selectTab(entry, previous);
            publish(entry);
            throw error;
          }
        }
      }
      if (entry.window.isDestroyed()) throw new Error("文件窗口已关闭");
      entry.opened = true;
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
    } finally {
      entry.opening--;
      if (context && !context.tabs.length && entry.sources.get(sourceKey(context)) === context) {
        cancelEntry(context); entry.sources.delete(sourceKey(context));
      }
      // 失败打开只回收无人使用的新空窗；其他标签仍走正常 dirty close guard。
      if (!entry.opened && !entry.opening && !entry.tabs.length && !entry.window.isDestroyed()) {
        entry.closed = true; entry.window.destroy();
      }
    }
  };
  const open = (input) => {
    if (input.cloudDoc) return openWindow(input);
    // TIPS: 首次开窗也需合并相同请求；entry 尚未登记时，addFile 的窗口内保护还未生效。
    const source = input.source ?? input;
    const key = JSON.stringify([input.captured?.entry.window.id, input.group, source.workspaceId, source.sessionId, input.path]);
    const pending = pendingOpens.get(key);
    if (pending) return pending;
    const operation = openWindow(input).finally(() => pendingOpens.delete(key));
    pendingOpens.set(key, operation);
    return operation;
  };
  const openLocal = async (absolutePath, { readOnly = false } = {}) => {
    if (!registerLocalFile) throw new Error("本机文件入口不可用");
    const binding = await registerLocalFile(absolutePath);
    if (!["file-assistant", "conversation"].includes(binding?.group?.kind) ||
      (binding.group.kind === "conversation" && (binding.group.workspaceId !== binding.workspaceId || binding.group.sessionId !== binding.sessionId))) throw new Error("本机文件分组不可用");
    await open({ ...binding, readOnly });
  };
  /** 关闭打开自指定目录的本机文件标签，供云文档附件缓存清理前调用。 */
  const closeLocalUnder = async (directory) => {
    const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
    for (const entry of [...entries.values()])
      for (const tab of [...entry.tabs])
        if (tab.absolutePath?.startsWith(prefix)) await closeTab(entry, tab.tabId);
  };
  const openDialog = async (window, { workspaceId, sessionId }) => {
    const entry = [...entries.values()].find(
      (item) => item.window === window,
    );
    const captured = entry?.group.kind === "conversation" ? captureFileOperation(entry, { workspaceId, sessionId }) : null;
    const context = entry?.tabs.length ? contextFor(entry, { workspaceId, sessionId }) : null;
    if (entry?.group.kind === "file-assistant" || context?.local) {
      const picked = await dialog.showOpenDialog(window, {
        title: "打开文件",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "支持的文件", extensions: [...FILE_WINDOW_EXTENSIONS] }],
      });
      if (!picked.canceled && !window.isDestroyed())
        for (const absolute of picked.filePaths) { captured?.verify(); await openLocal(absolute); }
      return;
    }
    const workspaceRoot =
      captured?.source.workspaceRoot ??
      (await client.getJson("/workspaces")).items?.find(
        (item) => item.id === workspaceId && item.workspaceType !== "remote",
      )?.path;
    if (!workspaceRoot) throw new Error("工作区不可用");
    const picked = await dialog.showOpenDialog(window, {
      title: "打开文件",
      defaultPath: workspaceRoot,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "支持的文件", extensions: [...FILE_WINDOW_EXTENSIONS] }],
    });
    if (picked.canceled || window.isDestroyed()) return;
    captured?.verify();
    for (const absolute of picked.filePaths) {
      let relative;
      try {
        relative = workspaceFilePath(workspaceRoot, absolute);
      } catch {
        // TIPS: 原生选择器已明确选择原件；工作区外文件沿用默认文件助手，不改绑原窗口的聊天。
        await openLocal(absolute);
        continue;
      }
      if (entry) {
        await addCapturedFile(entry, captured, relative);
      }
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
    if (entry?.group.kind === "file-assistant") throw new Error("请在聊天工作区中新建文档");
    const captured = entry ? captureFileOperation(entry, input) : null;
    const context = entry?.tabs.length ? contextFor(entry, input) : null;
    if (context?.local) throw new Error("请在聊天工作区中新建文档");
    const workspaceId = captured?.source.workspaceId ?? input?.workspaceId;
    const sessionId = captured?.source.sessionId ?? input?.sessionId;
    const kind = input?.kind;
    if (!workspaceId || !sessionId || !["docx", "pptx"].includes(kind))
      throw new Error("新建文档参数无效");
    const workspaceRoot =
      captured?.source.workspaceRoot ??
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
    captured?.verify();
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
    closeLocalUnder,
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
          if (!(await closeTab(entry, tab.tabId))) return false;
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
    /** 采用 Main 原生路由更新现有标签定位和标题，标签实例保持不变。 */
    updateCloudDocument(window, instanceId, document) {
      const entry = [...entries.values()].find(entry => entry.window === window);
      const tab = entry?.tabs.find(tab => tab.cloudDoc?.instanceId === instanceId);
      if (!tab || tab.cloudDoc.tenantId !== document.tenantId) return;
      tab.cloudDoc = { ...tab.cloudDoc, workspaceId: document.workspaceId, docId: document.docId };
      if (document.title) tab.name = document.title;
      publish(entry);
    },
    officeComposerWindow(input) {
      const entry = [...entries.values()].find((item) => item.window.id === input.windowId);
      if (!entry || entry.window.isDestroyed()) return null;
      let context;
      try { context = assertEntryContext(entry, input); } catch { return null; }
      if (!context.conversation) return null;
      if (input.action === "append") {
        const ref = input.reference;
        if (ref?.workspaceId !== context.workspaceId || ref.ownerSessionId !== context.sessionId ||
            !context.tabs.some((tab) => tab.documentId === ref.documentId)) return null;
        context.officeReferences.set(ref.referenceId, ref.documentId);
      }
      return entry.window;
    },
    /** 关闭共享模型时同时检查两种宿主的独立草稿。 */
    officeComposerWindows(workspaceId, sessionId) {
      return [...entries.values()].filter((entry) => !entry.window.isDestroyed() &&
        [...entry.sources.values()].some(context => context.conversation && context.workspaceId === workspaceId && context.sessionId === sessionId && context.tabs.length)).map((entry) => entry.window);
    },
    /** 文件窗口只能操作 Main 已投递到当前窗口的选区身份。 */
    authorizeOfficeReferences(event, input) {
      const entry = resolve(event);
      const context = assertEntryContext(entry, input);
      const ids = input.referenceIds ?? [input.referenceId];
      if (!Array.isArray(ids) ||
          ids.length > 16 || ids.some((id) => !context.officeReferences.has(id) ||
            !context.tabs.some((tab) => tab.documentId === context.officeReferences.get(id)))) throw new Error("选区不属于当前文件窗口");
      return () => {
        if (!registered(entry, context) || ids.some(id => !context.officeReferences.has(id) ||
          !context.tabs.some(tab => tab.documentId === context.officeReferences.get(id)))) throw new Error("文件窗口来源已关闭");
      };
    },
    /** Office IPC 只可访问本窗口已登记模型；返回闭包复核捕获身份，不读取活动标签。 */
    authorizeOfficeTarget(event, input) {
      const entry = resolve(event);
      const tab = entry.tabs.find(tab => tab.documentId === input?.documentId &&
        (input.workspaceId === undefined || tab.source.workspaceId === input.workspaceId));
      if (!tab) throw new Error("文档不属于当前文件窗口");
      return () => { if (entryFor(event.sender) !== entry || !entry.tabs.includes(tab)) throw new Error("文件窗口来源已关闭"); };
    },
    authorizeOfficeContext(event, input) {
      const entry = resolve(event);
      const context = assertEntryContext(entry, input);
      const tab = context.tabs.find(tab => tab.path === input.path);
      if (!tab) throw new Error("文件目标未登记");
      return () => { if (!registered(entry, context) || !entry.tabs.includes(tab)) throw new Error("文件窗口来源已关闭"); };
    },
    /** 文本编辑 IPC 仅信任主窗口顶层或已登记文件窗口中的精确文件。 */
    authorizeFileEditor(event, input, operation = "write") {
      assertTopLevel(event);
      if (typeof input?.workspaceId !== "string" || !input.workspaceId ||
          typeof input?.path !== "string" || !input.path)
        throw new Error("文件编辑目标无效");
      // IPC 没有 tabId；同一 source/path 只要仍登记只读标签，就不能借其他标签或主窗口写入。
      if (operation !== "read" && [...entries.values()].some((entry) => !entry.window.isDestroyed() &&
          entry.tabs.some((tab) => tab.readOnly && tab.source.workspaceId === input.workspaceId && tab.path === input.path)))
        throw new Error("只读文件不允许修改");
      const main = getMainWindow();
      if (main && !main.isDestroyed() && event.sender === main.webContents) return main;
      const entry = resolve(event);
      if (!entry.tabs.some((tab) => tab.source.workspaceId === input.workspaceId && tab.path === input.path))
        throw new Error("文件编辑目标未授权");
      return entry.window;
    },
    /** 草稿正文只发送给可信主窗口及当前仍登记该文件的窗口。 */
    canReceiveFileEditor(window, input) {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      if (window === getMainWindow()) return true;
      const entry = entryFor(window.webContents);
      return entry?.window === window && entry.tabs.some((tab) => tab.source.workspaceId === input?.workspaceId && tab.path === input.path);
    },
    /** 通用 desktop fetch 的文件窗口分支只使用 Main 登记的上下文。 */
    async fetch(event, url, init, fetchImpl) {
      const entry = resolve(event);
      const context = requestContext(entry, url);
      const activePath = context.activePath;
      const tabs = context.tabs;
      if (typeof url === "string" && /\/(?:sessions|session-runs|opencode)(?:\/|\?|$)/.test(new URL(url).pathname)) {
        await refreshConversation(entry, context);
        if (resolve(event) !== entry || !registered(entry, context)) throw new Error("文件窗口已关闭");
      }
      const access = await getAccess();
      // getAccess 期间窗口可能已关闭；不能沿用已注销的登记。
      if (resolve(event) !== entry || !registered(entry, context)) throw new Error("文件窗口已关闭");
      const controller = new AbortController();
      const request = authorizeFileWindowFetch({ ...context, tabs, activePath }, access, url, init);
      if (request.tab && !context.tabs.includes(request.tab)) throw new Error("文件窗口来源已关闭");
      context.requests.add(controller);
      let response;
      try { response = await fetchFileWindowResponse(context, access, url, init, fetchImpl, controller.signal, (signal) => prepareSessionStop(context, signal), request); }
      finally { context.requests.delete(controller); }
      // 响应读取期间关闭窗口也会撤销登记，不能再向原宿主返回文件内容。
      if (resolve(event) !== entry || !registered(entry, context)) throw new Error("文件窗口已关闭");
      return response;
    },
    /** Office 快捷键关闭后同步对应标签。 */
    documentClosed(documentId) {
      for (const entry of entries.values()) {
        const tab = entry.tabs.find((tab) => tab.documentId === documentId);
        if (!tab) continue;
        removeTab(entry, tab);
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
      ipcMain.handle("jugglework:file-window:cloud-uploads", (event, input) => {
        assertTopLevel(event);
        if (event.sender !== getMainWindow()?.webContents) throw new Error("上传结果来源无效");
        if (cloudScope !== input?.scope) {
          cloudLookups.clear(); cloudScope = input?.scope ?? null;
          for (const entry of entries.values()) {
            const stale = entry.tabs.filter(tab => tab.cloudDoc && tab.cloudScope !== cloudScope);
            for (const tab of stale) { cloudDocs?.hide(tab.cloudDoc.instanceId); void cloudDocs?.prepareClose(tab.cloudDoc.instanceId).then(ok => { if (ok) cloudDocs.close(tab.cloudDoc.instanceId); }); }
            for (const tab of stale) removeTab(entry, tab);
          }
        }
        cloudUploads = input?.scope && Array.isArray(input.records) ? input.records.slice(-200).filter(item => {
          try { const url = new URL(item.url); return typeof item.localWorkspaceId === "string" && typeof item.path === "string" && typeof item.tenantId === "string" && ["https:", "http:"].includes(url.protocol) && (!url.search || (url.searchParams.get("tenantId") === item.tenantId && [...url.searchParams.keys()].every(key => key === "tenantId"))) && !url.hash && !url.username && !url.password && /^\/workspace\/[\w-]+\/[\w-]+$/.test(url.pathname); } catch { return false; }
        }) : [];
        for (const entry of entries.values()) publish(entry);
      });
      ipcMain.handle("jugglework:file-window:available", (event) => {
        resolveHost(event);
        return true;
      });
      ipcMain.handle("jugglework:file-window:open", async (event, input) => {
        resolveHost(event);
        let entry = entryFor(event.sender);
        const source = input?.source ?? input;
        // Main 从 exact chat 返回时优先使用已登记 source 的组，不能由 renderer 指定。
        entry ??= [...entries.values()].find(item => {
          const context = item.sources.get(sourceKey(source ?? {}));
          return context && registered(item, context);
        });
        if (entry && !entry.tabs.length && entry.group.kind === "conversation") {
          await addCapturedFile(entry, captureFileOperation(entry, source), input.path);
          return;
        }
        const context = assertEntryContext(entry, source);
        const captured = entry ? captureFileOperation(entry, source) : undefined;
        // TIPS: Renderer 入口仍只能打开已有工作区文件；本机路径必须经过主进程登记。
        await open({
          source: context?.source ?? { workspaceId: source.workspaceId, sessionId: source.sessionId, workspaceRoot: source.workspaceRoot },
          // Renderer 无法选择分组；文件窗口仅复用其 Main 登记分组。
          group: entry?.group,
          captured,
          path: input.path,
          // 仅 resolveHost 确认的主窗口顶层可 seed；文件宿主只沿用已有 entry。
          conversationOptions: event.sender === getMainWindow()?.webContents ? input.conversationOptions : undefined,
        });
      });
      ipcMain.handle("jugglework:file-window:open-cloud", async (event, input) => {
        if (resolveHost(event) !== getMainWindow() || entryFor(event.sender)) throw new Error('Forbidden');
        const doc = input?.document, launch = input?.launch;
        if (!cloudDocs || !doc || !launch || doc.tenantId !== launch.tenantId || launch.presentation?.mode !== 'product' || ![doc.tenantId, doc.workspaceId, doc.docId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('Invalid cloud document');
        const sourceInstanceId = input.sourceInstanceId;
        let captured, verifyCloudSource;
        if (sourceInstanceId !== undefined) {
          if (typeof sourceInstanceId !== "string" || !sourceInstanceId || sourceInstanceId === launch.presentation.instanceId)
            throw new Error("云文档来源无效");
          const entry = [...entries.values()].find(item => item.tabs.some(tab => tab.cloudDoc?.instanceId === sourceInstanceId));
          const original = entry?.tabs.find(tab => tab.cloudDoc?.instanceId === sourceInstanceId);
          if (entry && original) captured = captureFileOperation(entry, original.source);
          const owner = entry?.window ?? getMainWindow();
          // TIPS: 请求新交接凭据期间，原标签可能已换页或关闭。
          verifyCloudSource = () => {
            captured?.verify();
            if (entry && !entry.tabs.includes(original)) throw new Error("云文档来源已变化");
            const current = cloudDocs.documentFor(sourceInstanceId, owner, {
              sourceServerOrigin: input.sourceServerOrigin,
              sourceUserId: input.sourceUserId,
            });
            if (!current || current.tenantId !== doc.tenantId || current.workspaceId !== doc.workspaceId || current.docId !== doc.docId)
              throw new Error("云文档来源已变化");
          };
          verifyCloudSource();
        }
        await open({
          source: captured?.source ?? input.source ?? input,
          path: "",
          cloudDoc: doc,
          launch: { ...launch, sourceServerOrigin: input.sourceServerOrigin, sourceUserId: input.sourceUserId },
          captured,
          verifyCloudSource,
        });
      });
      ipcMain.handle("jugglework:file-window:state", async (event) => {
        const entry = resolve(event);
        await refreshConversation(entry);
        const access = await getAccess();
        if (!access) throw new Error("本地服务不可用");
        const appearance = await getAppearance();
        if (resolve(event) !== entry) throw new Error("文件窗口不存在");
        lookupUpload(entry);
        return {
          ...state(entry),
          baseUrl: access.baseUrl,
          appearance,
        };
      });
      ipcMain.handle("jugglework:file-window:session-subscribe", async (event, input) => {
        const entry = resolve(event);
        const context = contextFor(entry, input);
        await refreshConversation(entry, context);
        if (resolve(event) !== entry || !registered(entry, context)) throw new Error("文件窗口已关闭");
        if (!context.conversation || context.subscriptions.size >= 4) throw new Error("文件窗口会话不可用");
        const id = randomUUID();
        const controller = new AbortController();
        context.subscriptions.set(id, controller);
        const sse = createManagedRuntimeSseClient({ getAccess: async () => {
          const access = await getAccess();
          if (resolve(event) !== entry || !registered(entry, context) || controller.signal.aborted) throw new Error("文件窗口已关闭");
          const url = new URL(access.baseUrl);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("本地服务不可用");
          return access;
        }, fetcher, maxBufferBytes: 1024 * 1024 });
        void sse.subscribe({ workspaceId: context.workspaceId, signal: controller.signal,
          onReconnectGap: () => {},
          onEvent: (raw) => {
            if (controller.signal.aborted || entryFor(event.sender) !== entry || !registered(entry, context)) return;
            const value = fileWindowSessionEvent(context, raw);
            if (value) entry.window.webContents.send("jugglework:file-window:session-event", { id, event: value });
          },
        }).catch(() => {}).finally(() => { controller.abort(); context.subscriptions.delete(id); });
        return id;
      });
      ipcMain.handle("jugglework:file-window:session-unsubscribe", (event, id) => {
        const entry = resolve(event);
        for (const context of entry.sources.values()) {
          context.subscriptions.get(id)?.abort();
          context.subscriptions.delete(id);
        }
      });
      ipcMain.handle("jugglework:file-window:create", async (event, input) => {
        const window = resolveHost(event);
        const entry = entryFor(event.sender);
        if (!entry || entry.tabs.length) assertEntryContext(entry, input);
        return createDocument(window, input);
      });
      ipcMain.handle(
        "jugglework:file-window:action",
        async (event, action, requestedPath) => {
          const entry = resolve(event);
          // TIPS: 打开文件属于窗口操作，活动云文档只提供窗口来源，不是操作目标。
          if (action === "open") {
            if (!requestedPath) {
              await openDialog(entry.window, entry);
            } else if (entry.group.kind === "file-assistant" || entry.local) {
              // 新的本机路径必须经过原生选择器，最近项只接受 Main 已登记的路径。
              if (!recent.some((item) => item.workspaceId === "local" && item.path === requestedPath)) {
                throw new Error("请通过文件选择框打开本机文件");
              }
              await openLocal(requestedPath);
            } else {
              const captured = captureFileOperation(entry, activeTab(entry)?.source);
              await addCapturedFile(entry, captured, requestedPath);
            }
            return;
          }
          const tab = entry.tabs.find(tab => tab.tabId === (requestedPath ?? entry.activeTabId));
          const context = tab && contextFor(entry, tab.source);
          if (action === "open-session") {
            if (!context?.conversation || !openSession) throw new Error("文件窗口会话不可用");
            await openSession({ workspaceId: context.workspaceId, sessionId: context.sessionId, exact: true });
            return;
          }
          if (tab?.cloudDoc && !["select", "close", "share-cloud"].includes(action)) throw new Error("云文档不支持本地文件操作");
          if (action === "share-cloud") {
            const record = tab && uploaded(tab.source.workspaceId, tab.path);
            if (!record) throw new Error("该文件尚未上传到当前组织的云文档");
            await clipboard.writeText(record.url);
            return;
          }
          if (action === "upload-cloud") {
            if (!tab || !uploadCloud) throw new Error("云文档上传不可用");
            await uploadCloud({ workspaceId: tab.source.workspaceId, path: tab.path });
            return;
          }
          if (action === "select") {
            if (tab) {
               if (entry.activeTabId !== tab.tabId && office.confirmFileTarget && !await office.confirmFileTarget(entry.window, {
                 workspaceId: tab.source.workspaceId, sessionId: tab.source.sessionId, path: tab.path, ...(tab.readOnly ? { readOnly: true } : {}),
               }, () => {
                 if (entry.window.isDestroyed() || !entry.tabs.includes(tab)) throw new Error("文件窗口来源已关闭");
               })) return;
              if (!entry.tabs.includes(tab)) return;
              selectTab(entry, tab);
              publish(entry);
            }
            return;
          }
          if (action === "close") {
            if (tab) await closeTab(entry, tab.tabId);
            return;
          }
          if (!tab) return;
          if (action === "reveal") {
            shell.showItemInFolder(
              tab.absolutePath ?? path.join(tab.source.workspaceRoot, tab.path),
            );
            return;
          }
          if (action === "save-copy") {
            if (
              !tab.documentId &&
              !tab.readOnly &&
              fileEditor &&
              !(await fileEditor.prepare(
                { workspaceId: tab.source.workspaceId, path: tab.path },
                entry.window,
              ))
            )
              return;
            if (getOfficeDocumentKind(tab.path))
              await client.postJson(`${base(tab.source)}/prepare-file`, {
                sessionId: tab.source.sessionId,
                path: tab.path,
              });
            await saveArtifactFileCopy({
              workspaceRoot: tab.absolutePath
                ? path.dirname(tab.absolutePath)
                : tab.source.workspaceRoot,
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
