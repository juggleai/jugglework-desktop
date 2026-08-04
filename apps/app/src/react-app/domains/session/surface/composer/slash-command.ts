import type { McpServerEntry, SkillCard, SlashCommandOption } from "@/app/types";

const SLASH_COMMAND_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;
const SLASH_COMMAND_INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

export type ComposerSlashCommandOption = SlashCommandOption & {
  mcp?: McpServerEntry;
  skill?: SkillCard;
};

function slashSafeName(name: string, fallback: string, preferredName?: string) {
  const preferred = preferredName?.trim();
  if (preferred && /^[A-Za-z0-9_-]+$/.test(preferred)) return preferred;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function skillSlashCommandName(skill: Pick<SkillCard, "name" | "trigger">) {
  return slashSafeName(skill.name, "skill", skill.trigger);
}

export function skillMenuSlashCommandName(skill: Pick<SkillCard, "name" | "trigger" | "origin">) {
  return skill.origin === "jugglework-connect" ? skillSlashCommandName(skill) : skill.name;
}

export function connectSkillSlashCommandOptions(skills: SkillCard[]): ComposerSlashCommandOption[] {
  return skills.flatMap((skill) => {
    if (skill.origin !== "jugglework-connect" || !skill.connectCapabilityName) return [];
    return [{
      id: `connect-skill:${skill.connectCapabilityName}`,
      name: skillSlashCommandName(skill),
      description: [
        skill.description,
        [skill.marketplaceName, skill.pluginName].filter(Boolean).join(" · "),
      ].filter(Boolean).join(" — "),
      source: "skill",
      skill,
    }];
  });
}

/**
 * 将 MCP 服务名称转换为可输入的斜杠命令名称。
 *
 * @param mcp MCP 服务条目
 * @returns 仅包含斜杠命令安全字符的名称
 */
export function mcpSlashCommandName(mcp: Pick<McpServerEntry, "name">) {
  return slashSafeName(mcp.name, "mcp");
}

/**
 * 将会话可见的 MCP 服务投影为斜杠菜单选项。
 *
 * @param mcpServers 当前会话可见的 MCP 服务
 * @returns 可供输入框选择的 MCP 斜杠选项
 */
export function mcpSlashCommandOptions(mcpServers: McpServerEntry[]): ComposerSlashCommandOption[] {
  return mcpServers.map((mcp) => ({
    id: `mcp:${mcp.id ?? mcp.name}`,
    name: mcpSlashCommandName(mcp),
    description: [
      [mcp.marketplaceName, mcp.pluginName].filter(Boolean).join(" · "),
      mcp.config.type === "remote" ? mcp.config.url : mcp.config.command?.join(" "),
    ].filter(Boolean).join(" — "),
    source: "mcp",
    origin: mcp.origin,
    marketplaceName: mcp.marketplaceName,
    pluginName: mcp.pluginName,
    mcp,
  }));
}

export function getSlashCommandQuery(value: string) {
  const match = value.match(SLASH_COMMAND_QUERY_RE);
  return match ? match[1] : null;
}

export function parseSlashCommandInvocation(value: string) {
  const match = value.trim().match(SLASH_COMMAND_INVOCATION_RE);
  if (!match) return null;
  const name = match[1];
  if (!name) return null;
  return { name, arguments: match[2] ?? "" };
}
