/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useFileReferences, useOpenTargets } from "@/lib/target-provider";
import { resolveFileReference } from "@/lib/file-references";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

import { applyTextHighlights } from "./text-highlights";
import {
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
  syncMarkdownImagePreviews,
} from "./markdown-primitive";
import { useCodeBlockCopy } from "./use-code-block-copy";

export { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "./markdown-primitive";

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

function localPathFromHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed || trimmed.startsWith("#") || /^(?:https?|mailto):/i.test(trimmed)) {
    return "";
  }

  if (/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = decodeURIComponent(parsed.hostname);
      const pathname = decodeURIComponent(parsed.pathname);
      const localPath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;

      if (host && host !== "localhost") {
        return `//${host}${localPath.startsWith("/") ? localPath : `/${localPath}`}`;
      }

      return localPath;
    } catch {
      return "";
    }
  }

  return trimmed.split(/[?#]/)[0] ?? trimmed;
}

function normalizeFilePathForMatch(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "")
    .replace(/[/]+$/, "");
}

function filePathMatchesTarget(path: string, targetValue: string) {
  const normalizedPath = normalizeFilePathForMatch(path);
  const normalizedTarget = normalizeFilePathForMatch(targetValue);

  return normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`);
}

function openTargetForHref(href: string, openTargets: OpenTarget[]) {
  const path = localPathFromHref(href);

  if (!path) {
    return null;
  }

  const matches = openTargets.filter((target) => target.kind === "file" && target.exists === true && filePathMatchesTarget(path, target.value));
  return matches.length === 1 ? matches[0]! : null;
}

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
} & Omit<
  React.ComponentProps<typeof motion.div>,
  "ref" | "className" | "children" | "dangerouslySetInnerHTML"
>;

function MarkdownBlockInner({
  className,
  text,
  streaming,
  highlightQuery,
  ...props
}: MarkdownBlockInnerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useCodeBlockCopy(rootRef);
  const { openTargets, onOpenTarget } = useOpenTargets();
  const references = useFileReferences();
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const syncHtml = useMemo(() => {
    return renderMarkdownHtml(text, "chat", references);
  }, [text, references]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; references: OpenTarget[]; html: string } | null>(null);

  useEffect(() => {
    if (streaming || !hasFencedCodeBlock(text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void renderHighlightedMarkdownHtml(text, "chat", references).then((html) => {
      if (!cancelled && html.trim()) {
        setHighlightedHtml({ text, references, html });
      }
    }).catch(() => {
      if (!cancelled) {
        setHighlightedHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [streaming, text, references]);

  const html = !streaming && highlightedHtml?.text === text && highlightedHtml.references === references ? highlightedHtml.html : syncHtml;

  // Re-apply search highlights after EVERY render (no dependency array on
  // purpose): motion.div re-sets dangerouslySetInnerHTML on unrelated
  // re-renders (e.g. open-target context updates), silently wiping the
  // <mark> nodes without `html`/`highlightQuery` changing. With no active
  // query this is a single querySelector fast path.
  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) {
        return;
      }

      applyTextHighlights(root, highlightQuery ?? "");
    });
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const sync = () => syncMarkdownImagePreviews(root);

    sync();

    const handleLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) sync();
    };

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const link = event.target.closest("a[data-jugglework-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.juggleworkLinkHref ?? link.getAttribute("href") ?? "";
        const target = resolveFileReference(href, references) ?? openTargetForHref(href, openTargets);

        if (target && onOpenTarget) {
          event.preventDefault();
          onOpenTarget(target);
          return;
        }
      }

      const preview = event.target.closest("[data-jugglework-image-preview]");
      if (!(preview instanceof HTMLElement)) return;

      event.preventDefault();
      event.stopPropagation();
      const image = preview.querySelector("img");
      if (!(image instanceof HTMLImageElement) || !image.src) return;
      setImagePreview({ src: image.src, alt: image.alt || "Image" });
    };

    root.addEventListener("load", handleLoad, true);
    root.addEventListener("click", handleClick);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
    };
  }, [html, onOpenTarget, openTargets, references]);

  if (!html) {
    return null;
  }

  return (
    <>
      <motion.div
        ref={rootRef}
        className={cn("markdown-content max-w-none text-foreground", className)}
        dangerouslySetInnerHTML={{ __html: html }}
        {...props}
      />
      <Dialog
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
      >
        <DialogContent className="max-h-[90vh] w-auto max-w-[min(90vw,56rem)] overflow-hidden border-none bg-transparent p-0 shadow-none sm:max-w-[min(90vw,56rem)]">
          <DialogTitle className="sr-only">{imagePreview?.alt ?? "Image"}</DialogTitle>
          {imagePreview ? (
            <img
              src={imagePreview.src}
              alt={imagePreview.alt}
              className="max-h-[85vh] w-auto max-w-full rounded-xl object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
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
