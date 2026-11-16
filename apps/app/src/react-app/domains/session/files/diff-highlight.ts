import { bundledLanguages, codeToTokens } from "shiki";
import type { BundledLanguage } from "shiki";
import type { DiffHunk, DiffLine } from "./parse-unified-diff";

/** 一段代码的浅色、深色语法颜色；正文以 React 文本节点渲染。 */
export type DiffToken = { content: string; light?: string; dark?: string };
const extensions: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
  h: "c",
  cs: "csharp",
  kt: "kotlin",
  tex: "latex",
  htm: "html",
};

/** 按实际文件名识别语法；不认识的类型保留纯文本，不猜测其他语言。 */
export function diffLanguage(path: string): BundledLanguage | null {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const extension = name.split(".").pop() ?? "";
  const language =
    name === "dockerfile"
      ? "dockerfile"
      : name === "makefile"
        ? "makefile"
        : (extensions[extension] ?? extension);
  return language in bundledLanguages ? (language as BundledLanguage) : null;
}

/**
 * 分别着色每个 hunk 的旧、新源码，删除标记不进入语法解析。
 * @param path 文件路径
 * @param hunks 解析后的差异块
 */
export async function highlightDiffHunks(
  path: string,
  hunks: DiffHunk[],
): Promise<Map<DiffLine, DiffToken[]>> {
  const language = diffLanguage(path);
  const result = new Map<DiffLine, DiffToken[]>();
  if (!language) return result;
  // TIPS: 分离新旧两侧和不连续的 hunk，防止删除的引号、注释污染新增内容的语法状态。
  await Promise.all(
    hunks.flatMap((hunk) =>
      (["old", "new"] as const).map(async (side) => {
        const lines = hunk.lines.filter(
          (line) =>
            line.kind !== "meta" &&
            line.kind !== (side === "old" ? "add" : "del"),
        );
        if (!lines.length) return;
        const { tokens } = await codeToTokens(
          lines.map((line) => line.content).join("\n"),
          {
            lang: language,
            themes: { light: "github-light", dark: "github-dark" },
          },
        );
        lines.forEach((line, index) => {
          if (side === "old" && line.kind === "context") return;
          result.set(
            line,
            (tokens[index] ?? []).map((token) => ({
              content: token.content,
              light: token.htmlStyle?.color,
              dark: token.htmlStyle?.["--shiki-dark"],
            })),
          );
        });
      }),
    ),
  );
  return result;
}
