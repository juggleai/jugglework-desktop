import { fileContextDeployment } from "./file-window-desktop-context.mjs";
import { mainProcessFetchResponse } from "./main-fetch.mjs";

/**
 * 无主窗口时使用既有主分区加载专用初始化页；不装配会话、队列或主窗口布局。
 * @param {{BrowserWindow: any, ipcMain: any, preload: string, load: (window: any) => Promise<void>, bootstrap: () => Promise<any>, fetcher: typeof fetch, apply: (context: any) => Promise<void>, fallback: () => {lang: string, theme: string}}} options
 */
export function createFileContextBootstrap(options) {
  let active = null, initialized = null;
  const assertSender = (event) => {
    if (!active || active.window.isDestroyed() || event.sender !== active.window.webContents || event.senderFrame !== event.sender.mainFrame)
      throw new Error("文件初始化来源不可用");
    return active;
  };
  options.ipcMain.handle("jugglework:file-context:request", async (event, command, ...args) => {
    assertSender(event);
    const boot = await options.bootstrap();
    assertSender(event);
    if (command === "getDesktopBootstrapConfig") return boot;
    if (command !== "__fetch") throw new Error("文件初始化操作不可用");
    const [raw, init = {}] = args;
    const base = fileContextDeployment(boot.baseUrl), url = new URL(raw);
    const allowed = ["/v1/me", "/v1/me/orgs", "/v1/me/desktop-config"].map((path) => `${base}/jwork/api${path}`);
    if (!allowed.includes(url.href) || init.method !== "GET" || init.body || init.bodyBytes) throw new Error("文件初始化请求不可用");
    const response = await options.fetcher(url.href, { method: "GET", headers: init.headers, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000) });
    assertSender(event);
    return mainProcessFetchResponse(response);
  });
  options.ipcMain.handle("jugglework:file-context:complete", async (event, result) => {
    const task = assertSender(event);
    if (result?.context) await options.apply(result.context);
    const fallback = options.fallback(), appearance = result?.appearance;
    const languages = new Set(["en", "ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es", "ru"]);
    task.resolve({ lang: languages.has(appearance?.lang) ? appearance.lang : fallback.lang,
      theme: appearance?.theme === "dark" || appearance?.theme === "light" ? appearance.theme : fallback.theme });
  });
  return {
    /** 同一进程只初始化一次；失败允许下次显式重试，页面结束即释放。 */
    initialize() {
      if (initialized) return initialized;
      const pending = (async () => {
        const window = new options.BrowserWindow({ show: false, webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        let timer;
        try {
          const result = new Promise((resolve, reject) => {
            active = { window, resolve, reject };
            timer = setTimeout(() => reject(new Error("文件初始化超时")), 35_000);
            window.webContents.once("render-process-gone", () => reject(new Error("文件初始化页面已退出")));
            window.webContents.once("did-fail-load", () => reject(new Error("文件初始化页面无法加载")));
          });
          void result.catch(() => {});
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          window.webContents.on("will-navigate", (event) => event.preventDefault());
          await options.load(window);
          return await result;
        } finally {
          clearTimeout(timer);
          if (active?.window === window) active = null;
          if (!window.isDestroyed()) window.destroy();
        }
      })().catch((error) => {
        // TIPS: 账户变化后可能已开始新一轮初始化，旧页面失败不能清除新任务的复用入口。
        if (initialized === pending) initialized = null;
        throw error;
      });
      initialized = pending;
      return pending;
    },
    /** 主窗口账户或组织变化后，下次独立启动重新读取当前存储。 */
    invalidate() { active?.reject(new Error("账户配置已变化")); initialized = null; },
  };
}
