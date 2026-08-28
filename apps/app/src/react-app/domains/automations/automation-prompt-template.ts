import type { AutomationPromptPart, AutomationPromptTemplate } from "@jugglework/types/automation";

const FILE_PREFIX = "@file:";
const SKILL_PREFIX = "$skill:";
// TIPS:技能用会话编辑器原生的 `[skill id]` 标记承载，这样重新打开草稿时 Lexical 会把它渲染成
// 输入框内的技能 tag，而不是一行纯文本；旧的整行 `$skill:` 写法仍然可以解析。
const SKILL_TOKEN = /\[skill ([^\]]+)\]/g;

/** 将持久化提示词部件转换为编辑器可稳定往返的文本标记。 */
export function serializeAutomationPrompt(template: AutomationPromptTemplate): string {
  return template.parts.map((part) => {
    if (part.type === "file") return `${FILE_PREFIX}${part.relativePath}`;
    if (part.type === "skill") return `[skill ${part.skillId}]`;
    return part.text;
  }).join("\n");
}

/** 读取提示词文本里引用到的稳定技能 ID（去重，保持出现顺序）。 */
export function readAutomationSkillIds(value: string): string[] {
  return [...new Set(parseAutomationPromptParts(value)
    .filter((part): part is Extract<AutomationPromptPart, { type: "skill" }> => part.type === "skill")
    .map((part) => part.skillId))];
}

/**
 * 将编辑器文本解析为仅含持久化引用的版本化模板。
 * TIPS: 文件和技能引用必须整行书写，避免普通正文中的 @/$ 被误解释为执行依赖。
 */
export function parseAutomationPrompt(value: string): AutomationPromptTemplate {
  const parts = parseAutomationPromptParts(value);
  if (!parts.length) throw new Error("提示词不能为空");
  return { version: 1, parts };
}

function parseAutomationPromptParts(value: string): AutomationPromptPart[] {
  if (/\b(?:blob|data):/i.test(value) || /\[(?:attachment|image|audio|video)\]/i.test(value)) {
    throw new Error("自动化提示词不支持临时附件、图片、音频或粘贴对象，请改用工作空间相对文件引用");
  }
  const parts: AutomationPromptPart[] = [];
  let text: string[] = [];
  const flushText = () => {
    const content = text.join("\n").trim();
    if (content) parts.push({ type: "text", text: content });
    text = [];
  };
  for (const line of value.split("\n")) {
    if (line.startsWith(FILE_PREFIX)) {
      flushText();
      const relativePath = line.slice(FILE_PREFIX.length).trim();
      if (!relativePath || relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
        throw new Error("文件引用必须使用工作空间内的相对路径，例如 @file:docs/report.md");
      }
      parts.push({ type: "file", relativePath });
      continue;
    }
    if (line.startsWith(SKILL_PREFIX)) {
      flushText();
      const skillId = line.slice(SKILL_PREFIX.length).trim();
      if (!skillId) throw new Error("技能引用必须包含稳定技能 ID，例如 $skill:weekly-report");
      parts.push({ type: "skill", skillId });
      continue;
    }
    if (SKILL_TOKEN.test(line)) {
      SKILL_TOKEN.lastIndex = 0;
      let cursor = 0;
      for (let match = SKILL_TOKEN.exec(line); match; match = SKILL_TOKEN.exec(line)) {
        const before = line.slice(cursor, match.index);
        if (before.trim()) text.push(before);
        flushText();
        const skillId = match[1].trim();
        if (!skillId) throw new Error("技能引用必须包含稳定技能 ID，例如 $skill:weekly-report");
        parts.push({ type: "skill", skillId });
        cursor = match.index + match[0].length;
      }
      const rest = line.slice(cursor);
      if (rest.trim()) text.push(rest);
      continue;
    }
    text.push(line);
  }
  flushText();
  return parts;
}
