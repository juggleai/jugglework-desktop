import type { SkillCard, SlashCommandOption } from "@/app/types";

const SLASH_COMMAND_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;
const SLASH_COMMAND_INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

export type ComposerSlashCommandOption = SlashCommandOption & {
  skill?: SkillCard;
};

export function withBuiltinSlashCommands(
  commands: SlashCommandOption[],
  builtins: readonly SlashCommandOption[],
): SlashCommandOption[] {
  const seen = new Set(commands.map((command) => command.name.trim().toLowerCase()));
  const missing = builtins.filter((command) => {
    const name = command.name.trim().toLowerCase();
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return missing.length ? [...missing, ...commands] : commands;
}

export function isNewSessionCommand(
  command: { name: string; arguments: string } | null | undefined,
) {
  if (command?.name.trim().toLowerCase() !== "new") return false;
  if (command.arguments.trim()) {
    throw new Error("/new does not accept arguments.");
  }
  return true;
}

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
