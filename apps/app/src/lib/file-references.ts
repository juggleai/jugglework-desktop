import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

function normalize(value: string): string {
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      value = decodeURIComponent(url.pathname).replace(
        /^\/([A-Za-z]:\/)/,
        "$1",
      );
    } else {
      value = decodeURIComponent(value);
    }
  } catch {
    return "";
  }
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 在当前轮次已确认的文件中精确解析引用；同名文件有歧义时不猜测。
 * @param value 文件名、相对路径或本地文件 URL
 * @param targets 当前轮次的文件目标
 */
export function resolveFileReference(
  value: string,
  targets: OpenTarget[],
): OpenTarget | null {
  if (/^(?:https?|wss?|mailto|javascript|data):/i.test(value)) return null;
  const path = normalize(value);
  const files = targets.filter(
    (target) => target.kind === "file" && target.exists === true,
  );
  const exact = files.filter((target) => normalize(target.value) === path);
  if (exact.length === 1) return exact[0]!;
  const matches = files.filter(
    (target) =>
      path === target.name || path.endsWith(`/${normalize(target.value)}`),
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** 文本中的文件引用片段，未匹配内容保持原文。 */
export type FileReferenceSegment = { text: string; target?: OpenTarget };

/**
 * 在 Markdown 文本 token 中匹配唯一文件名或路径，不处理 HTML、代码块与外部 URL。
 * @param text 单个普通文本 token
 * @param targets 当前轮次已确认文件
 */
export function splitFileReferences(
  text: string,
  targets: OpenTarget[],
): FileReferenceSegment[] {
  const aliases = [
    ...new Set(targets.flatMap((target) => [target.value, target.name])),
  ]
    .filter((alias) => alias && resolveFileReference(alias, targets))
    .sort((left, right) => right.length - left.length);
  if (!aliases.length) return [{ text }];
  const escaped = aliases.map((alias) =>
    alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(escaped.join("|"), "gu");
  const segments: FileReferenceSegment[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    const end = index + match[0].length;
    // TIPS: 不把 longer-report.docx 的子串或路径中间部分误识别成独立文件引用。
    if (
      /[\p{L}\p{N}_.\/\\-]/u.test(text[index - 1] ?? "") ||
      /[\p{L}\p{N}_\/\\-]/u.test(text[end] ?? "")
    )
      continue;
    if (index > offset) segments.push({ text: text.slice(offset, index) });
    segments.push({
      text: match[0],
      target: resolveFileReference(match[0], targets)!,
    });
    offset = end;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset) });
  return segments.length ? segments : [{ text }];
}
