import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { desktopConfigSchema } from "@jugglework/types/den/desktop-policies";
import { readFileWindowDesktopConfig } from "./file-window-conversation.mjs";

/** 规范化部署地址，文件模式沿用主窗口同一部署的策略。 */
export function fileContextDeployment(value) {
  const url = new URL(value);
  for (let pass = 0; pass < 2; pass++) {
    const path = url.pathname.replace(/\/+$/, "");
    const suffix = ["/jwork/api", "/api/den", "/jwork"].find((item) => path.toLowerCase().endsWith(item));
    if (suffix) url.pathname = path.slice(0, -suffix.length) || "/";
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Main 保管文件模式所需的非凭据策略缓存；不启动主窗口 Renderer，也不共享其存储分区。
 * @param {{path: string, bootstrap: () => Promise<any>, initialize?: () => Promise<unknown>, now?: () => number}} options 缓存位置与可信应用部署
 */
export function createFileWindowDesktopContext({ path, bootstrap, initialize, now = Date.now }) {
  let pending = Promise.resolve();
  return {
    /** 只接受可信主窗口推送的当前账户策略，登出或切换组织时清除旧缓存。 */
    sync(input) {
      const write = async () => {
        const boot = await bootstrap();
        if (!input?.signedIn || !input.userId || !input.organizationId) {
          await rm(path, { force: true });
          return;
        }
        const config = desktopConfigSchema.parse(input.config);
        if (fileContextDeployment(input.baseUrl) !== fileContextDeployment(boot.baseUrl)) throw new Error("文件窗口配置不属于当前部署");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify({ baseUrl: fileContextDeployment(boot.baseUrl), userId: input.userId,
          organizationId: input.organizationId, updatedAt: now(), config }), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      };
      // TIPS: 主窗口配置刷新与登出按调用顺序落盘，登出不能被较早的写入覆盖。
      const next = pending.then(write, write);
      pending = next.catch(() => {});
      return next;
    },
    /** 有主窗口时实时读取；独立启动沿用同部署的已应用普通聊天策略。 */
    async read(window) {
      const boot = await bootstrap();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        const config = await readFileWindowDesktopConfig(window, boot);
        return config ?? (boot.requireSignin === false ? {} : null);
      }
      try { await initialize?.(); } catch { /* 初始化暂不可用时仍按已有同部署缓存判断，不放宽策略。 */ }
      try {
        const cached = JSON.parse(await readFile(path, "utf8"));
        // TIPS: 缓存只用于已有普通聊天策略；不包含 token，不赋予自动化或远控权限。
        if (cached.baseUrl !== fileContextDeployment(boot.baseUrl) || !cached.userId || !cached.organizationId || !Number.isFinite(cached.updatedAt)) return null;
        const parsed = desktopConfigSchema.safeParse(cached.config);
        return parsed.success ? parsed.data : null;
      } catch (error) { return error?.code === "ENOENT" && boot.requireSignin === false ? {} : null; }
    },
  };
}
