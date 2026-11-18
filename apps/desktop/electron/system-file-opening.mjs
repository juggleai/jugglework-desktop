import path from "node:path";
import { getOfficeDocumentKind } from "@jugglework/types/office";

// Only these switches consume a separate value. Unknown/boolean Chromium
// switches must not eat the next positional document supplied by Explorer.
const valueSwitches = new Set([
  "--user-data-dir", "--profile-directory", "--disk-cache-dir", "--log-file",
  "--remote-debugging-port", "--remote-debugging-address", "--proxy-server",
  "--proxy-bypass-list", "--js-flags",
  "--log-net-log", "--crash-dumps-dir", "--diagnostic-dir", "--user-agent",
  "--host-rules", "--host-resolver-rules", "--proxy-pac-url", "--lang",
  "--disk-cache-size", "--log-level", "--v", "--vmodule",
  "--auth-server-whitelist", "--auth-negotiate-delegate-whitelist",
  "--ignore-connections-limit", "--force-fieldtrials",
]);

/** 提取系统文件参数；平台路径按来源工作目录解析，选项及深链接不作为文件。 */
export function systemOfficeFilePaths(
  argv,
  { platform = process.platform, cwd = process.cwd(), packaged = true } = {},
) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const result = [];
  let positional = false;
  const args = argv.slice(packaged ? 1 : 2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--") {
      positional = true;
      continue;
    }
    if (!positional && value.startsWith("-")) {
      // TIPS: 系统关联传位置参数；开发/Chromium 选项值不能误开成文档。
      if (
        valueSwitches.has(value) &&
        args[index + 1] &&
        !args[index + 1].startsWith("-")
      )
        index++;
      continue;
    }
    if (
      !value ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
      !getOfficeDocumentKind(value)
    )
      continue;
    result.push(paths.resolve(cwd, value));
  }
  return [...new Set(result)];
}

/**
 * Prefer the second process's original parsed paths: Electron may reorder argv.
 * @param {string[]} argv
 * @param {any} additionalData
 * @param {Parameters<typeof systemOfficeFilePaths>[1]} options
 */
export function secondInstanceOfficeFilePaths(argv, additionalData, options = {}) {
  const payload = additionalData?.systemFileOpening;
  const paths = (options.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  if (payload?.version === 1 && Array.isArray(payload.files) &&
      payload.files.every(file => typeof file === "string" && paths.isAbsolute(file) &&
        !/^[a-z][a-z0-9+.-]*:\/\//i.test(file) && Boolean(getOfficeDocumentKind(file))))
    return [...new Set(payload.files)];
  return systemOfficeFilePaths(argv, options);
}

/** 在 ready 前接收 macOS 文件事件；就绪后顺序处理，单个失败仍继续后续文件。 */
export function createSystemFileOpening({ app, openFile, onError }) {
  const pending = [];
  let ready = false;
  let requested = false;
  let drain = null;
  const flush = () => {
    if (!ready || drain) return drain ?? Promise.resolve();
    drain = (async () => {
      while (pending.length) {
        const file = pending.shift();
        try {
          await openFile(file);
        } catch (error) {
          onError(file, error);
        }
      }
    })().finally(() => {
      drain = null;
      if (pending.length) void flush();
    });
    return drain;
  };
  const enqueue = (files) => {
    if (!files.length) return false;
    requested = true;
    pending.push(...files);
    void flush();
    return true;
  };
  app.on("open-file", (event, file) => {
    event.preventDefault();
    enqueue([file]);
  });
  return {
    /** 登记 argv 或用户选择的文件；返回是否存在文件请求。 */
    enqueue,
    /** 全部宿主初始化完成后才允许处理冷启动事件。 */
    start() {
      ready = true;
      return flush();
    },
    /** 判断本次启动是否来自文件，避免强制激活聊天窗口。 */
    requested: () => requested,
    /** 文件启动尚未完成时，macOS activate 不抢先打开聊天窗口。 */
    processing: () => !ready || Boolean(drain),
    /** 等待已登记请求处理完毕，供启动与验证使用。 */
    idle: async () => {
      while (drain) await drain;
    },
  };
}
