import {
  $addUpdateTag, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $getState, $setState,
  $isElementNode, $isLineBreakNode, $isParagraphNode, $isRangeSelection, $isTextNode, createState,
  COMMAND_PRIORITY_EDITOR, FORMAT_TEXT_COMMAND, HISTORY_PUSH_TAG, ParagraphNode, type TextNode, type ElementNode, type LexicalEditor, type LexicalNode, type RangeSelection,
} from "lexical";
import { $createListItemNode, $createListNode, $handleListInsertParagraph, $isListItemNode, $isListNode, registerList } from "@lexical/list";
import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import { $convertFromMarkdownString, BOLD_ITALIC_STAR, BOLD_STAR, ITALIC_STAR, INLINE_CODE, LINK, registerMarkdownShortcuts, HEADING, UNORDERED_LIST, type TextMatchTransformer } from "@lexical/markdown";

export const composerRichTheme = {
  heading: { h1: "my-3 text-[1.65em] leading-tight font-bold", h2: "my-2 text-[1.4em] leading-tight font-bold", h3: "my-1 text-[1.18em] leading-snug font-semibold" },
  list: { ol: "m-0 list-outside list-decimal pl-7", ul: "m-0 list-outside list-disc pl-7", listitem: "list-item" },
  link: "composer-rich-link",
  text: { bold: "font-bold", italic: "italic", code: "rounded bg-muted px-0.5 font-mono" },
};

export function linkAddress(address: string) {
  try {
    const url = new URL(address.trim());
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href.replace(/\(/g, "%28").replace(/\)/g, "%29") : null;
  } catch { return null; }
}

export function markdownLink(text: string, address: string) {
  const url = linkAddress(address);
  return url ? `[${text.replace(/[\\[\]]/g, "\\$&")}](${url})` : null;
}

const link: TextMatchTransformer = {
  ...LINK,
  importRegExp: /\[((?:\\.|[^\]\\])+)\]\(([^\s()]+)\)/,
  regExp: /\[((?:\\.|[^\]\\])+)\]\(([^\s()]+)\)$/,
  replace(node, [, label, target]) {
    const url = linkAddress(target);
    if (!url) return;
    const text = $createTextNode(label.replace(/\\([\\[\]])/g, "$1")).setFormat(node.getFormat());
    node.replace($createLinkNode(url).append(text));
    return text;
  },
};
const inline = [INLINE_CODE, BOLD_ITALIC_STAR, BOLD_STAR, ITALIC_STAR, link];
const markerState = createState("composerMarker", { parse: (value) => typeof value === "string" ? value : "" });
const listPrefix = /^([ \t]*)(?:(\d{1,9})([.)、．）])([ \t]+|(?=[^\s\d])|$)|([-+*])([ \t]+))/;

export function $editingBlock(node: LexicalNode | null): ElementNode | null {
  while (node && !($isElementNode(node) && !node.isInline())) node = node.getParent();
  return $isElementNode(node) ? node : null;
}

function restoreInline(paragraph: ElementNode) {
  // Tokenization can split otherwise ordinary text (e.g. an @ in a URL).
  // Parse contiguous plain spans together, leaving registered chips intact.
  let run: TextNode[] = [];
  for (const child of [...paragraph.getChildren(), null]) {
    if ($isTextNode(child) && child.isSimpleText()) { run.push(child); continue; }
    if (!run.length) continue;
    const text = run.map(node => node.getTextContent()).join("");
    if (/[*\x60]|\]\(/.test(text)) {
      const scratch = $createParagraphNode();
      $convertFromMarkdownString(text, inline, scratch, true);
      const parsed = scratch.getFirstChild();
      if ($isElementNode(parsed) && parsed.getChildren().some(n => $isLinkNode(n) || ($isTextNode(n) && n.getFormat()))) {
        for (const n of parsed.getChildren()) run[0].insertBefore(n);
        for (const n of run) n.remove();
      }
    }
    run = [];
  }
}

/** Restore persisted Markdown after attachment, mention and office tokens are resolved. */
export function $restoreRichDraft() {
  let fence = "";
  for (const p of $getRoot().getChildren()) {
    if (p.getType() !== "paragraph" || !$isParagraphNode(p)) continue;
    const source = p.getTextContent();
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(source);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1].startsWith(fence) && !boundary[2].trim()) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,3})[ \t]+/.exec(source);
    // Older submitted prompts may have had their final trailing space trimmed.
    const previous = p.getPreviousSibling();
    const trimmedBullet = /^[ \t]*[-+*]$/.test(source) && $isListNode(previous) && previous.getListType() === "bullet";
    const marker = listPrefix.exec(trimmedBullet ? source + " " : source);
    const first = p.getFirstChild();
    if ((heading || marker) && $isTextNode(first) && first.isSimpleText()) {
      first.spliceText(0, (heading ?? marker)![0].length, "");
    }
    restoreInline(p);
    if (heading) {
      p.replace($createHeadingNode((["h1","h2","h3"] as const)[heading[1].length - 1]), true);
    } else if (marker) {
      const type = marker[2] ? "number" : "bullet";
      const prev = p.getPreviousSibling();
      const list = $isListNode(prev) && prev.getListType() === type ? prev : $createListNode(type, Number(marker[2] ?? 1));
      if (list !== prev) p.insertBefore(list);
      const item = $createListItemNode();
      $setState(item, markerState, marker[0]);
      item.append(...p.getChildren());
      list.append(item);
      p.remove();
    }
  }
}

/** Serialize only real formatting. Ordinary code, paths, and chip tokens keep their literal text. */
export function $richDraftText(node: LexicalNode): string {
  if ($isListNode(node)) {
    return node.getChildren().map((item, index) => {
      const saved = $getState(item, markerState);
      const marker = node.getListType() === "number"
        ? (saved && /\d/.test(saved) ? saved : "  1. ").replace(/\d+/, String(node.getStart() + index))
        : (saved && !/\d/.test(saved) ? saved : "- ");
      return marker + $richDraftText(item);
    }).join("\n");
  }
  if ($isElementNode(node)) {
    const content = serializeInlineChildren(node);
    if ($isHeadingNode(node)) return "#".repeat(Number(node.getTag().slice(1))) + " " + content;
    if ($isLinkNode(node)) return markdownLink(content, node.getURL()) ?? content;
    return content;
  }
  const text = node.getTextContent();
  if (!$isTextNode(node) || !node.isSimpleText()) return text;
  const emphasis = "*".repeat((node.hasFormat("bold") ? 2 : 0) + (node.hasFormat("italic") ? 1 : 0));
  const code = node.hasFormat("code") ? "`" : "";
  return emphasis + code + text + code + emphasis;
}

// Keep shared emphasis open across runs, e.g. bold text containing a short
// italic selection serializes as **one *two* three** and reopens correctly.
function serializeInlineChildren(parent: ElementNode) {
  let output = "";
  let open: string[] = [];
  for (const child of parent.getChildren()) {
    const plain = $isTextNode(child) && child.isSimpleText();
    const marks = plain ? [
      ...(child.hasFormat("bold") ? ["**"] : []), ...(child.hasFormat("italic") ? ["*"] : []),
      ...(child.hasFormat("code") ? ["`"] : []),
    ] : [];
    const next = [...open.filter(mark => marks.includes(mark)), ...marks.filter(mark => !open.includes(mark))];
    let common = 0;
    while (common < open.length && open[common] === next[common]) common++;
    output += open.slice(common).reverse().join("") + next.slice(common).join("");
    output += plain ? child.getTextContent() : $richDraftText(child);
    open = next;
  }
  return output + open.reverse().join("");
}

// Normalize soft breaks from plain-text paste into editable blocks, preserving
// text-node selections and element-level carets immediately after a break.
function splitParagraphLines(p: ParagraphNode) {
  if (p.getType() !== "paragraph" || p.getParent()?.getType() !== "root") return;
  const children = p.getChildren();
  if (!children.some($isLineBreakNode)) return;
  const selection = $getSelection();
  const points = $isRangeSelection(selection) ? [selection.anchor, selection.focus]
    .filter(pt => pt.key === p.getKey()).map(pt => ({ pt, offset: pt.offset })) : [];
  let block = p;
  let offset = 0;
  for (const [i, child] of children.entries()) {
    for (const saved of points) if (saved.offset === i) saved.pt.set(block.getKey(), offset, "element");
    if ($isLineBreakNode(child)) {
      const next = $createParagraphNode();
      block.insertAfter(next);
      child.remove();
      block = next;
      offset = 0;
    } else {
      if (block !== p) block.append(child);
      offset++;
    }
  }
  for (const saved of points) if (saved.offset === children.length) saved.pt.set(block.getKey(), offset, "element");
}

export function registerComposerMarkdown(editor: LexicalEditor) {
  const offLines = editor.registerNodeTransform(ParagraphNode, splitParagraphLines);
  const offList = registerList(editor);
  const offShortcuts = registerMarkdownShortcuts(editor, [...inline, HEADING, UNORDERED_LIST]);
  const offFormat = editor.registerCommand(FORMAT_TEXT_COMMAND, format => {
    const range = $getSelection();
    if (!$isRangeSelection(range) || !["bold", "italic", "code"].includes(format) || $editingBlock(range.anchor.getNode())?.getType() === "composer-office-instruction") return false;
    $addUpdateTag(HISTORY_PUSH_TAG);
    range.formatText(format);
    return true;
  }, COMMAND_PRIORITY_EDITOR);
  return () => { offFormat(); offShortcuts(); offList(); offLines(); };
}

export function $startComposerList(selection: RangeSelection) {
  const block = $editingBlock(selection.anchor.getNode());
  if (!selection.isCollapsed() || block?.getType() !== "paragraph" || !/^[ \t]*1$/.test(block.getTextContent())) return false;
  const { anchor } = selection;
  if (anchor.type === "text" ? anchor.getNode() !== block.getLastChild() || anchor.offset !== anchor.getNode().getTextContentSize()
    : anchor.key !== block.getKey() || anchor.offset !== block.getChildrenSize()) return false;
  $addUpdateTag(HISTORY_PUSH_TAG);
  const list = $createListNode("number");
  const item = $createListItemNode();
  block.replace(list.append(item));
  item.select();
  return true;
}

export function $continueComposerList(selection: RangeSelection) {
  const block = $editingBlock(selection.anchor.getNode());
  if (!$isListItemNode(block)) return false;
  $addUpdateTag(HISTORY_PUSH_TAG);
  if (selection.isCollapsed() && !block.getTextContent().trim()) { block.clear(); block.select(); }
  if (!$handleListInsertParagraph()) {
    selection.insertParagraph();
    const current = $getSelection();
    const next = $isRangeSelection(current) ? $editingBlock(current.anchor.getNode()) : null;
    if ($isListItemNode(next)) {
      const marker = $getState(block, markerState);
      if (marker) $setState(next, markerState, marker.trimEnd() === marker ? marker + " " : marker);
    }
  }
  return true;
}
