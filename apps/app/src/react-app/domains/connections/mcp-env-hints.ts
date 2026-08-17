/**
 * 环境变量 key 的建议来源与排序。
 *
 * TIPS: 用户手上通常只有一条 npx 命令，key 名是隐藏知识。README 的 JSON 代码块里
 * `env` 对象的键，定义上就是作者要用户配置的东西——几乎没有假阳性，因此作为高置信来源；
 * 包名前缀匹配（firecrawl-mcp → FIRECRAWL_*）作为次级来源。扫包源码召回高但精度低
 * （firecrawl 源码含 18 个 process.env，多数与用户无关），本版不采集。
 */

/** 建议项的来源，决定展示顺序与来源标注。 */
export type EnvHintSource = "readme-json" | "name-prefix";

/**
 * 单条环境变量建议。
 * @param key 环境变量名
 * @param source 建议来源
 */
export type EnvHint = {
  key: string;
  source: EnvHintSource;
};

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;

/** 常见的通用/框架变量，出现在 README 里也不作为建议。 */
const NOISE_KEYS = new Set([
  "NODE_ENV",
  "PATH",
  "HOME",
  "PORT",
  "HOST",
  "DEBUG",
  "NO_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "TZ",
  "LANG",
]);

/** 命令前导中需要跳过的运行器与其选项。 */
const RUNNER_TOKENS = new Set(["npx", "bunx", "uvx", "pnpm", "npm", "yarn", "bun", "dlx", "exec", "run"]);

/**
 * 从 README 全文中提取 JSON 代码块内 `env` 对象的键。
 * @param readme README 原文
 * @returns 去重后的键名数组，保持出现顺序
 */
export function extractEnvKeysFromReadme(readme: string): string[] {
  if (!readme) return [];
  const keys: string[] = [];
  const seen = new Set<string>();

  // 抓 ```json / ```jsonc / 无语言标注的代码块，块内再定位 "env" 对象。
  const blockPattern = /```(?:json5?|jsonc)?\s*([\s\S]*?)```/g;
  for (const blockMatch of readme.matchAll(blockPattern)) {
    const block = blockMatch[1] ?? "";
    const envPattern = /"(?:env|environment)"\s*:\s*\{([\s\S]*?)\}/g;
    for (const envMatch of block.matchAll(envPattern)) {
      const body = envMatch[1] ?? "";
      for (const keyMatch of body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)) {
        const key = keyMatch[1]!;
        if (!ENV_KEY_PATTERN.test(key)) continue;
        if (NOISE_KEYS.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys;
}

/**
 * 把包名转成环境变量前缀，如 `@browserbasehq/mcp-server-browserbase` → `BROWSERBASE`。
 * @param packageName npm 包名
 */
function envPrefixesFromPackageName(packageName: string): string[] {
  const withoutScope = packageName.replace(/^@[^/]+\//, "");
  const scope = packageName.startsWith("@") ? packageName.slice(1).split("/")[0] ?? "" : "";
  const words = `${withoutScope} ${scope}`
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word && !/^(mcp|server|cli|js|ts|node|hq|inc|labs)$/i.test(word));
  return Array.from(new Set(words.map((word) => word.toUpperCase())));
}

/**
 * 对候选键排序并标注来源。
 * @param readmeKeys 从 README 提取的键
 * @param packageName npm 包名，用于前缀匹配
 * @param extraKeys 其他渠道得到的候选键
 *
 * TIPS: README 命中的键置顶；其余键只有前缀匹配包名时才保留——这条启发式很有效，
 * 因为 MCP 作者几乎都按 `<产品名>_<用途>` 的惯例命名环境变量。
 */
export function rankEnvHints(
  readmeKeys: string[],
  packageName: string,
  extraKeys: string[] = [],
): EnvHint[] {
  const hints: EnvHint[] = [];
  const seen = new Set<string>();

  for (const key of readmeKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ key, source: "readme-json" });
  }

  const prefixes = envPrefixesFromPackageName(packageName);
  for (const key of extraKeys) {
    if (seen.has(key)) continue;
    if (!ENV_KEY_PATTERN.test(key)) continue;
    if (NOISE_KEYS.has(key)) continue;
    if (!prefixes.some((prefix) => key.startsWith(`${prefix}_`))) continue;
    seen.add(key);
    hints.push({ key, source: "name-prefix" });
  }

  return hints;
}

/** 聚合器 CLI 的转发动词：其后跟的才是真正要跑的 MCP 包。 */
const PASSTHROUGH_VERBS = new Set(["run", "exec", "start", "launch", "serve"]);

/**
 * 剥掉版本后缀并校验是否为合法 npm 包名。
 * @param token 命令中的单个 token
 * @returns 规范化的包名；不像包名时返回空字符串
 */
function normalizePackageToken(token: string): string {
  // 剥离版本后缀：foo@1.2.3 / @scope/foo@latest
  const scoped = token.startsWith("@");
  const atIndex = token.indexOf("@", scoped ? 1 : 0);
  const name = atIndex > 0 ? token.slice(0, atIndex) : token;
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return "";
  return name;
}

/**
 * 从启动命令的 argv 中提取要查询的 npm 包名。
 * @param argv 已词法解析的命令数组
 * @returns 包名；无法判定时返回空字符串
 *
 * TIPS: 跳过运行器与其选项（npx -y、bunx、pnpm dlx 等）后取第一个非选项 token。
 * TIPS: 再看穿聚合器包装——`@some/cli run @scope/real-mcp` 这类命令里，第一个包只是启动器，
 * 用户要配的环境变量属于它后面那个真实的 MCP 包。转发动词之后的包名优先。
 */
export function packageNameFromCommand(argv: string[]): string {
  let candidate = "";
  let expectTarget = false;

  for (const raw of argv) {
    const token = raw.trim();
    if (!token) continue;

    // TIPS: 转发动词后必须紧跟包名。若下一个 token 是选项，说明这是 `run --key <值>` 这类形式，
    // 其后的 `<值>` 是选项的值而非包名，此时回退到启动器本身而不是把值误认成包。
    if (expectTarget) {
      if (token.startsWith("-")) return candidate;
      return normalizePackageToken(token) || candidate;
    }

    if (token.startsWith("-")) continue;

    if (!candidate) {
      const bare = token.split("/").pop() ?? token;
      if (RUNNER_TOKENS.has(token.toLowerCase()) || RUNNER_TOKENS.has(bare.toLowerCase())) continue;
      candidate = normalizePackageToken(token);
      // 首个候选就不像包名（例如绝对路径的自建服务），没有可查的 npm 包。
      if (!candidate) return "";
      continue;
    }

    if (PASSTHROUGH_VERBS.has(token.toLowerCase())) expectTarget = true;
  }

  return candidate;
}
