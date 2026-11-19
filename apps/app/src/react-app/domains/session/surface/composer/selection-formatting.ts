import { $addUpdateTag, $createParagraphNode, $isElementNode, $isTextNode, FORMAT_TEXT_COMMAND, HISTORY_PUSH_TAG, type LexicalEditor, type RangeSelection } from "lexical";
import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import { $isLinkNode } from "@lexical/link";
import { $editingBlock } from "./markdown-editing";

export { markdownLink } from "./markdown-editing";
export const blockStyles = ["body", "h1", "h2", "h3", "ordered", "bullet"] as const;
export type BlockStyle = typeof blockStyles[number];

function selectedBlocks(selection: RangeSelection) {
  return [...new Set(selection.getNodes().map($editingBlock).filter(b => b && !$isListNode(b)))];
}

export function $selectionFormatInfo(selection: RangeSelection) {
  const blocks = selectedBlocks(selection);
  if (!blocks.length || blocks.some(b => !b || !["heading", "paragraph", "listitem"].includes(b.getType())) || !selection.getTextContent().trim()) return null;
  const block = blocks[0];
  const list = block?.getParent();
  const style = $isHeadingNode(block) ? block.getTag() : $isListNode(list) ? (list.getListType() === "number" ? "ordered" : "bullet") : "body";
  const plain = selection.getNodes().every(n => $isElementNode(n) || ($isTextNode(n) && n.isSimpleText()) || n.getType() === "linebreak");
  const link = selection.anchor.getNode().getParent();
  return { style, inline: plain, link: plain && blocks.length === 1, url: $isLinkNode(link) ? link.getURL() : "",
    bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic") };
}

export function $applyBlockStyle(selection: RangeSelection, style: BlockStyle) {
  $addUpdateTag(HISTORY_PUSH_TAG);
  for (const block of selectedBlocks(selection)) {
    if (!block || !["heading", "paragraph", "listitem"].includes(block.getType())) continue;
    if (style === "bullet" || style === "ordered") {
      const type = style === "bullet" ? "bullet" : "number";
      const parent = block.getParent();
      if ($isListNode(parent) && parent.getListType() === type) continue;
      const paragraph = $isListItemNode(block) ? block.replace($createParagraphNode(), true) : block;
      const list = $createListNode(type);
      const item = $createListItemNode();
      item.append(...paragraph.getChildren());
      paragraph.replace(list.append(item));
    } else {
      block.replace(style === "body" ? $createParagraphNode() : $createHeadingNode(style), true);
    }
  }
}

export function $applyInlineStyle(editor: LexicalEditor, _selection: RangeSelection, format: "bold" | "italic") {
  editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
}
