/**
 * 输入框中 MCP 令牌的编码与展开。
 *
 * TIPS：选中一个 MCP 后草稿里只留下 `[mcp <name>]` 这样的短令牌，界面渲染成 chip；
 * 发送前再换回完整的调用指令，这样"界面简洁"和"模型指令完整"不互相牺牲。
 */

const MCP_TOKEN_RE = /\[mcp ([^\]]+)\]/g;

/**
 * 生成草稿中使用的 MCP 令牌。
 *
 * @param name MCP 服务名称
 * @returns 形如 `[mcp GitHub]` 的令牌
 */
export function composerMcpToken(name: string) {
  return `[mcp ${name}]`;
}

/**
 * 把草稿中的 MCP 令牌展开成发送给模型的完整指令。
 *
 * @param text 含令牌的草稿文本
 * @param prompts MCP 名称到完整调用指令的映射
 * @returns 展开后的文本；找不到对应指令时退化成一句安全的英文描述
 */
export function expandComposerMcpTokens(text: string, prompts: Record<string, string>) {
  return text.replace(MCP_TOKEN_RE, (_match, name: string) => prompts[name] ?? `the "${name}" MCP server`);
}
