/**
 * 输入框「能力标签」的 token 语法与样式，由编辑器、Composer 菜单、草稿解析三处共用。
 *
 * TIPS: 草稿里存的是紧凑 token（如 `[cloud-skill 名称]`），编辑器把它渲染成一枚 tag，
 * 提交时再在 session-surface 的 buildDraft 里展开成模型真正看到的完整指令。
 * 这样 tag 内始终是干净完整的能力名，而不是把一整段半截的散文塞进输入框。
 */

/** 能力标签的种类：本地技能、云端（未安装）技能、扩展、MCP 服务。 */
export type ComposerCapabilityKind = "skill" | "cloud-skill" | "extension" | "mcp" | "cloud-mcp";

const CAPABILITY_KINDS: ComposerCapabilityKind[] = ["skill", "cloud-skill", "extension", "mcp", "cloud-mcp"];

const CAPABILITY_TOKEN_RE = /^\[(cloud-skill|cloud-mcp|skill|extension|mcp) (.+)\]$/;
const CAPABILITY_TOKEN_GLOBAL_RE = /\[(cloud-skill|cloud-mcp|skill|extension|mcp) ([^\]]+)\]/g;

/**
 * 草稿分词正则：附件、折叠粘贴、能力标签、@mention。
 *
 * TIPS: 编辑器（文本 → 节点）与 buildDraft（文本 → parts）必须用同一套分词，
 * 否则两边对同一段草稿的理解会漂移。
 */
export const COMPOSER_TOKEN_SPLIT_RE =
  /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[(?:cloud-skill|cloud-mcp|skill|extension|mcp) [^\]]+\]|@[^\s@]+)/;

/**
 * 构造能力标签 token
 * @param kind 能力种类
 * @param name 能力名称
 * @returns 草稿中使用的 token 文本
 */
export function composerCapabilityToken(kind: ComposerCapabilityKind, name: string) {
  return `[${kind} ${name}]`;
}

/**
 * 解析单个 token
 * @param segment 待解析的草稿片段
 * @returns 解析出的种类与名称，非 token 返回 null
 */
export function parseComposerCapabilityToken(segment: string) {
  const match = segment.match(CAPABILITY_TOKEN_RE);
  if (!match) return null;
  const kind = match[1] as ComposerCapabilityKind;
  const name = match[2]?.trim();
  if (!name || !CAPABILITY_KINDS.includes(kind)) return null;
  return { kind, name };
}

/**
 * 替换草稿中所有能力 token
 * @param text 原始草稿文本
 * @param replace 针对每个 token 返回替换后的文本
 * @returns 替换后的文本
 */
export function replaceComposerCapabilityTokens(
  text: string,
  replace: (kind: ComposerCapabilityKind, name: string) => string,
) {
  return text.replace(CAPABILITY_TOKEN_GLOBAL_RE, (_match, kind: string, name: string) =>
    replace(kind as ComposerCapabilityKind, name.trim()));
}

/**
 * 能力标签的样式
 *
 * TIPS: 本地已安装的技能保持原来的紫色；云端技能、扩展、MCP 一律用淡橙色，
 * 让「这条能力不在本地」一眼可辨，但形态与本地标签完全一致。
 * @param kind 能力种类
 * @returns tag 的 className
 */
export function composerCapabilityTagClassName(kind: ComposerCapabilityKind) {
  const base = "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium";
  return kind === "skill"
    ? `${base} border-violet-6/35 bg-violet-3/20 text-violet-11`
    : `${base} border-orange-6/35 bg-orange-3/25 text-orange-11`;
}

/**
 * 能力标签的悬浮说明前缀
 * @param kind 能力种类
 * @returns 用于 title 属性的前缀
 */
export function composerCapabilityTagTitlePrefix(kind: ComposerCapabilityKind) {
  switch (kind) {
    case "cloud-skill":
      return "Skill (cloud)";
    case "cloud-mcp":
      return "MCP (cloud)";
    case "extension":
      return "Extension";
    case "mcp":
      return "MCP";
    default:
      return "Skill";
  }
}

/**
 * 构造送给模型的能力指令
 *
 * TIPS: 四种能力共用一套句式，原因有二：
 * 1. 句子里保留 `[kind name]` token，会话记录才能把整句折叠成一枚 tag（见 message-list）；
 * 2. 句子本身必须是可执行的祈使句。此前 MCP 发出去的是名词短语 `the "x" MCP server`，
 *    模型既不认得、也不会去调用它的工具。扩展目录里的 composerPrompt（如 "Use Computer Use to "）
 *    是给草稿起手用的半截文案，同样不能直接当指令发送。
 * 可变细节一律放进括号，与下面的匹配正则严格对应。
 * @param kind 能力种类
 * @param name 能力名称
 * @param detail 括号内的可执行细节，不得包含右括号与句号
 * @returns 送给模型的完整指令
 */
export function buildCapabilityInstruction(
  kind: ComposerCapabilityKind,
  name: string,
  detail?: string,
) {
  const token = composerCapabilityToken(kind, name);
  const suffix = kind === "skill" || kind === "cloud-skill"
    ? "and follow its instructions"
    : "for this request";
  const verb = kind === "skill" || kind === "cloud-skill" ? "Load" : "Use";
  const trimmed = detail?.replace(/[).]+$/g, "").trim();
  return trimmed
    ? `${verb} ${token} ${suffix} (${trimmed}).`
    : `${verb} ${token} ${suffix}.`;
}

/**
 * 匹配一整句能力指令，或裸 token。
 *
 * TIPS: 用于会话记录里把整句折叠成 tag。括号内细节用 `[^)]*` 兜住，
 * 因此 buildCapabilityInstruction 的 detail 里不能出现右括号。
 */
export const CAPABILITY_INSTRUCTION_RE = new RegExp(
  "((?:Load |Use )\\[(?:cloud-skill|cloud-mcp|skill|extension|mcp) [^\\]]+\\]"
  + "(?: and follow its instructions| for this request)(?: \\([^)]*\\))?\\."
  + "|\\[(?:cloud-skill|cloud-mcp|skill|extension|mcp) [^\\]]+\\])",
);

/**
 * 从一段能力指令（或裸 token）里取出种类与名称
 * @param segment CAPABILITY_INSTRUCTION_RE 切出的片段
 * @returns 种类与名称，不匹配返回 null
 */
export function parseCapabilityInstruction(segment: string) {
  const match = segment.match(
    /^(?:(?:Load|Use) )?\[(cloud-skill|cloud-mcp|skill|extension|mcp) ([^\]]+)\](?:(?: and follow its instructions| for this request)(?: \([^)]*\))?\.)?$/,
  );
  if (!match) return null;
  return { kind: match[1] as ComposerCapabilityKind, name: match[2]!.trim() };
}

/**
 * 未登记展开文案时的兜底指令
 *
 * TIPS: 草稿可能在能力列表刷新后才提交，登记信息万一丢失也不能把裸 token 发给模型。
 * @param kind 能力种类
 * @param name 能力名称
 * @returns 送给模型的完整指令
 */
export function fallbackCapabilityPrompt(kind: ComposerCapabilityKind, name: string) {
  return buildCapabilityInstruction(kind, name, capabilityDefaultDetail(kind, name));
}

/**
 * 各类能力默认的可执行细节
 * @param kind 能力种类
 * @param name 能力名称
 * @returns 括号内的细节文案，无细节返回 undefined
 */
export function capabilityDefaultDetail(kind: ComposerCapabilityKind, name: string) {
  // MCP 的工具在模型侧注册为 `<服务名>_<工具名>`，点名这个前缀才能真正把它用起来。
  if (kind === "mcp") return `call its ${name}_* tools directly`;
  // Cloud MCP 不会注册 `<服务名>_*` 工具；兜底也必须经统一网关发现并执行精确能力名。
  if (kind === "cloud-mcp") {
    return `find the needed tool with jugglework-cloud_search_capabilities using the connection name ${name}, `
      + "then call jugglework-cloud_execute_capability with the exact capability name returned by that search";
  }
  return undefined;
}

/**
 * 生成 MCP 选择后登记到草稿的能力种类与完整指令。
 *
 * TIPS: Connect 下发的 stdio MCP 同样带 `origin: jugglework-connect`，因此不能只看来源；
 * 只有 Connect 的 remote 条目才由 Cloud 网关承载。能力提示只参与搜索，不能直接执行。
 * @param entry MCP 条目的调用路由信息
 * @returns 可插入草稿的能力种类与完整指令
 */
export function resolveMcpCapabilitySelection(entry: {
  name: string;
  origin?: "local" | "jugglework-connect";
  config: { type: "remote" | "local" };
  connectCapabilityName?: string;
}): { kind: "mcp" | "cloud-mcp"; prompt: string } {
  if (entry.origin !== "jugglework-connect" || entry.config.type !== "remote") {
    return {
      kind: "mcp",
      prompt: buildCapabilityInstruction("mcp", entry.name, capabilityDefaultDetail("mcp", entry.name)),
    };
  }

  const capabilityHint = entry.connectCapabilityName
    ? ` and capability hint ${entry.connectCapabilityName}`
    : "";
  const detail = `find the needed tool with jugglework-cloud_search_capabilities using the connection name ${entry.name}${capabilityHint}, `
    + "then call jugglework-cloud_execute_capability with the exact capability name returned by that search";
  return {
    kind: "cloud-mcp",
    prompt: buildCapabilityInstruction("cloud-mcp", entry.name, detail),
  };
}
