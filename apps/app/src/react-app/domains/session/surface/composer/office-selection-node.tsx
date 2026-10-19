import { createContext, useContext } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import {
  DecoratorNode, ParagraphNode, $applyNodeReplacement, $createTextNode, $createLineBreakNode,
  $getRoot, $getSelection, $getNodeByKey, $isElementNode, $isTextNode, $isRangeSelection,
  KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND, KEY_ARROW_LEFT_COMMAND, KEY_ARROW_RIGHT_COMMAND,
  COMMAND_PRIORITY_HIGH, type LexicalNode, type NodeKey, type SerializedParagraphNode,
  type SerializedLexicalNode, type LexicalEditor, type DOMExportOutput,
} from "lexical";
import { RectangleHorizontal, SquareDashed, X } from "lucide-react";
import { ArtifactIcon } from "@/components/chat/artifact-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { useComposerStateStore, getComposerOfficeGroups } from "../composer-state-store";
import { officeInstructionToken, officeSelectionLabel, type OfficeComposerGroup } from "./office-selection-draft";

/** 标签由宿主登记引用，要求文字与普通输入共用 Lexical 的选区、删除和历史。 */
export const OfficeComposerContext = createContext<{ sessionId?: string; disabled?: boolean }>({});

/** 选区标签使用范围图标，文件类型图标仅用于悬停卡片的文件标题。 */
function SelectionIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind.startsWith("sheet-")) return <svg className={className} width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden><rect x={1.5} y={1.5} width={13} height={13} rx={3} /><path d="M5 5.5h6M8 5.5v5" strokeLinecap="round" /></svg>;
  const Icon = kind.startsWith("slide-") ? SquareDashed : RectangleHorizontal;
  return <Icon size={14} strokeWidth={1.5} className={className} aria-hidden />;
}

function OfficeSelectionTag({ instructionId, referenceId, nodeKey, label }: { instructionId: string; referenceId: string | null; nodeKey: NodeKey; label: string }) {
  const [editor] = useLexicalComposerContext();
  const context = useContext(OfficeComposerContext);
  const sessionId = context.sessionId ?? "";
  const group = useComposerStateStore((state) => getComposerOfficeGroups(state, sessionId).find((item) => item.instruction.instructionId === instructionId));
  const store = useComposerStateStore.getState();
  const remove = () => {
    if (context.disabled) return;
    editor.update(() => { const node = $getNodeByKey(nodeKey); if (node instanceof ComposerOfficeSelectionTagNode) $removeOfficeSelectionTag(node); });
    editor.focus();
  };
  if (group?.instruction.bindingState === "needs-selection") return <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400" contentEditable={false}>
    <span>请重新选择要修改的内容</span>
    <button type="button" disabled={context.disabled} onClick={() => { store.rebindOfficeInstruction(sessionId, instructionId); toast.info("请在文件中选择新内容，再点击 AI 编辑并添加"); }}>重新绑定</button>
    <button type="button" disabled={context.disabled} onClick={() => store.detachOfficeInstruction(sessionId, instructionId)}>改为普通文本</button>
  </span>;
  const ref = group?.references.find((item) => item.referenceId === referenceId);
  if (!ref) return <span className="text-muted-foreground" contentEditable={false}>{label}</span>;
  const kind = ref.locator.kind;
  const fileType = kind.startsWith("sheet-") ? "sheet" : kind.startsWith("slide-") ? "slides" : "document";
  return <Tooltip>
    <TooltipTrigger render={<span contentEditable={false} className="group/office-selection inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md bg-foreground/[0.055] px-1.5 align-middle text-[12px] font-medium leading-5 text-foreground transition-colors hover:bg-foreground/10 focus-within:bg-foreground/10" />}>
      <button type="button" disabled={context.disabled} className="relative inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`移除${officeSelectionLabel(ref)}`}
        onMouseDown={(event) => event.preventDefault()} onClick={remove}>
        <SelectionIcon kind={kind} className="group-hover/office-selection:opacity-0 group-focus-within/office-selection:opacity-0" />
        <X size={12} strokeWidth={1.5} className="absolute opacity-0 group-hover/office-selection:opacity-100 group-focus-within/office-selection:opacity-100" aria-hidden />
      </button>
      <button type="button" disabled={context.disabled} className="inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${officeSelectionLabel(ref)}：${ref.preview.name}，${ref.preview.range}`}
        onClick={() => { const reveal = window.__JUGGLEWORK_ELECTRON__?.office?.revealSelection; if (!reveal) { toast.info("请在文件编辑器中查看选区"); return; } void reveal({ workspaceId: ref.workspaceId, sessionId, referenceId: ref.referenceId }).catch((error) => toast.error(error instanceof Error ? error.message : String(error))); }}
        onKeyDown={(event) => { if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); remove(); } }}>
        {officeSelectionLabel(ref)}
      </button>
    </TooltipTrigger>
    {/* TIPS: 输入栏内部有滚动裁剪，复用 Portal 定位，卡片才能完整浮在输入框上方。 */}
    <TooltipContent side="top" align="start" alignOffset={0} sideOffset={6} hideArrow className="block w-[282px] max-w-[calc(100vw-24px)] rounded-2xl border bg-popover p-3 font-normal text-popover-foreground shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
      <span className="mb-1 flex items-center gap-1 text-[12px] leading-[18px] text-muted-foreground"><ArtifactIcon type={fileType} className="size-3.5 shrink-0 opacity-70" /><span className="truncate">{ref.preview.name}</span></span>
      <span className="line-clamp-2 break-words whitespace-pre-wrap text-[14px] leading-5">{fileType === "document" && ref.preview.text ? ref.preview.text : ref.preview.range}</span>
      {fileType === "slides" && ref.preview.text ? <span className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-[18px] text-muted-foreground">{ref.preview.text}</span> : null}
    </TooltipContent>
  </Tooltip>;
}

/** 指令组使用普通段落模型保存身份；标签之外的文字、换行、复制与撤销均由 Lexical 管理。 */
export class ComposerOfficeInstructionNode extends ParagraphNode {
  __instructionId: string;
  static override getType() { return "composer-office-instruction"; }
  static override clone(node: ComposerOfficeInstructionNode) { return new ComposerOfficeInstructionNode(node.__instructionId, node.__key); }
  static override importJSON(value: SerializedParagraphNode & { instructionId: string }) { return $applyNodeReplacement(new ComposerOfficeInstructionNode(value.instructionId)).updateFromJSON(value); }
  constructor(instructionId = "", key?: NodeKey) { super(key); this.__instructionId = instructionId; }
  override createDOM() { return document.createElement("p"); }
  override updateDOM() { return false; }
  override exportJSON(): SerializedParagraphNode & { instructionId: string } { return { ...super.exportJSON(), type: "composer-office-instruction", version: 2, instructionId: this.__instructionId }; }
}

/** 仅选区标签是原子节点；剪贴板文本使用可读标签，内部身份不导出为可见文字。 */
export class ComposerOfficeSelectionTagNode extends DecoratorNode<React.ReactNode> {
  __instructionId: string;
  __referenceId: string | null;
  __label: string;
  static override getType() { return "composer-office-selection-tag"; }
  static override importDOM() { return null; }
  static override clone(node: ComposerOfficeSelectionTagNode) { return new ComposerOfficeSelectionTagNode(node.__instructionId, node.__referenceId, node.__label, node.__key); }
  static override importJSON(value: SerializedLexicalNode & { instructionId: string; referenceId: string | null; label: string }) { return $applyNodeReplacement(new ComposerOfficeSelectionTagNode(value.instructionId, value.referenceId, value.label)); }
  constructor(instructionId = "", referenceId: string | null = null, label = "文档选区", key?: NodeKey) { super(key); this.__instructionId = instructionId; this.__referenceId = referenceId; this.__label = label; }
  override isInline() { return true; }
  override isKeyboardSelectable() { return false; }
  override getTextContent() { return this.__label; }
  override createDOM() { const element = document.createElement("span"); element.className = "mr-1 inline-block align-middle"; return element; }
  override updateDOM() { return false; }
  override exportDOM(): DOMExportOutput { return { element: document.createTextNode(this.__label) }; }
  override decorate() { return <OfficeSelectionTag instructionId={this.__instructionId} referenceId={this.__referenceId} nodeKey={this.__key} label={this.__label} />; }
  override exportJSON() { return { ...super.exportJSON(), type: "composer-office-selection-tag", version: 1, instructionId: this.__instructionId, referenceId: this.__referenceId, label: this.__label }; }
}

function $appendInstructionText(node: ComposerOfficeInstructionNode, text: string) {
  for (const [i, line] of text.split("\n").entries()) { if (i) node.append($createLineBreakNode()); if (line) node.append($createTextNode(line)); }
}

/** 由已登记草稿建立标签和正常文字；粘贴文本不创建执行引用。 */
export function $createOfficeInstructionNode(group: OfficeComposerGroup) {
  const node = $applyNodeReplacement(new ComposerOfficeInstructionNode(group.instruction.instructionId));
  $syncOfficeInstructionNode(node, group);
  return node;
}

/** 只同步外部新增、重新绑定和失效状态；正常键入不会重建文本或移动光标。 */
export function $syncOfficeInstructionNode(node: ComposerOfficeInstructionNode, group: OfficeComposerGroup) {
  const expected = group.instruction.bindingState === "needs-selection" ? [{ id: null, label: "待重新选择" }]
    : group.references.map((ref) => ({ id: ref.referenceId, label: officeSelectionLabel(ref) }));
  const tags = node.getChildren().filter((child): child is ComposerOfficeSelectionTagNode => child instanceof ComposerOfficeSelectionTagNode);
  if (tags.length !== expected.length || tags.some((tag, i) => tag.__referenceId !== expected[i].id)) {
    tags.forEach((tag) => tag.remove());
    for (const item of [...expected].reverse()) {
      const tag = $applyNodeReplacement(new ComposerOfficeSelectionTagNode(group.instruction.instructionId, item.id, item.label));
      const first = node.getFirstChild(); if (first) first.insertBefore(tag); else node.append(tag);
    }
  }
  const text = node.getChildren().filter((child) => !(child instanceof ComposerOfficeSelectionTagNode)).map((child) => child.getTextContent()).join("");
  if (text !== group.instruction.text) {
    node.getChildren().filter((child) => !(child instanceof ComposerOfficeSelectionTagNode)).forEach((child) => child.remove());
    $appendInstructionText(node, group.instruction.text);
  }
}

/** 从实际编辑树提取组内容；撤销恢复的旧标签只有展示身份，不能重新赋予已释放的执行权限。 */
export function $readOfficeComposerDraft(existing: OfficeComposerGroup[]) {
  const groups: OfficeComposerGroup[] = [];
  const serialize = (node: LexicalNode): string => {
    if (node instanceof ComposerOfficeInstructionNode) {
      const prior = existing.find((group) => group.instruction.instructionId === node.__instructionId);
      const children = node.getChildren();
      const tags = children.filter((child): child is ComposerOfficeSelectionTagNode => child instanceof ComposerOfficeSelectionTagNode);
      const references = prior?.references.filter((ref) => tags.some((tag) => tag.__referenceId === ref.referenceId)) ?? [];
      const text = children.filter((child) => !(child instanceof ComposerOfficeSelectionTagNode)).map((child) => child.getTextContent()).join("");
      groups.push({ references, instruction: { instructionId: node.__instructionId, text,
        ...(references.length ? { bindingState: "bound" as const, referenceIds: references.map((ref) => ref.referenceId) }
          : { bindingState: tags.length ? "needs-selection" as const : "detached" as const, referenceIds: [] as [] }) } });
      return officeInstructionToken(node.__instructionId);
    }
    return $isElementNode(node) ? node.getChildren().map(serialize).join("") : node.getTextContent();
  };
  return { draft: $getRoot().getChildren().map(serialize).join("\n"), groups };
}

/** 删除整个标签并回到其前方；行首标签优先回到上一行末尾，要求文字保留。 */
export function $removeOfficeSelectionTag(node: ComposerOfficeSelectionTagNode) {
  let cursor: LexicalNode = node;
  let previous = cursor.getPreviousSibling();
  while (!previous && cursor.getParent()?.isInline()) { cursor = cursor.getParent()!; previous = cursor.getPreviousSibling(); }
  if (!previous) previous = cursor.getTopLevelElement()?.getPreviousSibling() ?? null;
  const parent = node.getParent();
  node.remove();
  if (previous && ($isTextNode(previous) || $isElementNode(previous))) previous.selectEnd();
  else if (previous?.getParent()) { const owner = previous.getParent()!; const offset = previous.getIndexWithinParent() + 1; owner.select(offset, offset); }
  else parent?.selectStart();
}

function $adjacentOfficeTag(backward: boolean) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor.getNode();
  let candidate: LexicalNode | null = null;
  if ($isTextNode(anchor)) {
    if (selection.anchor.offset !== (backward ? 0 : anchor.getTextContentSize())) return null;
    candidate = backward ? anchor.getPreviousSibling() : anchor.getNextSibling();
  } else if ($isElementNode(anchor)) candidate = anchor.getChildAtIndex(selection.anchor.offset + (backward ? -1 : 0));
  if (candidate instanceof ComposerOfficeInstructionNode) candidate = backward ? candidate.getLastChild() : candidate.getFirstChild();
  return candidate instanceof ComposerOfficeSelectionTagNode ? candidate : null;
}

/** 仅拦截紧邻标签的删除和左右移动，普通文字、范围删除及输入法交给 Lexical 原生处理。 */
export function registerOfficeSelectionEditing(editor: LexicalEditor) {
  const unregister = [
    ...([KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND] as const).map((command, index) => editor.registerCommand(command, (event) => {
      const selection = $getSelection();
      const selectedTags = $isRangeSelection(selection) && !selection.isCollapsed()
        ? selection.getNodes().filter((node): node is ComposerOfficeSelectionTagNode => node instanceof ComposerOfficeSelectionTagNode) : [];
      const onlyTags = selectedTags.length > 0 && $isRangeSelection(selection) && selection.getTextContent() === selectedTags.map((tag) => tag.getTextContent()).join("");
      const tag = onlyTags ? null : $adjacentOfficeTag(index === 0);
      if (!onlyTags && !tag) return false;
      if (event?.isComposing || event?.keyCode === 229 || editor.isComposing()) return true;
      event?.preventDefault();
      if (onlyTags) [...selectedTags].reverse().forEach($removeOfficeSelectionTag);
      else if (tag) $removeOfficeSelectionTag(tag);
      return true;
    }, COMMAND_PRIORITY_HIGH)),
    ...([KEY_ARROW_LEFT_COMMAND, KEY_ARROW_RIGHT_COMMAND] as const).map((command, index) => editor.registerCommand(command, (event) => {
      if (event?.shiftKey || event?.metaKey || event?.ctrlKey || event?.altKey || event?.isComposing || editor.isComposing()) return false;
      const tag = $adjacentOfficeTag(index === 0); if (!tag) return false;
      const parent = tag.getParent()!; const offset = tag.getIndexWithinParent() + (index === 0 ? 0 : 1);
      event?.preventDefault(); parent.select(offset, offset); return true;
    }, COMMAND_PRIORITY_HIGH)),
  ];
  return () => unregister.forEach((stop) => stop());
}
