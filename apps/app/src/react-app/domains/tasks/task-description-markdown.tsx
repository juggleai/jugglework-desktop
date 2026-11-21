import {
  $applyNodeReplacement, $createTextNode, $getRoot, $getState, $isElementNode, $isLineBreakNode, $isTextNode, $setState,
  createEditor, createState, DecoratorNode, type LexicalNode,
} from "lexical";
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from "@lexical/list";
import { $isHeadingNode, $isQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createLinkNode, $isLinkNode, LinkNode } from "@lexical/link";
import {
  $convertFromMarkdownString, $convertToMarkdownString, HEADING, ORDERED_LIST, QUOTE,
  TEXT_FORMAT_TRANSFORMERS, UNORDERED_LIST, registerMarkdownShortcuts, type TextMatchTransformer,
} from "@lexical/markdown";
import { linkAddress, composerRichTheme } from "../session/surface/composer/markdown-editing";
export { registerMarkdownShortcuts, composerRichTheme };

const stringState = (key: string) => createState(key, { parse: (v) => typeof v === "string" ? v : "" });
const imageUrl = stringState("url");
const imageAlt = stringState("alt");
const mentionId = stringState("memberId");
const mentionName = stringState("memberName");
export class TaskMentionNode extends DecoratorNode<null> {
  $config() { return this.config("task-description-mention", { extends: DecoratorNode, stateConfigs: [mentionId, mentionName] }); }
  memberId(): string { return $getState(this, mentionId); }
  getTextContent(): string { return `@${$getState(this, mentionName)}`; }
  createDOM() {
    const span = document.createElement("span");
    span.className = "text-blue-10";
    span.textContent = this.getTextContent();
    return span;
  }
  updateDOM(prev: TaskMentionNode): boolean { return prev.getTextContent() !== this.getTextContent(); }
  decorate() { return null; }
}
export function $createTaskMention(id: string, name: string) {
  const node = $applyNodeReplacement(new TaskMentionNode());
  $setState(node, mentionId, id);
  $setState(node, mentionName, name);
  return node;
}

export function descriptionAddress(address: string, image = false) {
  const url = linkAddress(address);
  return url && (!image || /^https?:\/\//.test(url)) ? url : null;
}

export class TaskImageNode extends DecoratorNode<null> {
  $config() { return this.config("task-description-image", { extends: DecoratorNode, stateConfigs: [imageAlt, imageUrl] }); }
  createDOM() {
    const img = document.createElement("img");
    img.alt = this.getTextContent(); img.referrerPolicy = "no-referrer"; img.loading = "lazy"; img.draggable = false;
    img.className = imageClass;
    const src = descriptionAddress(this.getURL(), true);
    if (src) img.src = src;
    return img;
  }
  updateDOM(prev: TaskImageNode) { return prev.getURL() !== this.getURL() || prev.getTextContent() !== this.getTextContent(); }
  getTextContent(): string { return $getState(this, imageAlt); }
  getURL() { return $getState(this, imageUrl); }
  decorate() { return null; }
}
const imageClass = "inline-block max-h-24 max-w-full align-middle";

export function $createTaskImage(alt: string, url: string) {
  const node = $applyNodeReplacement(new TaskImageNode());
  $setState(node, imageAlt, alt);
  $setState(node, imageUrl, url);
  return node;
}

// The legacy field uses literal <u> tags. Match only this exact pair; all other
// HTML stays in text nodes. Let Lexical process emphasis inside the match.
const underline: TextMatchTransformer = {
  type: "text-match", dependencies: [], trigger: ">",
  importRegExp: /<u>(.+?)<\/u>/, regExp: /<u>(.+?)<\/u>$/,
  replace(node, [, text]) {
    node.setTextContent(text);
    if (!node.hasFormat("underline")) node.toggleFormat("underline");
    return node;
  },
  export(node, _, format) {
    return $isTextNode(node) && node.hasFormat("underline") ? format(node, `<u>${node.getTextContent()}</u>`) : null;
  },
};

const label = (value: string) => value.replace(/([\\\[\]])/g, "\\$1");
const resource: TextMatchTransformer = {
  type: "text-match", dependencies: [LinkNode, TaskImageNode, TaskMentionNode], trigger: ")",
  importRegExp: /(!?)\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/,
  regExp: /(!?)\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)$/,
  replace(node, [, image, rawLabel, address]) {
    const text = rawLabel.replace(/\\([\\\[\]])/g, "$1");
    if (!image && text.startsWith("@") && /^task-member:[^\s()]+$/.test(address)) {
      try { node.replace($createTaskMention(decodeURIComponent(address.slice(12)), text.slice(1))); } catch { /* malformed reference remains plain text */ }
      return;
    }
    const url = descriptionAddress(address, !!image);
    if (!url) return; // Preserve unsupported targets as inert, editable text.
    if (image) { node.replace($createTaskImage(text, url)); return; }
    const child = $createTextNode(text).setFormat(node.getFormat());
    node.replace($createLinkNode(url).append(child));
    return child;
  },
  export(node, children) {
    if (node instanceof TaskMentionNode) return `[${label(node.getTextContent())}](task-member:${encodeURIComponent(node.memberId()).replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
    if (node instanceof TaskImageNode) return `![${label(node.getTextContent())}](${node.getURL()})`;
    if ($isLinkNode(node)) return `[${children(node).replace(/([\[\]])/g, "\\$1")}](${node.getURL()})`;
    return null;
  },
};

export const descriptionNodes = [HeadingNode, QuoteNode, ListItemNode, ListNode, LinkNode, TaskImageNode, TaskMentionNode];
export const descriptionTransformers = [HEADING, QUOTE, ORDERED_LIST, UNORDERED_LIST, ...TEXT_FORMAT_TRANSFORMERS, underline, resource];

export function $readDescription(markdown: string) {
  // Lexical 0.35 decodes numeric entities with String.fromCodePoint; out-of-range
  // entities in existing plain descriptions must not break opening a task.
  const source = markdown.replace(/&#(\d+);/g, (raw, n) => Number(n) > 0x10ffff ? `&#38;${raw.slice(1)}` : raw);
  $convertFromMarkdownString(source.replace(/\r\n?/g, "\n"), descriptionTransformers, undefined, true);
}

export function $writeDescription() {
  return $convertToMarkdownString(descriptionTransformers, undefined, true);
}

// Render the same parsed nodes without an editable root, focusable links or
// injected HTML. This also leaves read-only descriptions in the accessibility tree.
function $previewNode(node: LexicalNode): React.ReactNode {
  const key = node.getKey();
  if (node instanceof TaskMentionNode) return <span key={key} className="text-blue-10">{node.getTextContent()}</span>;
  if ($isLineBreakNode(node)) return <br key={key} />;
  if ($isTextNode(node)) {
    let text: React.ReactNode = node.getTextContent();
    if (node.hasFormat("code")) text = <code>{text}</code>;
    if (node.hasFormat("bold")) text = <strong>{text}</strong>;
    if (node.hasFormat("italic")) text = <em>{text}</em>;
    if (node.hasFormat("underline")) text = <u>{text}</u>;
    if (node.hasFormat("strikethrough")) text = <s>{text}</s>;
    if (node.hasFormat("highlight")) text = <mark>{text}</mark>;
    return <span key={key}>{text}</span>;
  }
  if (node instanceof TaskImageNode) return <img key={key} src={node.getURL()} alt={node.getTextContent()} className={imageClass} referrerPolicy="no-referrer" loading="lazy" draggable={false} />;
  if (!$isElementNode(node)) return null;
  const children = node.getChildren().map($previewNode);
  if ($isLinkNode(node)) return <span key={key} className="text-blue-10 underline">{children}</span>;
  if ($isQuoteNode(node)) return <blockquote key={key} className="border-l-2 border-dls-border pl-3 text-dls-secondary">{children}</blockquote>;
  if ($isListNode(node)) return node.getListType() === "number" ? <ol key={key} start={node.getStart()} className="list-decimal pl-7">{children}</ol> : <ul key={key} className="list-disc pl-7">{children}</ul>;
  if ($isListItemNode(node)) return <li key={key}>{children}</li>;
  if ($isHeadingNode(node)) { const Tag = node.getTag(); return <Tag key={key} className="font-bold">{children}</Tag>; }
  return <p key={key}>{children.length ? children : <br />}</p>;
}

export function renderDescription(markdown: string) {
  const doc = createEditor({ nodes: descriptionNodes, onError: error => { throw error; } });
  doc.update(() => $readDescription(markdown), { discrete: true });
  return doc.getEditorState().read(() => $getRoot().getChildren().map($previewNode));
}
