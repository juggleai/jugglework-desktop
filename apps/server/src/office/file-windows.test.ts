import { afterEach, expect, mock, test } from "bun:test";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let sequence = 0;
const answers = {
  close: 2,
  open: { canceled: true, filePaths: [] as string[] },
  save: { canceled: true, filePath: "" },
  wait: undefined as ((options: any) => Promise<any>) | undefined,
  openError: null as string | null,
};
const partitions = new Map<string, any>();
const rendererIpc = new EventEmitter();
const rendererBridges: any[] = [];
class FakeContents extends EventEmitter {
  id = ++sequence;
  destroyed = false;
  messages: Array<{ name: string; value: any }> = [];
  loads: string[] = [];
  evaluations: string[] = [];
  focusCalls = 0;
  evaluationResult: unknown = false;
  evaluationGate?: () => Promise<void>;
  async executeJavaScript(source: string) {
    this.evaluations.push(source);
    await this.evaluationGate?.();
    return this.evaluationResult;
  }
  isDestroyed() {
    return this.destroyed;
  }
  getZoomFactor() {
    return 1;
  }
  send(name: string, value: unknown) {
    this.messages.push({ name, value });
  }
  setWindowOpenHandler() {}
  focus() {
    this.focusCalls++;
  }
  async loadURL(url: string) {
    this.loads.push(url);
  }
  async capturePage() {
    return { toDataURL: () => "data:image/png;base64,fixture" };
  }
  close() {
    this.destroyed = true;
  }
}
class FakeWindow extends EventEmitter {
  id = ++sequence;
  webContents = new FakeContents();
  children = new Set<any>();
  destroyed = false;
  title = "";
  focused = false;
  visible = true;
  minimized = false;
  contentView = {
    addChildView: (view: any) => this.children.add(view),
    removeChildView: (view: any) => this.children.delete(view),
  };
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  setTitle(title: string) {
    this.title = title;
  }
  getTitle() {
    return this.title;
  }
  isFocused() {
    return this.focused;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  show() {}
  focus() {
    this.focused = true;
  }
}
class FakeView {
  webContents = new FakeContents();
  visible = false;
  getVisible() {
    return this.visible;
  }
  setBounds() {}
  setVisible(value: boolean) {
    this.visible = value;
  }
}
mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: any) =>
      rendererBridges.push(value),
  },
  ipcRenderer: rendererIpc,
  webUtils: {},
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  dialog: {
    showOpenDialog: async () => answers.open,
    showSaveDialog: async () => answers.save,
    showMessageBox: async (...args: any[]) => {
      const options = args.at(-1);
      return options.signal && answers.wait
        ? answers.wait(options)
        : { response: answers.close };
    },
    showErrorBox() {},
  },
  shell: { showItemInFolder() {} },
  session: {
    fromPartition: (name: string) => {
      if (!partitions.has(name)) {
        const partition = new EventEmitter() as any;
        const handled = new Map();
        partition.webRequest = {
          listener: null,
          onBeforeRequest(listener: any) {
            this.listener = listener;
          },
        };
        partition.protocol = {
          handlers: handled,
          handle(
            scheme: string,
            handler: (request: Request) => Promise<Response>,
          ) {
            if (handled.has(scheme))
              throw new Error("protocol already handled");
            handled.set(scheme, handler);
            if (scheme === "http") partition.protocol.handler = handler;
          },
          unhandle(scheme: string) {
            handled.delete(scheme);
          },
        };
        partitions.set(name, partition);
      }
      return partitions.get(name);
    },
  },
}));
// @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
await import("../../../desktop/electron/preload.mjs");
// @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
await import("../../../desktop/electron/file-window-preload.mjs");
const { createOfficePanel } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/office-panel.mjs");
const { createOfficeResources } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/office-resources.mjs");
const { createFileWindows } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/file-windows.mjs");
const { triggerUpdaterInstall } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/updater.mjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  name = "报告.docx",
  loadWindow = async (_window: FakeWindow) => {},
  target: { platform: NodeJS.Platform; arch: string } = {
    platform: "darwin",
    arch: "arm64",
  },
  resources?: any,
) {
  partitions.clear();
  answers.open = { canceled: true, filePaths: [] };
  answers.openError = null;
  answers.save = { canceled: true, filePath: "" };
  const root = await mkdtemp(join(tmpdir(), "file-window-"));
  roots.push(root);
  const main = new FakeWindow();
  const document = {
    documentId: "od_A",
    pageId: "page_A",
    workspaceId: "ws",
    ownerSessionId: "ses",
    name,
    relativePath: name,
    previewUrl: `http://127.0.0.1:39999/static/${getOfficeDocumentKind(name)}/pc.html?localFilePath=/workspace/${name}`,
    state: "ready",
    dirty: false,
    engineFileId: "actual_A" as string | null,
  };
  const saves: Array<string | null> = [];
  const contexts: unknown[] = [];
  const preparation = {
    error: null as string | null,
    closeError: null as string | null,
    targetError: null as string | null,
    calls: [] as unknown[],
    targets: [] as unknown[],
  };
  const opens: Promise<void>[] = [];
  const transfer = {
    reasons: [null] as Array<"running" | "finalizing" | "saving" | null>,
    checks: 0,
  };
  const client = {
    async getJson(path: string) {
      if (path === "/office/documents")
        return { items: document.state === "closed" ? [] : [{ ...document }] };
      if (path === "/workspaces") return { items: [{ id: "ws", path: root }] };
      if (path.includes("/files/stat")) return { exists: true, kind: "file" };
      if (path.endsWith("/capabilities")) return { available: true };
      if (path.endsWith("/transfer-status")) {
        transfer.checks++;
        return {
          documentId: document.documentId,
          reason:
            transfer.reasons.length > 1
              ? transfer.reasons.shift()
              : transfer.reasons[0],
        };
      }
      return { document: { ...document } };
    },
    async postJson(path: string, _body: unknown) {
      if (path.endsWith("/prepare-file")) {
        preparation.calls.push(_body);
        if (preparation.error) throw new Error(preparation.error);
        return { ok: true };
      }
      if (path === "/office/check-copy-target") {
        preparation.targets.push(_body);
        if (preparation.targetError) throw new Error(preparation.targetError);
        return { ok: true };
      }
      if (path.endsWith("/open") && answers.openError)
        throw Object.assign(new Error("Open failed"), {
          serverCode: answers.openError,
        });
      if (path.endsWith("/context")) contexts.push(_body);
      if (path.endsWith("/save")) {
        saves.push(document.engineFileId);
        document.dirty = false;
      }
      if (path.endsWith("/close")) {
        if (preparation.closeError) throw new Error(preparation.closeError);
        document.state = "closed";
      }
      if (path.endsWith("/page-failed")) {
        document.state = "error";
        document.engineFileId = null;
        document.previewUrl = "";
      }
      if (path.endsWith("/recover")) {
        document.state = "opening";
        document.dirty = false;
        document.engineFileId = "recovered_A";
        document.previewUrl = `http://127.0.0.1:39999/static/${getOfficeDocumentKind(name)}/pc.html?localFilePath=/workspace/${name}`;
      }
      return { document: { ...document } };
    },
  };
  let files: any;
  const dockStates: any[] = [];
  const dock = {
    update: (state: any) => dockStates.push(state),
    prepareWindow: async () => {},
    dispose() {},
  };
  const panel = createOfficePanel({
    ...target,
    getWindow: () => main as any,
    getWindows: () => files.windows(),
    resolveWindow: (sender: any) =>
      sender.id === main.webContents.id ? main : files.windowFor(sender),
    onOpenFile: (window: any, input: any) => {
      const operation = files.openDialog(window, input);
      opens.push(operation);
      return operation;
    },
    client,
    resources:
      resources ??
      createOfficeResources({
        assetsDirectory: fileURLToPath(
          new URL("../../../desktop/resources/office-assets", import.meta.url),
        ),
        cacheDirectory: join(root, "fonts"),
      }),
  });
  files = createFileWindows({
    dock,
    client,
    getAccess: () => ({
      baseUrl: "http://127.0.0.1:1234",
      clientToken: "fixture",
    }),
    office: panel,
    getMainWindow: () => main,
    loadWindow,
    preloadPath: "fixture",
    iconPath: "fixture",
    recentPath: join(root, "recent.json"),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    handle(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
  };
  panel.registerIpc(ipc as any);
  files.registerIpc(ipc as any);
  const call = (name: string, window: FakeWindow, ...args: any[]) =>
    handlers.get(name)!({ sender: window.webContents }, ...args);
  const show = (window: FakeWindow) =>
    call("jugglework:office:show", window, {
      workspaceId: "ws",
      documentId: "od_A",
      bounds: { x: 0, y: 86, width: 1000, height: 700 },
    });
  const state = (window: FakeWindow) =>
    call("jugglework:file-window:state", window);
  const action = (window: FakeWindow, name: string, path?: string) =>
    call("jugglework:file-window:action", window, name, path);
  return {
    main,
    panel,
    files,
    document,
    saves,
    preparation,
    contexts,
    show,
    call,
    state,
    action,
    dockStates,
    transfer,
    opens,
    root,
    client,
  };
}

test("主窗口和独立窗口的实际 preload 均向编辑容器传递布局失效，并能释放订阅", () => {
  expect(rendererBridges).toHaveLength(2);
  for (const bridge of rendererBridges) {
    let refreshes = 0;
    const stop = bridge.office.onLayoutInvalidated(() => {
      refreshes++;
    });
    rendererIpc.emit("jugglework:office:layout-invalidated", {});
    expect(refreshes).toBe(1);
    stop();
    rendererIpc.emit("jugglework:office:layout-invalidated", {});
    expect(refreshes).toBe(1);
  }
  expect(
    rendererIpc.listenerCount("jugglework:office:layout-invalidated"),
  ).toBe(0);
});

test("三平台的两种宿主共用自动字体资源状态和网络边界，必需页面失败释放处理器并同步文档故障", async () => {
  for (const target of [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "win32", arch: "x64" },
  ] as const) {
    for (const standalone of [false, true]) {
      const cache = await mkdtemp(join(tmpdir(), "office-resource-host-"));
      roots.push(cache);
      const resources = createOfficeResources({
        assetsDirectory: fileURLToPath(
          new URL("../../../desktop/resources/office-assets", import.meta.url),
        ),
        cacheDirectory: cache,
      });
      const f = await fixture("数据.csv", undefined, target, resources);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const partition = partitions.get("office-od_A");
      expect(partition.protocol.handlers.size).toBe(2);
      const networkGuard = partition.webRequest.listener;
      expect(typeof networkGuard).toBe("function");
      expect(
        await f.call("jugglework:office:resources", host, {
          documentId: "od_A",
        }),
      ).toEqual({ fontFailures: 0, coreFailures: 0 });
      if (target.arch === "arm64" && !standalone) {
        const view = [...f.main.children][0];
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
        await f.show(f.files.windows()[0]);
        expect([...f.files.windows()[0].children][0]).toBe(view);
        expect(partition.protocol.handlers.size).toBe(2);
        expect(partition.webRequest.listener).toBe(networkGuard);
      }
      partition.fetch = async () => new Response(null, { status: 404 });
      await partition.protocol.handler(
        new Request("http://127.0.0.1:39999/static/sheet/pc.html"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.document.state).toBe("error");
      expect(partition.protocol.handlers.size).toBe(0);
      expect(partition.webRequest.listener).toBeNull();
      f.panel.destroy();
      f.files.dispose();
    }
  }
});

test("两种宿主刷新或宿主渲染崩溃时卸下旧页面，重新展示沿用未保存模型和网络边界", async () => {
  for (const standalone of [false, true]) {
    for (const event of ["did-start-navigation", "render-process-gone"]) {
      const f = await fixture("数据.csv");
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      const guard = partitions.get("office-od_A").webRequest.listener;
      f.document.dirty = true;
      // 同页路由及子框架导航不影响当前文件页。
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture/#/session",
        true,
        true,
      );
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture/frame",
        false,
        false,
      );
      expect(host.children.has(view)).toBe(true);
      host.webContents.emit(event, {}, "http://fixture/", false, true);
      expect(host.children.size).toBe(0);
      expect(view.visible).toBe(false);
      expect(view.webContents.destroyed).toBe(false);
      host.emit("focus");
      expect(host.children.size).toBe(0);
      expect(host.webContents.messages.at(-1)?.name).toBe(
        "jugglework:office:layout-invalidated",
      );
      await f.show(host);
      expect([...host.children][0]).toBe(view);
      expect(view.webContents.loads).toHaveLength(1);
      expect(f.document.dirty).toBe(true);
      expect(f.document.engineFileId).toBe("actual_A");
      expect(f.saves).toHaveLength(0);
      expect(partitions.get("office-od_A").webRequest.listener).toBe(guard);
      f.panel.destroy();
      expect(host.webContents.listenerCount("did-start-navigation")).toBe(0);
      expect(host.listenerCount("focus")).toBe(0);
      f.files.dispose();
    }
  }
});

test("宿主隐藏或最小化后不使用旧坐标恢复，只有当前面板重新确认后才显示原页面", async () => {
  for (const event of ["hide", "minimize"]) {
    const f = await fixture();
    await f.show(f.main);
    const view = [...f.main.children][0];
    f.document.dirty = true;
    f.main.visible = event !== "hide";
    f.main.minimized = event === "minimize";
    f.main.emit(event);
    expect(f.main.children.size).toBe(0);
    await f.show(f.main);
    expect(f.main.children.size).toBe(0);
    f.main.visible = true;
    f.main.minimized = false;
    f.main.emit(event === "hide" ? "show" : "restore");
    expect(f.main.children.size).toBe(0);
    await f.show(f.main);
    expect([...f.main.children][0]).toBe(view);
    f.main.emit("focus");
    expect([...f.main.children][0]).toBe(view);
    await f.show(f.main);
    expect([...f.main.children][0]).toBe(view);
    expect(f.document.dirty).toBe(true);
    f.panel.destroy();
  }
});

test.each([
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const)(
  "$platform-$arch 两种宿主普通聚焦保留有效编辑视图，重测布局不抢聊天焦点",
  async (target) => {
    for (const standalone of [false, true]) {
      const f = await fixture("数据.xlsx", undefined, target);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.xlsx",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      // TIPS: removeChildView 会丢失真实 Electron 的输入焦点，不能在 mock 中让卸载后自动恢复掩盖回归。
      let removals = 0;
      const remove = host.contentView.removeChildView;
      host.contentView.removeChildView = (child: any) => {
        removals++;
        remove(child);
      };
      const initialFocusCalls = view.webContents.focusCalls;
      for (const event of ["show", "restore", "focus"]) {
        host.emit(event);
        expect([...host.children][0]).toBe(view);
        expect(view.visible).toBe(true);
        expect(host.webContents.messages.at(-1)?.name).toBe(
          "jugglework:office:layout-invalidated",
        );
        await f.show(host);
        expect(view.webContents.focusCalls).toBe(initialFocusCalls);
      }
      expect(removals).toBe(0);
      expect(view.webContents.loads).toHaveLength(1);
      f.panel.destroy();
      f.files.dispose();
    }
  },
);

test.each([
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const)(
  "$platform-$arch 恢复原编辑焦点，用户转向宿主输入后不再接管",
  async (target) => {
    for (const standalone of [false, true]) {
      const f = await fixture("数据.xlsx", undefined, target);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.xlsx",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      host.focused = true;
      view.webContents.emit("focus");
      host.emit("blur");
      // Electron 切回窗口时可以先聚焦宿主，再通知 BrowserWindow；不能误判为用户点击聊天。
      host.webContents.emit("focus");
      host.emit("focus");
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(1);
      host.webContents.emit("focus");
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(1);

      for (const [event, input] of [
        ["before-mouse-event", { type: "mouseDown" }],
        ["before-input-event", { type: "keyDown" }],
      ] as const) {
        view.webContents.emit("focus");
        host.emit("blur");
        host.webContents.emit(event, {}, input);
        host.emit("focus");
        await f.show(host);
        expect(view.webContents.focusCalls).toBe(1);
      }
      view.webContents.emit("focus");
      host.emit("blur");
      host.minimized = true;
      host.emit("minimize");
      // 隐藏页面的渲染层也会上报 hide，不能清掉窗口生命周期已保存的输入目标。
      await f.call("jugglework:office:hide", host, "od_A", false);
      host.minimized = false;
      host.emit("restore");
      host.webContents.emit("focus");
      host.emit("focus");
      await f.show(host);
      expect([...host.children][0]).toBe(view);
      expect(view.webContents.focusCalls).toBe(2);
      // 原页面关闭或导航后不保留待恢复焦点，新的聊天页面不能被旧文档接管。
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture",
        false,
        true,
      );
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(2);
      f.panel.destroy();
      expect(host.listenerCount("blur")).toBe(0);
      expect(host.webContents.listenerCount("focus")).toBe(0);
      expect(host.webContents.listenerCount("before-input-event")).toBe(0);
      expect(host.webContents.listenerCount("before-mouse-event")).toBe(0);
      f.files.dispose();
    }
  },
);

test("显式激活等待期间用户转向聊天输入，旧请求不能抢回焦点", async () => {
  const f = await fixture();
  f.main.focused = true;
  const original = f.client.postJson;
  const context = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  f.client.postJson = async (path: string, body: unknown) => {
    if (path.endsWith("/context")) {
      requested.resolve();
      await context.promise;
    }
    return original(path, body);
  };
  const showing = f.call("jugglework:office:show", f.main, {
    workspaceId: "ws",
    documentId: "od_A",
    activate: true,
    bounds: { x: 0, y: 86, width: 1000, height: 700 },
  });
  await requested.promise;
  const view = [...f.main.children][0];
  f.main.webContents.emit("before-input-event", {}, { type: "keyDown" });
  context.resolve();
  await showing;
  expect(view.visible).toBe(true);
  expect(view.webContents.focusCalls).toBe(0);
  f.panel.destroy();
});

test("刷新、隐藏或重新聚焦发生在文档查询期间，旧 show 返回不能重新挂载视图", async () => {
  for (const event of ["did-start-navigation", "hide", "focus"]) {
    const f = await fixture();
    let complete!: (value: any) => void;
    const getJson = f.client.getJson;
    f.client.getJson = (path: string) =>
      path.endsWith("/od_A")
        ? new Promise<any>((resolve) => {
            complete = resolve;
          })
        : getJson(path);
    const pending = f.show(f.main);
    if (event === "hide" || event === "focus") f.main.emit(event);
    else f.main.webContents.emit(event, {}, "http://fixture", false, true);
    complete({ document: { ...f.document } });
    await pending;
    expect(f.main.children.size).toBe(0);
    f.client.getJson = getJson;
    await f.show(f.main);
    expect(f.main.children.size).toBe(1);
    f.panel.destroy();
  }
});

test("四种 Office 格式独立窗口另存共用任务准备及目标保护，拒绝后不保存或复制", async () => {
  for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
    const f = await fixture(name);
    const destination = join(f.root, "copy-" + name);
    await writeFile(join(f.root, name), "saved source");
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: name });
    const window = f.files.windows()[0]!;
    for (const reason of ["任务运行中", "交付尚未完成"]) {
      f.preparation.error = reason;
      await expect(f.action(window, "save-copy")).rejects.toThrow(reason);
      await expect(access(destination)).rejects.toThrow();
      expect(f.saves).toEqual([]);
      expect(f.preparation.targets).toEqual([]);
    }
    f.preparation.error = null;
    answers.save = { canceled: false, filePath: destination };
    f.preparation.targetError = "目标文档仍在编辑";
    await expect(f.action(window, "save-copy")).rejects.toThrow("仍在编辑");
    await expect(access(destination)).rejects.toThrow();
    f.preparation.targetError = null;
    await f.action(window, "save-copy");
    expect(f.preparation.calls).toEqual(
      Array(4).fill({ sessionId: "ses", path: name }),
    );
    expect(f.preparation.targets).toEqual([
      { path: destination },
      { path: destination },
    ]);
    expect(await readFile(destination, "utf8")).toBe("saved source");
  }
});

for (const target of [
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
] as const) {
  test(`${target.platform}-${target.arch} 首次独立打开可用，跨窗口迁移保留原页面并提示保存关闭`, async () => {
    for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
      const f = await fixture(name, undefined, target);
      await f.show(f.main);
      const original = [...f.main.children][0];
      f.document.dirty = true;
      await expect(
        f.files.open({ workspaceId: "ws", sessionId: "ses", path: name }),
      ).rejects.toThrow("请先保存并关闭文档");
      expect(f.files.windows()).toHaveLength(0);
      expect([...f.main.children]).toEqual([original]);
      expect(original.visible).toBe(true);
      expect(original.webContents.loads).toHaveLength(1);
      expect(f.document).toMatchObject({
        dirty: true,
        engineFileId: "actual_A",
        state: "ready",
      });
      expect(f.transfer.checks).toBe(0);
      expect(f.saves).toEqual([]);

      const fresh = await fixture(name, undefined, target);
      await fresh.files.open({
        workspaceId: "ws",
        sessionId: "ses",
        path: name,
      });
      const window = fresh.files.windows()[0];
      expect(await fresh.show(window)).toEqual({ here: true });
      const page = [...window.children][0];
      await expect(
        fresh.call("jugglework:office:show", fresh.main, {
          workspaceId: "ws",
          documentId: "od_A",
          activate: true,
          bounds: { x: 0, y: 30, width: 600, height: 800 },
        }),
      ).rejects.toThrow("请先保存并关闭文档");
      expect([...window.children]).toEqual([page]);
      expect(() => fresh.panel.assign("od_A", fresh.main)).toThrow(
        "请先保存并关闭文档",
      );
      expect(fresh.saves).toEqual([]);
    }
  });
}

test("透视表只读文件可在独立窗口打开，不迁移原生模型；其他打开错误仍抛出", async () => {
  const f = await fixture("透视表.xlsx");
  answers.openError = "office_readonly_required";
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "透视表.xlsx",
  });
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs).toEqual([
    { path: "透视表.xlsx", name: "透视表.xlsx", readOnly: true },
  ]);
  expect(window.children.size).toBe(0);
  expect(f.saves).toEqual([]);
  answers.openError = "office_document_in_use";
  await expect(
    f.files.open({ workspaceId: "ws", sessionId: "ses", path: "其他.xlsx" }),
  ).rejects.toThrow("Open failed");
  expect((await f.state(window)).tabs).toHaveLength(1);
});

test("实时选区只读取所属可见页面，隐藏、旧代次及读取中销毁均不返回旧坐标", async () => {
  const f = await fixture("客户.csv");
  await f.show(f.main);
  const view = [...f.main.children][0] as FakeView;
  const input = {
    workspaceId: "ws",
    documentId: "od_A",
    pageId: f.document.pageId,
  };
  const value = { sheetId: "sheet_A", ranges: [] };
  view.webContents.evaluationResult = value;
  expect(await f.panel.readSelection(input)).toEqual(value);
  expect(
    await f.panel.readSelection({ ...input, workspaceId: "other" }),
  ).toBeNull();
  expect(await f.panel.readSelection({ ...input, pageId: "old" })).toBeNull();
  await f.call("jugglework:office:hide", f.main, "od_A");
  expect(await f.panel.readSelection(input)).toBeNull();
  await f.show(f.main);
  let release!: () => void;
  view.webContents.evaluationGate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = f.panel.readSelection(input);
  f.panel.destroy();
  release();
  expect(await pending).toBeNull();
});

test("打开独立窗口迁移同一存活页面，主面板不能抢回或隐藏新窗口的页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(f.main.children.size).toBe(0);
  expect([...window.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(f.saves).toEqual([]);
  expect(await f.show(f.main)).toEqual({ here: false });
  await f.show(window);
  await f.call("jugglework:office:hide", f.main, "od_A");
  expect(original.visible).toBe(true);
  expect(f.document.dirty).toBe(true);
});

test("运行中取消等待不迁移页面，清理空窗口并保留 dirty 内容", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  f.transfer.reasons = ["running"];
  answers.wait = async () => ({ response: 0 });
  try {
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    expect(f.files.windows()).toHaveLength(0);
    expect([...f.main.children]).toEqual([original]);
    expect(original.visible).toBe(true);
    expect(f.document.dirty).toBe(true);
    expect(f.transfer.checks).toBe(1);
    expect(f.saves).toEqual([]);
  } finally {
    answers.wait = undefined;
  }
});

test("运行和交付结束后迁移同一页面，等待期间保留原宿主", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.transfer.reasons = ["running", "finalizing", null];
  answers.wait = async (options) => {
    expect([...f.main.children]).toEqual([original]);
    return new Promise((resolve) =>
      options.signal.addEventListener("abort", () => resolve({ response: 0 }), {
        once: true,
      }),
    );
  };
  try {
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    expect(f.transfer.checks).toBe(3);
    expect([...f.files.windows()[0].children]).toEqual([original]);
    expect(original.webContents.loads).toHaveLength(1);
    expect(f.saves).toEqual([]);
  } finally {
    answers.wait = undefined;
  }
});

test("输入法组合中阻止原生文档快捷键且不执行宿主动作，组合结束后仍能保存", async () => {
  const f = await fixture();
  await f.show(f.main);
  const contents = [...f.main.children][0].webContents;
  const prevented: string[] = [];
  for (const key of ["s", "w", "o"])
    contents.emit(
      "before-input-event",
      {
        preventDefault() {
          prevented.push(key);
        },
      },
      { meta: true, isComposing: true, type: "keyDown", key },
    );
  expect(prevented).toEqual(["s", "w", "o"]);
  expect(f.saves).toEqual([]);
  expect(f.opens).toEqual([]);
  expect(f.document.state).toBe("ready");
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, isComposing: false, type: "keyDown", key: "s" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toHaveLength(1);
});

test("CSV 独立窗口与 Word 共用 Office 页面、模型迁移及保存", async () => {
  const f = await fixture("客户.csv");
  await f.show(f.main);
  const original = [...f.main.children][0];
  expect(original.webContents.loads[0]).toContain("/static/sheet/pc.html");
  expect(await f.call("jugglework:file-window:available", f.main)).toBe(true);
  await f.call("jugglework:file-window:open", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    path: "客户.csv",
  });
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs).toEqual([
    { path: "客户.csv", name: "客户.csv", documentId: "od_A" },
  ]);
  expect([...window.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(await f.show(f.main)).toEqual({ here: false });
  f.document.dirty = true;
  original.webContents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, type: "keyDown", key: "s" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual(["actual_A"]);
});

test("重挂失败恢复原宿主、可见性及页面，后续仍可迁移同一未保存模型", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  const target = new FakeWindow();
  const attach = target.contentView.addChildView;
  target.contentView.addChildView = () => {
    throw new Error("attach failed");
  };
  expect(() => f.panel.assign("od_A", target as any)).toThrow("attach failed");
  expect([...f.main.children]).toEqual([original]);
  expect(original.visible).toBe(true);
  expect(await f.show(f.main)).toEqual({ here: true });
  expect(original.webContents.loads).toHaveLength(1);
  expect(f.document.dirty).toBe(true);
  expect(f.saves).toEqual([]);
  target.contentView.addChildView = attach;
  f.panel.assign("od_A", target as any);
  expect([...target.children]).toEqual([original]);
  expect(await f.show(f.main)).toEqual({ here: false });
});

test("文件窗口页面准备失败时不迁移原生页，移除失败窗口并保留原宿主编辑", async () => {
  const f = await fixture("报告.docx", async () => {
    throw new Error("window load failed");
  });
  await f.show(f.main);
  const original = [...f.main.children][0];
  await expect(
    f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" }),
  ).rejects.toThrow("window load failed");
  expect(f.files.windows()).toHaveLength(0);
  expect([...f.main.children]).toEqual([original]);
  expect(original.visible).toBe(true);
  expect(original.webContents.loads).toHaveLength(1);
});

test("故障恢复取消保留页面，确认后两处收到同一文档身份并加载新页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  f.document.state = "error";
  f.document.dirty = true;
  answers.close = 1;
  expect(
    await f.call("jugglework:office:recover", window, {
      workspaceId: "ws",
      documentId: "od_A",
    }),
  ).toBeNull();
  expect(original.webContents.destroyed).toBe(false);
  expect(f.document.dirty).toBe(true);
  answers.close = 0;
  try {
    expect(
      await f.call("jugglework:office:recover", window, {
        workspaceId: "ws",
        documentId: "od_A",
      }),
    ).toMatchObject({ documentId: "od_A", state: "opening" });
    expect(original.webContents.destroyed).toBe(true);
    for (const host of [f.main, window])
      expect(
        host.webContents.messages.findLast(
          (message: any) => message.name === "jugglework:office:document",
        )?.value,
      ).toMatchObject({ documentId: "od_A", state: "opening" });
    expect((await f.state(window)).tabs[0].documentId).toBe("od_A");
    await f.show(window);
    const replacement = [...window.children][0];
    expect(replacement).not.toBe(original);
    original.webContents.emit("render-process-gone");
    expect([...window.children][0]).toBe(replacement);
    expect(replacement.webContents.destroyed).toBe(false);
    expect(await f.show(f.main)).toEqual({ here: false });
  } finally {
    answers.close = 2;
  }
});

for (const independent of [false, true])
  test(`原生页面崩溃同步两处故障状态，确认恢复复用文档标签且可重新注册协议 (${independent})`, async () => {
    const f = await fixture();
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    const window = f.files.windows()[0];
    if (!independent) f.panel.assign("od_A", f.main as any);
    const host = independent ? window : f.main;
    await f.show(host);
    const original = [...host.children][0];
    original.webContents.emit("render-process-gone");
    await Promise.resolve();
    await Promise.resolve();
    expect(host.children.size).toBe(0);
    for (const target of [f.main, window])
      expect(
        target.webContents.messages.findLast(
          (item: any) => item.name === "jugglework:office:document",
        )?.value,
      ).toMatchObject({
        state: "error",
        documentId: "od_A",
        engineFileId: null,
      });
    expect((await f.state(window)).tabs[0].documentId).toBe("od_A");
    answers.close = 1;
    expect(
      await f.call("jugglework:office:recover", host, {
        workspaceId: "ws",
        documentId: "od_A",
      }),
    ).toBeNull();
    expect(f.document.state).toBe("error");
    answers.close = 0;
    try {
      await f.call("jugglework:office:recover", host, {
        workspaceId: "ws",
        documentId: "od_A",
      });
      expect(await f.show(host)).toEqual({ here: true });
      expect([...host.children][0]).not.toBe(original);
      original.webContents.emit("render-process-gone");
      expect(host.children.size).toBe(1);
    } finally {
      answers.close = 2;
    }
  });

test("页面加载失败同样转为可恢复故障，不能隐藏空白页后仍声称 ready", async () => {
  const f = await fixture();
  const load = FakeContents.prototype.loadURL;
  FakeContents.prototype.loadURL = async () => {
    throw new Error("load failed");
  };
  try {
    await f.show(f.main);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.document.state).toBe("error");
    expect(f.main.children.size).toBe(0);
    expect(f.main.webContents.messages.at(-1)).toMatchObject({
      name: "jugglework:office:document",
      value: { state: "error" },
    });
  } finally {
    FakeContents.prototype.loadURL = load;
  }
});

test("菜单使用页面快照遮挡原生视图，恢复后复用相同页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  const snapshot = await f.call("jugglework:office:hide", f.main, "od_A", true);
  expect(snapshot).toStartWith("data:image/png");
  expect(original.visible).toBe(false);
  expect(f.main.children.size).toBe(0);
  await f.show(f.main);
  expect(original.visible).toBe(true);
  expect(f.main.children.size).toBe(1);
  expect(original.webContents.loads).toHaveLength(1);
});

test("两处显示同一 Word 内容，显式点击可交接编辑页面而后台更新不能抢占", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(await f.show(f.main)).toEqual({ here: false });
  expect(
    await f.call("jugglework:office:snapshot", f.main, "od_A"),
  ).toStartWith("data:image/png");
  expect(
    await f.call("jugglework:office:show", f.main, {
      workspaceId: "ws",
      documentId: "od_A",
      activate: true,
      bounds: { x: 0, y: 30, width: 600, height: 800 },
    }),
  ).toEqual({ here: true });
  expect([...f.main.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(await f.show(window)).toEqual({ here: false });
  expect(f.document.engineFileId).toBe("actual_A");
});

test("重复打开激活已有窗口，关闭一个文件保留其他标签，最近文件不保存令牌", async () => {
  const f = await fixture();
  for (const path of ["报告.docx", "说明.md", "报告.docx"])
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path });
  expect(f.files.windows()).toHaveLength(1);
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
  await f.action(window, "close", "说明.md");
  const state = await f.state(window);
  expect(state.tabs.map((tab: any) => tab.path)).toEqual(["报告.docx"]);
  expect(state.activePath).toBe("报告.docx");
  expect(window.title).toBe("JuggleWork 文件浏览器");
  expect(state.recent.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
});

test("关闭全部 tab 后保留文件浏览器主页和窗口归属，再打开复用原窗口", async () => {
  const f = await fixture();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" });
  const window = f.files.windows()[0];
  await f.action(window, "close", "报告.docx");
  const home = await f.state(window);
  expect(home.tabs).toEqual([]);
  expect(home.activePath).toBeNull();
  expect(window.title).toBe("JuggleWork 文件浏览器");
  expect(window.isDestroyed()).toBe(false);
  // TIPS: macOS 菜单按宿主窗口归属命名，空白主页仍是文件窗口，不能按 tab 数量降级成聊天窗口。
  expect(f.files.windowFor(window.webContents)).toBe(window);
  expect(f.files.windowFor(f.main.webContents)).toBeNull();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "说明.md" });
  expect(f.files.windows()).toEqual([window]);
  expect((await f.state(window)).activePath).toBe("说明.md");
});

test("原生编辑区的打开快捷键按当前宿主复用右侧或独立窗口标签，取消不改变文档", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  const pressOpen = async () => {
    original.webContents.emit(
      "before-input-event",
      { preventDefault() {} },
      {
        meta: true,
        type: "keyDown",
        key: "o",
      },
    );
    await Promise.all(f.opens);
  };
  await pressOpen();
  expect(f.main.webContents.messages).toEqual([]);
  answers.open = { canceled: false, filePaths: [join(f.root, "说明.md")] };
  await pressOpen();
  expect(f.main.webContents.messages.at(-1)).toMatchObject({
    name: "jugglework:file-window:open-in-panel",
    value: { workspaceId: "ws", sessionId: "ses", path: "说明.md" },
  });
  expect(f.files.windows()).toHaveLength(0);
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  await pressOpen();
  expect((await f.state(window)).tabs.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
  expect((await f.state(window)).activePath).toBe("说明.md");
  expect([...window.children][0]).toBe(original);
  expect(f.document.state).toBe("ready");
  expect(f.saves).toEqual([]);
});

test("dirty 文档取消关闭保留标签与页面，保存并关闭后才移除", async () => {
  const f = await fixture();
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  await f.show(window);
  f.document.dirty = true;
  answers.close = 2;
  await f.action(window, "close", "报告.docx");
  expect((await f.state(window)).tabs).toHaveLength(1);
  expect(window.children.size).toBe(1);
  answers.close = 0;
  await f.action(window, "close", "报告.docx");
  expect((await f.state(window)).tabs).toHaveLength(0);
  expect(window.children.size).toBe(0);
  answers.close = 2;
});

test("Dock 显示真实标题、激活原窗口，取消退出保留入口，清理窗口不重复调用已停止的服务", async () => {
  const f = await fixture();
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(f.dockStates.at(-1)).toEqual([{ id: window.id, title: "报告.docx" }]);
  window.focused = false;
  f.files.activate(window.id);
  expect(window.focused).toBe(true);
  f.document.dirty = true;
  answers.close = 2;
  expect(await f.files.closeAll()).toBe(false);
  expect(f.files.windows()).toHaveLength(1);
  expect(window.destroyed).toBe(false);
  f.files.dispose();
  expect(f.files.windows()).toHaveLength(0);
  expect(f.dockStates.at(-1)).toEqual([]);
  expect(f.saves).toEqual([]);
});

for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
  test(`${name} 更新退出取消或保存失败保留页面，成功关闭后才启动安装器`, async () => {
    const f = await fixture(name);
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: name });
    const window = f.files.windows()[0]!;
    await f.show(window);
    const page = [...window.children][0];
    f.document.dirty = true;
    const calls: string[] = [];
    const install = () =>
      triggerUpdaterInstall(
        { quitAndInstall: () => calls.push("install") },
        async () => {
          if (!(await f.panel.prepareQuit())) throw new Error("已取消更新");
          f.files.dispose();
          calls.push("runtime:stop");
        },
      );
    try {
      answers.close = 2;
      await expect(install()).rejects.toThrow("已取消更新");
      answers.close = 0;
      f.preparation.closeError = "文档保存失败";
      await expect(install()).rejects.toThrow("文档保存失败");
      expect(calls).toEqual([]);
      expect(f.files.windows()).toEqual([window]);
      expect([...window.children]).toEqual([page]);
      expect(page.webContents.isDestroyed()).toBe(false);
      expect(f.document).toMatchObject({ state: "ready", dirty: true });
      f.preparation.closeError = null;
      await install();
      expect(f.document.state).toBe("closed");
      expect(page.webContents.isDestroyed()).toBe(true);
      expect(f.files.windows()).toEqual([]);
      expect(calls).toEqual(["runtime:stop", "install"]);
    } finally {
      answers.close = 2;
    }
  });
}

for (const name of ["预算.xlsx", "汇报.pptx"]) {
  test(`${name} 的独立窗口复用对应原生页面与模型，迁移不重新加载`, async () => {
    const f = await fixture(name);
    await f.show(f.main);
    const original = [...f.main.children][0];
    expect(original.webContents.loads[0]).toContain(
      `/static/${getOfficeDocumentKind(name)}/pc.html`,
    );
    await f.call("jugglework:file-window:open", f.main, {
      workspaceId: "ws",
      sessionId: "ses",
      path: name,
    });
    const window = f.files.windows()[0];
    expect((await f.state(window)).tabs).toEqual([
      { path: name, name, documentId: "od_A" },
    ]);
    expect([...window.children][0]).toBe(original);
    expect(original.webContents.loads).toHaveLength(1);
    expect(await f.show(f.main)).toEqual({ here: false });
  });
}

test("保存页面确认绑定 workspace 和 pageId，等待中页面失效不能继续确认", async () => {
  const f = await fixture();
  await f.show(f.main);
  const view = [...f.main.children][0];
  await expect(
    f.panel.prepareSave({
      workspaceId: "other",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("页面已失效");
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "old_page",
    }),
  ).rejects.toThrow("页面已失效");
  expect(view.webContents.evaluations).toEqual([]);
  await f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
  expect(view.webContents.evaluations).toHaveLength(1);
  let release!: () => void;
  view.webContents.evaluationGate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  f.panel.destroy();
  release();
  await expect(pending).rejects.toThrow("页面已失效");
});

test.each(["输入.csv", "输入.xlsx"])(
  "%s 保存采用表格提交契约",
  async (name) => {
    const f = await fixture(name);
    await f.show(f.main);
    await f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    });
    const view = [...f.main.children][0];
    expect(view.webContents.evaluations[0]).toContain("waitForSheetPageCommit");
    expect(view.webContents.evaluations[0]).not.toContain(
      "waitForWordPageCommit",
    );
  },
);

test("PPT 保存先确认文字与原生提交，历史提交失败不能被 SDK 的已结束队列掩盖", async () => {
  const f = await fixture("演示.pptx");
  await f.show(f.main);
  const partition = partitions.get("office-od_A");
  partition.fetch = async () =>
    Response.json({ code: -1, message: "原生提交失败" });
  const response = await partition.protocol.handler(
    new Request("http://127.0.0.1:39999/localapi/commitrevision", {
      method: "POST",
    }),
  );
  expect(await response.json()).toEqual({ code: -1, message: "原生提交失败" });
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("原生提交失败");
  const view = [...f.main.children][0];
  expect(view.webContents.evaluations[0]).toContain("waitForSlidePageCommit");
  partition.fetch = async () => Response.json({ code: 0 });
  await partition.protocol.handler(
    new Request("http://127.0.0.1:39999/localapi/commitrevision", {
      method: "POST",
    }),
  );
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("原生提交失败");
  expect(f.saves).toEqual([]);
  f.panel.destroy();
  await f.show(f.main);
  await f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
});

test("PPT 文档快捷键按页面组合状态决定执行，原生缺少标志时仍不保存或关闭", async () => {
  const f = await fixture("演示.pptx");
  await f.show(f.main);
  const contents = [...f.main.children][0].webContents;
  contents.emit("dom-ready");
  expect(contents.evaluations[0]).toContain("installSlideKeyboardGuard");
  contents.evaluationResult = true;
  for (const key of ["s", "w", "o"])
    contents.emit(
      "before-input-event",
      { preventDefault() {} },
      { meta: true, key, type: "keyDown", isComposing: false },
    );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual([]);
  expect(f.opens).toEqual([]);
  expect(f.document.state).toBe("ready");
  contents.evaluationResult = undefined;
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, key: "s", type: "keyDown" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual([]);
  contents.evaluationResult = false;
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, key: "s", type: "keyDown" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toHaveLength(1);
});

test("系统外部文件复用一个多标签窗口，最近路径重新登记，关闭取消保留模型且副本使用原文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-file-window-"));
  roots.push(root);
  const source = join(root, "外部 预算.csv");
  await writeFile(source, "名称,金额\n预算,20\n");
  const main = new FakeWindow();
  const requests: string[] = [];
  const registrations: string[] = [];
  let canClose = false;
  const windows = createFileWindows({
    client: {
      async getJson(url: string) {
        requests.push(url);
        if (url.includes("/files/stat")) return { exists: true, kind: "file" };
        if (url.endsWith("/capabilities")) return { available: true };
        throw new Error(`不应读取工作区: ${url}`);
      },
      async postJson(url: string, body: any) {
        requests.push(url);
        return { document: { documentId: body.path, state: "opening" } };
      },
    },
    registerLocalFile: async (absolute: string) => {
      registrations.push(absolute);
      return {
        workspaceId: "local-context",
        sessionId: "file-browser",
        path: `id/${absolute.split("/").at(-1)}`,
        local: true,
        absolutePath: absolute,
      };
    },
    getAccess: async () => ({
      baseUrl: "http://127.0.0.1:1234",
      clientToken: "fixture",
    }),
    office: { transfer: async () => true, close: async () => canClose },
    getMainWindow: () => main,
    loadWindow: async () => {},
    preloadPath: "fixture",
    iconPath: "fixture",
    recentPath: join(root, "recent.json"),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  windows.registerIpc({
    handle: (name: string, handler: any) => handlers.set(name, handler),
  });
  await windows.openLocal(source);
  await windows.openLocal(source);
  const window = windows.windows()[0];
  const call = (name: string, ...args: any[]) =>
    handlers.get(name)!({ sender: window.webContents }, ...args);
  expect(windows.windows()).toHaveLength(1);
  let state = await call("jugglework:file-window:state");
  expect(state.local).toBe(true);
  expect(state.workspaceRoot).toBe("");
  expect(state.tabs).toHaveLength(1);
  expect(state.recent[0].path).toBe(source);
  await call("jugglework:file-window:action", "open", source);
  expect(registrations).toHaveLength(3);
  const copy = join(root, "副本.csv");
  answers.save = { canceled: false, filePath: copy };
  await call("jugglework:file-window:action", "save-copy");
  expect(await readFile(copy, "utf8")).toBe(await readFile(source, "utf8"));
  await windows.openLocal(join(root, "报告.docx"));
  state = await call("jugglework:file-window:state");
  expect(state.tabs).toHaveLength(2);
  expect(await windows.closeAll()).toBe(false);
  expect(window.isDestroyed()).toBe(false);
  canClose = true;
  expect(await windows.closeAll()).toBe(true);
  expect(requests).not.toContain("/workspaces");
});
