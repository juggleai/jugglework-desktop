/**
 * `navigator.appVersion`／User-Agent 默认带有 Electron 进程名（品牌名可能是中文），
 * 部分服务端和第三方脚本按 ASCII token 识别客户端。这里只把应用标识统一替换成
 * `beishuwork`，其余 UA 结构（平台、Chrome、Electron、Safari）保持不变。
 */

export const USER_AGENT_APP_TOKEN = "beishuwork";

function platformToken(platform) {
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

/**
 * 幂等：已有的 fallback 只替换应用标识段；没有 fallback 时按平台重新拼一个。
 * 返回最终写入的 UA，便于调用方记录或测试。
 */
export function applyAsciiUserAgentFallback(app, options = {}) {
  if (!app || typeof app.getVersion !== "function") return "";
  const version = String(app.getVersion() ?? "").trim();
  const appToken = version ? `${USER_AGENT_APP_TOKEN}/${version}` : USER_AGENT_APP_TOKEN;
  const current = typeof app.userAgentFallback === "string" ? app.userAgentFallback : "";
  const chromeIndex = current.indexOf(" Chrome/");
  // UA 形如 "Mozilla/5.0 (<platform>) AppleWebKit/... (KHTML, like Gecko) <name>/<version> Chrome/... "。
  // 用最后一个 ") " 定位平台段结尾，避免应用名里的空格干扰。
  const platformEnd = chromeIndex > 0 ? current.slice(0, chromeIndex).lastIndexOf(") ") : -1;
  if (platformEnd >= 0) {
    app.userAgentFallback = `${current.slice(0, platformEnd + 2)}${appToken}${current.slice(chromeIndex)}`;
    return app.userAgentFallback;
  }
  const platform = options.platform ?? process.platform;
  const chrome = options.chromeVersion ?? process.versions.chrome;
  const electron = options.electronVersion ?? process.versions.electron;
  app.userAgentFallback = `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) ${appToken} Chrome/${chrome} Electron/${electron} Safari/537.36`;
  return app.userAgentFallback;
}
