import { badgeVariants } from "@/components/ui/badge";
import { $applyNodeReplacement, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode, $nodesOfType, TextNode, type NodeKey, type SerializedTextNode, type Spread } from "lexical";
import { cloudDocToken, mergeCloudDocReferences, type CloudDocReference } from "@/app/lib/cloud-doc-reference";
import { readDenSettings } from "@/app/lib/den";
import { t } from "@/i18n";

type SerializedCloudDocNode = Spread<{ type: "cloud-doc"; version: 1; reference: CloudDocReference }, SerializedTextNode>;

/** 输入框内的云文档原子标签；与普通提及一样参与删除、草稿保存和恢复。 */
export class ComposerCloudDocNode extends TextNode {
  __reference: CloudDocReference;
  static override getType() { return "cloud-doc"; }
  static override clone(node: ComposerCloudDocNode) { return new ComposerCloudDocNode(node.__reference, node.__key); }
  static override importJSON(node: SerializedCloudDocNode) { return $createCloudDocNode(node.reference); }
  constructor(reference: CloudDocReference, key?: NodeKey) {
    super(cloudDocToken(reference), key);
    this.__reference = reference;
  }
  override exportJSON(): SerializedCloudDocNode { return { ...super.exportJSON(), type: "cloud-doc", version: 1, reference: this.__reference }; }
  override createDOM() {
    const dom = document.createElement("span");
    dom.className = `${badgeVariants({ variant: "secondary" })} cursor-pointer`;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "2"); icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round"); icon.setAttribute("aria-hidden", "true"); icon.setAttribute("class", "size-3 shrink-0");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // TIPS: Lexical 标签使用 DOM 节点，沿用 lucide Cloud 的图形和项目 Badge 样式。
    path.setAttribute("d", "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z");
    icon.append(path);
    const ref = this.__reference;
    const label = document.createElement("span");
    label.textContent = `${t("cloud_docs.reference_label")} · ${ref.title || t("cloud_docs.untitled")}${ref.blockIds?.length ? ` · ${t("cloud_docs.reference_blocks", { count: String(ref.blockIds.length) })}` : ""}`;
    dom.append(icon, label);
    const settings = readDenSettings();
    dom.title = `${ref.title}\n${settings.activeOrgId === ref.tenantId ? settings.activeOrgName || ref.tenantId : ref.tenantId}${ref.blockIds?.length ? `\n${t("cloud_docs.reference_blocks", { count: String(ref.blockIds.length) })}` : ""}`;
    dom.contentEditable = "false";
    dom.setAttribute("role", "button");
    dom.tabIndex = 0;
    dom.dataset.cloudDocReference = cloudDocToken(ref);
    return dom;
  }
  override updateDOM() { return true; }
  override canInsertTextBefore(): false { return false; }
  override canInsertTextAfter(): false { return false; }
  override isTextEntity(): true { return true; }
  override isToken(): true { return true; }
}

/** 创建一个只含定位信息的云文档标签节点。 */
export function $createCloudDocNode(reference: CloudDocReference) {
  return $applyNodeReplacement(new ComposerCloudDocNode(reference));
}

/** 在当前光标处插入标签；已有文档合并选区，粘贴校验只替换仍存在的原链接。 */
export function $insertCloudDocReference(reference: CloudDocReference, options?: { mention?: boolean; link?: string }) {
  const nodes = $nodesOfType(ComposerCloudDocNode);
  const refs = mergeCloudDocReferences(nodes.map(node => node.__reference), reference);
  const merged = refs.find(ref => ref.tenantId === reference.tenantId && ref.workspaceId === reference.workspaceId && ref.docId === reference.docId)!;
  let linkNode: TextNode | undefined;
  if (options?.link) {
    linkNode = $nodesOfType(TextNode).find(node => node.getType() === "text" && node.getTextContent().includes(options.link!));
    if (!linkNode) return;
  }
  let selection = $getSelection();
  if (options?.mention && $isRangeSelection(selection)) {
    const node = selection.anchor.getNode();
    if ($isTextNode(node)) {
      const offset = selection.anchor.offset;
      const match = /@([^\s@]*)$/.exec(node.getTextContent().slice(0, offset));
      if (match) { selection.anchor.set(node.getKey(), offset - match[0].length, "text"); selection.focus.set(node.getKey(), offset, "text"); }
    }
  }
  if (linkNode && options?.link) {
    const start = linkNode.getTextContent().indexOf(options.link);
    linkNode.select(start, start + options.link.length);
  }
  const prior = nodes.find(node => node.__reference.tenantId === reference.tenantId && node.__reference.workspaceId === reference.workspaceId && node.__reference.docId === reference.docId);
  if (prior) {
    if (options?.mention || linkNode) { const selected = $getSelection(); if ($isRangeSelection(selected)) selected.insertText(""); }
    prior.replace($createCloudDocNode(merged));
    return;
  }
  selection = $getSelection();
  if (!$isRangeSelection(selection)) { $getRoot().selectEnd(); selection = $getSelection(); }
  if ($isRangeSelection(selection)) selection.insertNodes([$createCloudDocNode(merged), $createTextNode(" ")]);
}
