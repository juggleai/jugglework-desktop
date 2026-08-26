/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { applyTextHighlights } from "@/components/markdown/text-highlights";
import { useCodeBlockCopy } from "@/components/markdown/use-code-block-copy";
import { t } from "../../../../i18n";
import {
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
} from "@/components/markdown/markdown-primitive";
import { hasMermaidCodeBlock, renderMermaidDiagrams, type MermaidTheme } from "../artifacts/mermaid-diagrams";

function MarkdownBlockInner(props: {
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
  mermaidTheme?: MermaidTheme;
  copyCodeBlocks?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useCodeBlockCopy(rootRef, props.copyCodeBlocks);
  const presentation = props.copyCodeBlocks ? "surface-copyable" : "surface";
  const syncHtml = useMemo(() => {
    return renderMarkdownHtml(props.text, presentation);
  }, [presentation, props.text]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);
  const containsMermaid = useMemo(() => Boolean(props.mermaidTheme && hasMermaidCodeBlock(props.text)), [props.mermaidTheme, props.text]);

  useEffect(() => {
    if (props.streaming || containsMermaid || !hasFencedCodeBlock(props.text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void renderHighlightedMarkdownHtml(props.text, presentation).then((html) => {
      if (!cancelled && html.trim()) setHighlightedHtml({ text: props.text, html });
    }).catch(() => {
      if (!cancelled) setHighlightedHtml(null);
    });
    return () => {
      cancelled = true;
    };
  }, [containsMermaid, presentation, props.streaming, props.text]);

  const html = !props.streaming && highlightedHtml?.text === props.text ? highlightedHtml.html : syncHtml;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) return;
      applyTextHighlights(root, props.highlightQuery ?? "");
    });
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || props.streaming || !containsMermaid) return;

    if (!props.mermaidTheme) return;

    renderMermaidDiagrams(root, props.mermaidTheme, {
      label: t("session_files.mermaid_label"),
      rendering: t("session_files.mermaid_rendering"),
      error: t("session_files.mermaid_error"),
    });
  }, [containsMermaid, html, props.mermaidTheme, props.streaming]);

  if (!html) return null;

  return (
    <div
      ref={rootRef}
      className="markdown-content max-w-none text-foreground"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Memoize so a message block that has already been rendered — the usual
 * case for every assistant bubble above the currently-streaming one —
 * doesn't re-parse its markdown on every token. Only re-renders when its
 * own text / streaming / highlightQuery props change.
 */
export const MarkdownBlock = memo(MarkdownBlockInner);
MarkdownBlock.displayName = "MarkdownBlock";
