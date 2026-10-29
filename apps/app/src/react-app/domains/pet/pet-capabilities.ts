import { getMcpServerName, type McpDirectoryInfo } from "@/app/constants";
import type { ComposerDraft, ComposerPart, McpServerEntry, McpStatusMap } from "@/app/types";
import type { PetCapability } from "@/app/lib/desktop-pet-types";
import type { JuggleWorkSkillItem } from "@/app/lib/jugglework-server";
import { composerMcpStatus } from "../connections/workspace-mcp-inventory";
import { isJuggleWorkExtensionEnabled } from "../settings/extension-state";
import { buildCapabilityInstruction, composerCapabilityToken } from "../session/surface/composer/capability-tags";

export function petLocalSkillCapabilities(skills: JuggleWorkSkillItem[]): PetCapability[] {
  return skills.filter((skill) => skill.enabled !== false).map((skill) => ({
    id: `skill:${skill.name}`, group: "skills", kind: "skill", name: skill.name,
    description: skill.description, prompt: buildCapabilityInstruction("skill", skill.name),
  }));
}

/** MCP 管理的插件使用真实连接生命周期，不读取无效的本地开关。 */
export function petExtensionReady(entry: McpDirectoryInfo, servers: McpServerEntry[], statuses: McpStatusMap): boolean {
  const manifest = entry.extensionManifest;
  const mcp = manifest?.resources.find((resource) => resource.type === "mcp");
  if (mcp && !manifest?.enablement?.some((condition) => condition.type === "toggle-enabled")) {
    const server = servers.find((item) => item.name === (mcp.mcpServerName ?? getMcpServerName(entry)));
    return Boolean(server && composerMcpStatus(server, statuses) === "connected");
  }
  return isJuggleWorkExtensionEnabled(entry);
}

/** 只从宿主当前清单取能力内容；PET 提交的快照仅用来标识所选条目。 */
export function petCapabilityDraft(text: string, selected: PetCapability[], inventory: PetCapability[]): ComposerDraft {
  if (!selected.length) return { text: text.trim(), parts: [{ type: "text", text: text.trim() }], attachments: [], mode: "prompt" };
  const available = new Map(inventory.filter((item) => !item.disabled).map((item) => [item.id, item]));
  const seen = new Set<string>();
  const capabilities = selected.map((item) => {
    const current = available.get(item.id);
    if (!current || current.kind !== item.kind || current.name !== item.name || current.group !== item.group) {
      throw new Error("所选能力已变化，请重新选择");
    }
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    return current;
  }).filter((item): item is PetCapability => item !== null);
  const visibleText = [text.trim(), ...capabilities.map((item) => composerCapabilityToken(item.kind, item.name))].filter(Boolean).join("\n");
  const parts: ComposerPart[] = text.trim() ? [{ type: "text", text: text.trim() }] : [];
  const resolved = text.trim() ? [text.trim()] : [];
  for (const item of capabilities) {
    const prompt = item.prompt ?? buildCapabilityInstruction(item.kind, item.name);
    parts.push(item.kind === "skill" ? { type: "skill", name: item.name } : { type: "capability", kind: item.kind, name: item.name, prompt });
    resolved.push(prompt);
  }
  return { text: visibleText, parts, resolvedText: resolved.join("\n"), attachments: [], mode: "prompt" };
}
