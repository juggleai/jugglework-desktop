/** @jsxImportSource react */
import * as React from "react";
import type { DiffHunk, DiffLine } from "./parse-unified-diff";
import type { DiffToken } from "./diff-highlight";

/** 仅为已展开且大小适中的差异懒加载语法高亮，失败保留完整原文。 */
export function useDiffHighlight(path: string, hunks: DiffHunk[]) {
  const [highlight, setHighlight] = React.useState<{
    path: string;
    hunks: DiffHunk[];
    tokens: Map<DiffLine, DiffToken[]>;
  } | null>(null);
  React.useEffect(() => {
    let active = true;
    const lines = hunks.flatMap((hunk) => hunk.lines);
    if (
      !lines.length ||
      lines.length > 2000 ||
      lines.reduce((size, line) => size + line.content.length, 0) > 200_000
    )
      return;
    void import("./diff-highlight")
      .then((module) => module.highlightDiffHunks(path, hunks))
      .then((tokens) => {
        if (active) setHighlight({ path, hunks, tokens });
      })
      .catch(() => {
        /* 着色失败不影响查看 diff。 */
      });
    return () => {
      active = false;
    };
  }, [path, hunks]);
  return highlight?.hunks === hunks && highlight.path === path
    ? highlight.tokens
    : undefined;
}

/** 安全展示语法 token；不把文件内容作为 HTML 插入。 */
export function DiffCode({
  line,
  tokens,
}: {
  line: DiffLine;
  tokens?: Map<DiffLine, DiffToken[]>;
}) {
  const highlighted = tokens?.get(line);
  if (!highlighted?.length) return <>{line.content}</>;
  return (
    <>
      {highlighted.map((token, index) => (
        <span
          key={index}
          className="diff-code-token"
          style={
            {
              "--diff-light": token.light,
              "--diff-dark": token.dark ?? token.light,
            } as React.CSSProperties
          }
        >
          {token.content}
        </span>
      ))}
    </>
  );
}
