import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeImage } from "electron";
import {
  applyWindowsTaskbarIcon,
  windowsIconFromNativeImage,
} from "./brand-icon-windows.mjs";

/**
 * 为文档窗口提供独立任务栏标识；macOS Dock 入口仅负责激活窗口，不持有文档模型。
 * @param {object} options 图标、已构建的 Dock 应用及窗口操作回调
 */
export function createFileWindowDock({
  iconPath,
  helperPath,
  cachePath,
  activate,
  closeAll,
  platform = process.platform,
  spawnHelper = spawn,
}) {
  let helper = null;
  let windows = [];
  const report = (error) => console.warn("[file-window-dock]", error.message);
  return {
    /** Windows 在显示窗口前设置独立分组及用户指定的 ICO 图标。 */
    async prepareWindow(window) {
      if (platform !== "win32") return;
      const image = nativeImage.createFromPath(iconPath);
      const ico = path.join(cachePath, "file-window-logo.ico");
      writeFileSync(ico, windowsIconFromNativeImage(image));
      await applyWindowsTaskbarIcon(window, {
        image,
        appId: "com.juggleai.jugglework.documents",
        appIconPath: ico,
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: "JuggleWork 文件浏览器",
      });
    },
    /** 同步存活窗口；最后一个窗口关闭后退出 Dock 入口。 */
    update(items) {
      windows = items;
      if (platform !== "darwin") return;
      if (!windows.length) {
        this.dispose();
        return;
      }
      if (!helper) {
        if (!existsSync(helperPath)) {
          report(
            new Error(
              "缺少文档 Dock 入口，请执行 prepare-file-window-helper.mjs",
            ),
          );
          return;
        }
        const child = spawnHelper(helperPath, [], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        helper = child;
        let pending = "";
        child.stdout.on("data", (chunk) => {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event.action === "activate") activate(event.windowId);
              if (event.action === "close") void closeAll().catch(report);
            } catch {
              /* 忽略已退出入口产生的不完整行。 */
            }
          }
        });
        child.stdin.on("error", report);
        child.on("error", report);
        child.on("exit", () => {
          if (helper === child) helper = null;
        });
      }
      // TIPS: 管道仅传递窗口 ID 与标题；编辑页面和 Runtime 始终留在原进程。
      helper.stdin.write(`${JSON.stringify({ windows })}\n`);
    },
    /** 应用退出或窗口清空时释放入口；关闭 stdin 也能让子进程自行退出。 */
    dispose() {
      const child = helper;
      helper = null;
      child?.stdin.end();
      child?.kill();
    },
  };
}
