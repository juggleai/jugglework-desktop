import { getOfficeDocumentKind } from "@jugglework/types/office";
import { BrowserWindow, dialog, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveArtifactFileCopy } from "./artifact-file-operations.mjs";

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
 * 独立文件窗口管理器；每个聊天复用一个多标签窗口，共用已有 Server 和 Office 页面。
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
}) {
  const entries = new Map();
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
    tabs: entry.tabs,
    activePath: entry.activePath,
    recent: recent
      .filter((item) => item.workspaceId === entry.workspaceId)
      .map(({ path, name }) => ({ path, name })),
    platform: process.platform,
  });
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
      { workspaceId: entry.workspaceId, path: tab.path, name: tab.name },
      ...recent.filter(
        (item) =>
          item.workspaceId !== entry.workspaceId || item.path !== tab.path,
      ),
    ].slice(0, 30);
    await writeFile(recentPath, JSON.stringify(recent)).catch(() => {});
  };
  const resolve = (event) => {
    const entry = [...entries.values()].find(
      (entry) => entry.window.webContents.id === event.sender.id,
    );
    if (!entry) throw new Error("文件窗口已关闭");
    return entry;
  };
  const addFile = async (entry, relativePath) => {
    const response = await client.getJson(
      `/workspace/${encodeURIComponent(entry.workspaceId)}/files/stat?path=${encodeURIComponent(relativePath)}`,
    );
    if (!response.exists || response.kind !== "file")
      throw new Error("文件不存在");
    let tab = entry.tabs.find((tab) => tab.path === relativePath);
    if (!tab) {
      tab = { path: relativePath, name: path.basename(relativePath) };
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
  const open = async ({ workspaceId, sessionId, path: relativePath }) => {
    await loaded;
    const key = JSON.stringify([workspaceId, sessionId]);
    let entry = entries.get(key);
    if (!entry) {
      const workspaces = await client.getJson("/workspaces");
      const workspace = workspaces.items?.find(
        (item) => item.id === workspaceId && item.workspaceType !== "remote",
      );
      if (!workspace?.path) throw new Error("工作区不可用");
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
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
          plugins: true,
        },
      });
      await dock?.prepareWindow(window);
      entry = {
        window,
        workspaceId,
        sessionId,
        workspaceRoot: workspace.path,
        tabs: [],
        activePath: null,
        closing: false,
        closed: false,
      };
      entries.set(key, entry);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
      window.webContents.on("will-navigate", (event) => event.preventDefault());
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
        entries.delete(key);
        updateDock();
      });
      try {
        await loadWindow(window);
        if (!(await addFile(entry, relativePath))) {
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
    } else if (!(await addFile(entry, relativePath))) return;
    entry.window.show();
    entry.window.focus();
  };
  const openDialog = async (window, { workspaceId, sessionId }) => {
    const entry = [...entries.values()].find(
      (item) => item.window.id === window.id,
    );
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
      const relative = workspaceFilePath(workspaceRoot, absolute);
      if (entry) await addFile(entry, relative);
      else
        window.webContents.send("jugglework:file-window:open-in-panel", {
          workspaceId,
          sessionId,
          path: relative,
        });
    }
  };
  return {
    /** 打开或激活所属聊天的独立文件窗口。 */
    open,
    /** 原生编辑区与标签菜单共用文件选择器，按当前宿主打开到右侧或独立窗口标签。 */
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
    /** 全局文档退出检查通过后销毁窗口，避免服务停止后再次调用保存接口。 */
    dispose() {
      for (const entry of [...entries.values()]) {
        entry.closed = true;
        entry.window.destroy();
      }
      dock?.dispose();
    },
    /** 按渲染进程查找可信文件宿主。 */
    windowFor: (sender) =>
      [...entries.values()].find(
        (entry) => entry.window.webContents.id === sender.id,
      )?.window ?? null,
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
      ipcMain.handle("jugglework:file-window:available", () => true);
      ipcMain.handle("jugglework:file-window:open", async (event, input) => {
        if (
          event.sender.id !== getMainWindow()?.webContents.id &&
          !this.windowFor(event.sender)
        )
          throw new Error("文件窗口宿主不可用");
        await open(input);
      });
      ipcMain.handle("jugglework:file-window:state", async (event) => {
        const entry = resolve(event);
        const access = await getAccess();
        if (!access) throw new Error("本地服务不可用");
        return {
          ...state(entry),
          baseUrl: access.baseUrl,
          token: access.clientToken,
        };
      });
      ipcMain.handle(
        "jugglework:file-window:action",
        async (event, action, requestedPath) => {
          const entry = resolve(event);
          const tab = entry.tabs.find(
            (tab) => tab.path === (requestedPath ?? entry.activePath),
          );
          if (action === "select") {
            if (tab) {
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
              await addFile(entry, requestedPath);
              return;
            }
            await openDialog(entry.window, entry);
            return;
          }
          if (action === "create") {
            const picked = await dialog.showSaveDialog(entry.window, {
              title: "新建 Word 文档",
              defaultPath: path.join(entry.workspaceRoot, "未命名文档.docx"),
              filters: [{ name: "Word 文档", extensions: ["docx"] }],
            });
            if (picked.canceled || !picked.filePath) return;
            const relative = workspaceFilePath(
              entry.workspaceRoot,
              picked.filePath,
            );
            await client.postJson(`${base(entry)}/create`, {
              sessionId: entry.sessionId,
              path: relative,
            });
            await addFile(entry, relative);
            return;
          }
          if (!tab) return;
          if (action === "reveal") {
            shell.showItemInFolder(path.join(entry.workspaceRoot, tab.path));
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
              await client.postJson(
                `${base(entry)}/prepare-file`,
                { sessionId: entry.sessionId, path: tab.path },
              );
            await saveArtifactFileCopy({
              workspaceRoot: entry.workspaceRoot,
              relativePath: tab.path,
              assertDestination: (destination) => client.postJson("/office/check-copy-target", { path: destination }),
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
