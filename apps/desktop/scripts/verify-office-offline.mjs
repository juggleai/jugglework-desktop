import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 使用安装包资源检查基础 Office 页面和内容工具的离线运行，自动回收测试文档及日志。
 * @param {string} appPath 本机 JuggleWork.app 路径；不会启动、修改或覆盖该应用的数据
 * @returns {Promise<object>} 基础能力验证、请求统计及未覆盖范围，不等同于完整离线验收
 */
export async function verifyOfficeOffline(appPath) {
  if (process.platform !== "darwin") throw new Error("此验收入口仅支持 macOS");
  const resources = await realpath(join(appPath, "Contents", "Resources"));
  const root = await mkdtemp(join(tmpdir(), "jugglework-office-offline-"));
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron");
    const worker = join(
      dirname(fileURLToPath(import.meta.url)),
      "verify-office-offline-worker.mjs",
    );
    // TIPS：操作系统限制覆盖引擎子进程；嵌套的 Chromium 沙盒仅在此测试宿主中关闭。
    const profile = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny file-write* (subpath ${JSON.stringify(resources)}))`;
    const environment = { ...process.env, PATH: join(root, "empty-path") };
    delete environment.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          electron,
          "--no-sandbox",
          worker,
          JSON.stringify({ root, resources }),
        ],
        {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 180_000,
        },
      );
      const terminate = () => child.kill("SIGTERM");
      process.once("SIGINT", terminate);
      process.once("SIGTERM", terminate);
      const removeSignalHandlers = () => {
        process.removeListener("SIGINT", terminate);
        process.removeListener("SIGTERM", terminate);
      };
      let diagnostics = "";
      child.stdout.on("data", (chunk) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-8000);
      });
      child.once("error", (error) => {
        removeSignalHandlers();
        reject(error);
      });
      child.once("close", (code) => {
        removeSignalHandlers();
        if (code === 0) resolve();
        else
          reject(new Error(`Office 离线验收失败（${code}）：${diagnostics}`));
      });
    });
    return JSON.parse(
      await readFile(join(root, "offline-result.json"), "utf8"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const appPath = process.argv[process.argv.indexOf("--app") + 1];
    if (!process.argv.includes("--app") || !appPath)
      throw new Error(
        "用法：node verify-office-offline.mjs --app /path/to/JuggleWork.app",
      );
    console.log(JSON.stringify(await verifyOfficeOffline(appPath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
