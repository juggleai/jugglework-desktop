/**
 * 创建 Office 本地模式的网络边界；页面只使用当前引擎及目录内的固定字体资源。
 * @param {string} origin 已绑定的回环引擎来源
 * @param {Array<{kind: string, url?: string}>} entries 版本清单中的资源身份
 */
export function createOfficeNetworkPolicy(origin, entries) {
  const engine = new URL(origin);
  if (
    engine.protocol !== "http:" ||
    engine.hostname !== "127.0.0.1" ||
    engine.origin !== origin
  )
    throw new Error("Office 本地网络来源无效");
  const fonts = new Set(
    entries
      .filter((entry) => entry.kind === "font" && entry.url)
      .map((entry) => entry.url),
  );
  return {
    /** 在发出请求前判断目标，覆盖 HTTP、WebSocket 和页面创建的 Worker；不读取或转发鉴权内容。 */
    allows({ url, method = "GET" }) {
      let target;
      try {
        target = new URL(url);
      } catch {
        return false;
      }
      if (target.protocol === "data:" || target.href === "about:blank")
        return true;
      if (target.protocol === "blob:") return target.origin === origin;
      // TIPS: WebSocket 使用同一引擎的协议配对，不能按“任意本机端口”放行其他服务。
      if (target.protocol === "ws:") target.protocol = "http:";
      if (target.origin === origin) return true;
      return (
        target.protocol === "https:" &&
        method === "GET" &&
        fonts.has(target.href)
      );
    },
  };
}
