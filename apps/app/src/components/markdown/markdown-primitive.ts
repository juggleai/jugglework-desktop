import DOMPurify from "dompurify";
import emojiKeywords from "emojilib";
import { Marked, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
import markedShiki from "marked-shiki";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { bundledLanguages, codeToHtml } from "shiki";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { resolveFileReference, splitFileReferences } from "@/lib/file-references";

export type MarkdownPresentation = "chat" | "surface" | "surface-copyable";
type RawHtmlMode = "passthrough" | "shiki-only";
type ShikiThemeConfig =
  | { kind: "single"; theme: string }
  | { kind: "dual"; light: string; dark: string };

type MarkdownProfile = {
  rawHtmlMode: RawHtmlMode;
  headingClassName: (depth: number) => string;
  listClassName: (ordered: boolean) => string;
  blockquoteClassName: string;
  codeBlockHtml: (text: string, lang: string | undefined) => string;
  codeSpanClassName: string;
  linkPresentation: "chat" | "simple";
  imagePresentation: "chat" | "simple";
  tableWrapperClassName: string;
  tableHeaderClassName: string;
  tableCellClassName: string;
  shikiContainer: string;
  shikiTheme: ShikiThemeConfig;
};

const MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT = 160;
const MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH = 280;
const CODE_COPY_ICON = `<svg data-jugglework-code-copy-icon="" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CODE_COPIED_ICON = `<svg data-jugglework-code-copy-check-icon="" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true" hidden><path d="M20 6 9 17l-5-5"/></svg>`;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function safeHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed) {
    return "#";
  }

  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);

    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return trimmed;
    }
  } catch {
    return "#";
  }

  return "#";
}

function alignAttribute(align: Tokens.TableCell["align"]) {
  return align ? ` style="text-align: ${align}"` : "";
}

function codeLanguageClass(lang: string | undefined) {
  const normalized = lang?.trim().split(/\s+/)[0];

  return normalized ? ` class="language-${escapeAttribute(normalized)}"` : "";
}

function createEmojiAliases() {
  const aliases: Record<string, string> = {};

  for (const [emoji, names] of Object.entries(emojiKeywords)) {
    for (const name of names) {
      if (!aliases[name]) {
        aliases[name] = emoji;
      }
    }
  }

  return aliases;
}

const emojiAliases = createEmojiAliases();

function codeCopyButton() {
  return `<button type="button" data-jugglework-code-copy="" class="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Copy code block" title="Copy code block">${CODE_COPY_ICON}${CODE_COPIED_ICON}<span data-jugglework-code-copy-label="" class="sr-only" aria-live="polite">Copy code block</span></button>`;
}

function chatCodeBlockContainer(html: string, shiki: boolean) {
  const shikiAttribute = shiki ? ` data-jugglework-shiki="true"` : "";

  return `<div data-jugglework-code-block=""${shikiAttribute} class="relative my-4 overflow-hidden rounded-[18px] border border-border/70 bg-gray-2/60 font-mono text-xs leading-6 text-foreground">${codeCopyButton()}${html}</div>`;
}

function chatCodeBlockHtml(text: string, lang: string | undefined) {
  return chatCodeBlockContainer(
    `<pre class="overflow-x-auto px-4 pb-3 pt-11"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`,
    false,
  );
}

function surfaceCodeBlockHtml(text: string, lang: string | undefined) {
  return `<pre class="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
}

function surfaceCopyableCodeBlockContainer(html: string, shiki: boolean) {
  const shikiAttribute = shiki ? ` data-jugglework-shiki="true"` : "";
  return `<div data-jugglework-code-block=""${shikiAttribute} class="relative my-4 overflow-hidden rounded-[18px] border border-dls-border/70 bg-gray-1/80 text-xs leading-6 text-muted-foreground">${codeCopyButton()}${html}</div>`;
}

function surfaceCopyableCodeBlockHtml(text: string, lang: string | undefined) {
  if (lang?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") return surfaceCodeBlockHtml(text, lang);
  return surfaceCopyableCodeBlockContainer(
    `<pre class="overflow-x-auto px-4 pb-3 pt-11"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`,
    false,
  );
}

function parseShikiLanguage(lang: string) {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return normalized in bundledLanguages ? normalized : "text";
}

export function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

export function syncMarkdownImagePreviews(root: HTMLElement) {
  const previews = root.querySelectorAll("[data-jugglework-image-preview]");

  for (const preview of previews) {
    if (!(preview instanceof HTMLElement)) continue;

    const image = preview.querySelector("img");
    if (!(image instanceof HTMLImageElement)) continue;

    image.style.maxHeight = `${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px`;
    image.style.maxWidth = `${MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH}px`;
  }
}

export function setCodeCopyButtonState(button: HTMLButtonElement, copied: boolean) {
  const label = button.querySelector("[data-jugglework-code-copy-label]");
  if (label) label.textContent = copied ? "Code block copied" : "Copy code block";

  button.querySelector("[data-jugglework-code-copy-icon]")?.toggleAttribute("hidden", copied);
  button.querySelector("[data-jugglework-code-copy-check-icon]")?.toggleAttribute("hidden", !copied);

  button.title = copied ? "Copied" : "Copy code block";
  button.setAttribute("aria-label", copied ? "Code block copied" : "Copy code block");
}

function sanitizeMarkdownHtml(value: string) {
  if (typeof DOMPurify.sanitize !== "function") {
    return value;
  }

  return DOMPurify.sanitize(value, {
    ADD_ATTR: [
      "checked",
      "class",
      "data-jugglework-code-block",
      "data-jugglework-code-copy",
      "data-jugglework-code-copy-check-icon",
      "data-jugglework-code-copy-icon",
      "data-jugglework-code-copy-label",
      "aria-label",
      "data-jugglework-image-preview",
      "data-jugglework-link-href",
      "data-jugglework-shiki",
      "decoding",
      "disabled",
      "hidden",
      "loading",
      "rel",
      "start",
      "style",
      "target",
    ],
  });
}

function markdownProfileForPresentation(presentation: MarkdownPresentation): MarkdownProfile {
  if (presentation === "surface" || presentation === "surface-copyable") {
    const copyable = presentation === "surface-copyable";
    return {
      rawHtmlMode: "shiki-only",
      headingClassName: (depth) => depth === 1
        ? "my-5 text-xl font-semibold"
        : depth === 2
          ? "my-4 text-lg font-semibold"
          : "my-3 text-base font-semibold",
      listClassName: (ordered) => ordered ? "my-3 list-decimal pl-6" : "my-3 list-disc pl-6",
      blockquoteClassName: "my-4 rounded-lg bg-dls-hover/40 px-4 py-0.5 italic text-muted-foreground",
      codeBlockHtml: copyable ? surfaceCopyableCodeBlockHtml : surfaceCodeBlockHtml,
      codeSpanClassName: "rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground",
      linkPresentation: "simple",
      imagePresentation: "simple",
      tableWrapperClassName: "rounded-lg border border-dls-border",
      tableHeaderClassName: "border border-dls-border bg-dls-hover p-2 text-left",
      tableCellClassName: "border border-dls-border p-2 align-top",
      shikiContainer: copyable
        ? surfaceCopyableCodeBlockContainer(`<div class="overflow-x-auto px-4 pb-3 pt-11">%s</div>`, true)
        : `<div data-jugglework-shiki="true" class="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 p-4 text-xs leading-6">%s</div>`,
      shikiTheme: { kind: "single", theme: "github-light" },
    };
  }

  return {
    rawHtmlMode: "passthrough",
    headingClassName: (depth) => depth === 1
      ? "font-semibold my-5 text-xl"
      : depth === 2
        ? "font-semibold my-4 text-lg"
        : "font-semibold my-3 text-base",
    listClassName: (ordered) => ordered ? "my-3 pl-6 list-decimal" : "my-3 pl-6 list-disc",
    blockquoteClassName: "my-4 rounded-lg bg-muted/40 px-4 py-0.5 italic text-muted-foreground",
    codeBlockHtml: chatCodeBlockHtml,
    codeSpanClassName: "rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground",
    linkPresentation: "chat",
    imagePresentation: "chat",
    tableWrapperClassName: "rounded-lg border border-border",
    tableHeaderClassName: "border border-border p-2 bg-muted text-left",
    tableCellClassName: "border border-border p-2 align-top",
    shikiContainer: chatCodeBlockContainer(`<div class="overflow-x-auto px-4 pb-3 pt-11">%s</div>`, true),
    shikiTheme: { kind: "dual", light: "github-light", dark: "github-dark" },
  };
}

const LINK_CLASS = "text-indigo-10 no-underline transition-colors hover:text-indigo-8";

function renderLink(profile: MarkdownProfile, href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  const targetAttr = profile.linkPresentation === "chat" ? ` data-jugglework-link-href="${escapeAttribute(href)}"` : "";
  return `<a href="${safe}"${targetAttr}${titleAttr} target="_blank" rel="noreferrer noopener" class="${LINK_CLASS}">${text}</a>`;
}

function renderImage(profile: MarkdownProfile, href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  if (profile.imagePresentation === "chat") {
    return `<button type="button" data-jugglework-image-preview="" class="my-4 inline-block max-w-full cursor-zoom-in align-top text-left transition-opacity hover:opacity-90" aria-label="Expand ${escapeAttribute(text)}"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto w-auto rounded-lg border border-border/70 object-contain" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px; max-width: ${MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH}px"></button>`;
  }

  return `<img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="my-4 max-w-full rounded-[18px] border border-dls-border/70">`;
}

function renderFileReference(target: OpenTarget, label: string) {
  return `<a href="./${escapeAttribute(encodeURI(target.value))}" data-jugglework-link-href="${escapeAttribute(target.value)}" data-jugglework-artifact-link="true" class="${LINK_CLASS}">${label}</a>`;
}

function createMarkedOptions(profile: MarkdownProfile, isAsync: boolean, references: OpenTarget[] = []) {
  let linkDepth = 0;
  return {
    async: isAsync,
    breaks: false,
    gfm: true,
    pedantic: false,
    silent: true,
    renderer: {
      text(token) {
        if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
        if (linkDepth || !references.length) return token.text;
        return splitFileReferences(token.text, references)
          .map((part) => part.target ? renderFileReference(part.target, part.text) : part.text).join("");
      },
      html({ text }) {
        return profile.rawHtmlMode === "shiki-only" && !text.includes('data-jugglework-shiki="true"') ? "" : text;
      },
      paragraph({ tokens }) {
        return `<p class="my-3 leading-relaxed">${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        return `<h${depth} class="${profile.headingClassName(depth)}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const start = token.ordered && typeof token.start === "number" && token.start !== 1
          ? ` start="${token.start}"`
          : "";
        return `<${tag}${start} class="${profile.listClassName(token.ordered)}">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
      },
      listitem(item) {
        const checkbox = item.task
          ? `<input disabled="" type="checkbox"${item.checked ? " checked=\"\"" : ""}> `
          : "";

        return `<li class="my-1">${checkbox}${this.parser.parse(item.tokens)}</li>`;
      },
      blockquote({ tokens }) {
        return `<blockquote class="${profile.blockquoteClassName}">${this.parser.parse(tokens)}</blockquote>`;
      },
      code({ text, lang }) {
        return profile.codeBlockHtml(text, lang);
      },
      codespan({ text }) {
        // TIPS: 链接标签中的行内代码只保留文字，避免继承代码底色形成文件胶囊。
        if (linkDepth) return escapeHtml(text);
        const target = resolveFileReference(text, references);
        if (target) return renderFileReference(target, escapeHtml(text));
        return `<code class="${profile.codeSpanClassName}">${escapeHtml(text)}</code>`;
      },
      del({ raw, tokens }) {
        if (!raw.startsWith("~~")) {
          return escapeHtml(raw);
        }

        return `<del>${this.parser.parseInline(tokens)}</del>`;
      },
      link({ href, title, tokens }) {
        // TIPS: 链接标签内部不能再自动插入文件链接，避免嵌套 a 标签及错误点击目标。
        linkDepth += 1;
        let label: string;
        try {
          label = this.parser.parseInline(tokens);
        } finally {
          linkDepth -= 1;
        }
        const target = resolveFileReference(href, references);
        return target ? renderFileReference(target, label) : renderLink(profile, href, title, label);
      },
      image({ href, title, text }) {
        return renderImage(profile, href, title, text);
      },
      table(token) {
        const header = token.header.map((cell) => this.tablecell({ ...cell, header: true })).join("");
        const body = token.rows.map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") })).join("");

        // The wrapper owns the outer border and rounded clipping; outer cell
        // edges are removed so the collapsed table border cannot square the corners.
        return `<div data-jugglework-markdown-table="" class="my-4 w-full overflow-x-auto ${profile.tableWrapperClassName}"><table class="w-full min-w-max border-collapse [&_tr>*:first-child]:border-l-0 [&_tr>*:last-child]:border-r-0 [&_thead_tr>*]:border-t-0 [&_tbody_tr:last-child>*]:border-b-0"><thead>${this.tablerow({ text: header })}</thead><tbody>${body}</tbody></table></div>`;
      },
      tablerow({ text }) {
        return `<tr>${text}</tr>`;
      },
      tablecell({ tokens, header, align }) {
        const tag = header ? "th" : "td";
        const className = header ? profile.tableHeaderClassName : profile.tableCellClassName;

        return `<${tag}${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</${tag}>`;
      },
      hr() {
        return `<hr class="my-6 border-none h-px bg-gray-4">`;
      },
    },
  } satisfies ConstructorParameters<typeof Marked<string, string>>[0];
}

function markdownTransformers() {
  return [
    transformerNotationDiff({ matchAlgorithm: "v3" }),
    transformerNotationHighlight({ matchAlgorithm: "v3" }),
    transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
    transformerNotationFocus({ matchAlgorithm: "v3" }),
    transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
    transformerMetaHighlight(),
    transformerMetaWordHighlight(),
  ];
}

function createMarkdownParsers(presentation: MarkdownPresentation, references: OpenTarget[] = []) {
  const profile = markdownProfileForPresentation(presentation);
  const markdownParser = new Marked<string, string>(createMarkedOptions(profile, false, references)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
  );
  const highlightedMarkdownParser = new Marked<string, string>(createMarkedOptions(profile, true, references)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
    markedShiki({
      async highlight(code, lang, props) {
        const language = parseShikiLanguage(lang);

        if (profile.shikiTheme.kind === "dual") {
          return codeToHtml(code, {
            lang: language,
            meta: { __raw: props.join(" ") },
            themes: {
              light: profile.shikiTheme.light,
              dark: profile.shikiTheme.dark,
            },
            transformers: markdownTransformers(),
          });
        }

        return codeToHtml(code, {
          lang: language,
          meta: { __raw: props.join(" ") },
          theme: profile.shikiTheme.theme,
          transformers: markdownTransformers(),
        });
      },
      container: profile.shikiContainer,
    }),
  );

  return { markdownParser, highlightedMarkdownParser };
}

const chatParsers = createMarkdownParsers("chat");
const surfaceParsers = createMarkdownParsers("surface");
const copyableSurfaceParsers = createMarkdownParsers("surface-copyable");

function parsersForPresentation(presentation: MarkdownPresentation) {
  if (presentation === "surface") return surfaceParsers;
  if (presentation === "surface-copyable") return copyableSurfaceParsers;
  return chatParsers;
}

/** 渲染 Markdown；文件引用仅由调用方提供的当前轮次已确认目标生成。 */
export function renderMarkdownHtml(text: string, presentation: MarkdownPresentation = "chat", references: OpenTarget[] = []) {
  if (!text.trim()) {
    return "";
  }

  const { markdownParser } = references.length ? createMarkdownParsers(presentation, references) : parsersForPresentation(presentation);
  return sanitizeMarkdownHtml(markdownParser.parse(text, { async: false }));
}

/** 异步渲染语法高亮，并维持与同步渲染相同的文件引用范围。 */
export async function renderHighlightedMarkdownHtml(text: string, presentation: MarkdownPresentation = "chat", references: OpenTarget[] = []) {
  const { highlightedMarkdownParser } = references.length ? createMarkdownParsers(presentation, references) : parsersForPresentation(presentation);
  const html = await highlightedMarkdownParser.parse(text, { async: true });
  return sanitizeMarkdownHtml(html);
}
