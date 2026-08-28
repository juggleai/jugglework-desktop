/**
 * 工作区导出时的凭据剥离。
 *
 * TIPS: 导出包此前只靠文件名黑名单挡机密（.env / credentials.* / *.key），而 MCP 凭据
 * 恰恰住在 opencode.json 里 —— 文件名完全合法，于是一枚有效的云端 MCP 令牌、数据库
 * 密码、OAuth client secret 会随工作区导出一起流出。凭据的判据是「它在配置里的位置」，
 * 不是「文件叫什么名字」，所以这里按结构剥离而不是按文件名拦截。
 */

/** 被剥离的值统一替换成这个占位串，让接收方一眼看出需要重填而不是配置缺失。 */
export const REDACTED_PLACEHOLDER = "__REDACTED__";

/** 视为凭据的请求头名（小写比较）。 */
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "cookie",
]);

/** OAuth 配置里需要剥离的字段。 */
const OAUTH_SECRET_FIELDS = new Set(["clientSecret", "client_secret", "refreshToken", "accessToken"]);

/**
 * 判断一个命令行参数是否内嵌了凭据。
 * @param value 单个 argv 元素
 *
 * TIPS: 只认「URL 里带 user:password@」这一种确定形态。命令行参数里的自由文本无法可靠
 * 判定是不是密钥，宁可漏也不能把正常参数（路径、模型名）打成 __REDACTED__ 让导出包不可用。
 */
export function isCredentialBearingArg(value) {
  if (typeof value !== "string") return false;
  return /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value);
}

/**
 * 把 URL 里的密码替换掉，保留协议、用户名与主机，便于接收方看出这是哪一个库。
 * @param value 含凭据的 URL
 */
function redactUrlPassword(value) {
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/i,
    (_match, scheme, user) => `${scheme}${user}:${REDACTED_PLACEHOLDER}@`,
  );
}

/**
 * 剥离单个 MCP 条目里的凭据。
 * @param entry MCP 条目配置对象
 * @param removed 累加被剥离项的描述，供导出结果告知用户
 */
function redactMcpEntry(entry, serverName, removed) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const next = { ...entry };

  if (next.environment && typeof next.environment === "object" && !Array.isArray(next.environment)) {
    const environment = {};
    for (const [key, value] of Object.entries(next.environment)) {
      if (typeof value !== "string" || value === "") {
        environment[key] = value;
        continue;
      }
      environment[key] = REDACTED_PLACEHOLDER;
      removed.push(`${serverName}.environment.${key}`);
    }
    next.environment = environment;
  }

  if (next.headers && typeof next.headers === "object" && !Array.isArray(next.headers)) {
    const headers = {};
    for (const [key, value] of Object.entries(next.headers)) {
      if (CREDENTIAL_HEADER_NAMES.has(key.trim().toLowerCase()) && typeof value === "string" && value !== "") {
        headers[key] = REDACTED_PLACEHOLDER;
        removed.push(`${serverName}.headers.${key}`);
      } else {
        headers[key] = value;
      }
    }
    next.headers = headers;
  }

  if (next.oauth && typeof next.oauth === "object" && !Array.isArray(next.oauth)) {
    const oauth = {};
    for (const [key, value] of Object.entries(next.oauth)) {
      if (OAUTH_SECRET_FIELDS.has(key) && typeof value === "string" && value !== "") {
        oauth[key] = REDACTED_PLACEHOLDER;
        removed.push(`${serverName}.oauth.${key}`);
      } else {
        oauth[key] = value;
      }
    }
    next.oauth = oauth;
  }

  if (Array.isArray(next.command)) {
    next.command = next.command.map((part) => {
      if (!isCredentialBearingArg(part)) return part;
      removed.push(`${serverName}.command`);
      return redactUrlPassword(part);
    });
  }

  return next;
}

/**
 * 剥离一份 opencode 配置文本里的全部 MCP 凭据。
 * @param text 原始配置文本（JSON / JSONC）
 * @returns `{ text, removed }`：处理后的文本与被剥离项清单；无凭据时原样返回
 *
 * TIPS: 解析失败时原样返回而不是抛错 —— 导出不能因为一份手写的、带注释或语法有误的配置
 * 而整体失败。这种情况下调用方仍会按文件名黑名单兜底。
 */
export function redactOpencodeConfigText(text) {
  const removed = [];
  if (typeof text !== "string" || !text.trim()) return { text, removed };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, removed };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text, removed };

  const mcp = parsed.mcp ?? parsed.mcpServers;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return { text, removed };

  const key = parsed.mcp ? "mcp" : "mcpServers";
  const nextMcp = {};
  for (const [serverName, entry] of Object.entries(mcp)) {
    nextMcp[serverName] = redactMcpEntry(entry, serverName, removed);
  }
  if (removed.length === 0) return { text, removed };

  const next = { ...parsed, [key]: nextMcp };
  return { text: `${JSON.stringify(next, null, 2)}\n`, removed };
}

/** 导出时需要做结构化凭据剥离的文件（相对工作区根，正斜杠）。 */
const REDACTED_RELATIVE_PATHS = new Set(["opencode.json", "opencode.jsonc"]);

/**
 * 判断某个导出条目是否需要剥离。
 * @param relativePath 相对工作区根的路径
 */
export function needsRedaction(relativePath) {
  return REDACTED_RELATIVE_PATHS.has(String(relativePath ?? "").trim());
}
