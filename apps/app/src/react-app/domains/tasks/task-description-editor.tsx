import * as React from "react";
import { $createTaskImage, $readDescription, $writeDescription, composerRichTheme, descriptionAddress, descriptionNodes, descriptionTransformers, registerMarkdownShortcuts, renderDescription, TaskImageNode } from "./task-description-markdown";
import { $createLinkNode, $toggleLink } from "@lexical/link";
import { $insertList, $isListNode, $removeList } from "@lexical/list";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin.js";
import { LexicalComposer } from "@lexical/react/LexicalComposer.js";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { ContentEditable } from "@lexical/react/LexicalContentEditable.js";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin.js";
import { ListPlugin } from "@lexical/react/LexicalListPlugin.js";
import { $createQuoteNode, $isQuoteNode, registerRichText } from "@lexical/rich-text";
import { $addUpdateTag, $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, $nodesOfType, $setSelection, CLEAR_HISTORY_COMMAND, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_NORMAL, HISTORY_PUSH_TAG, KEY_ENTER_COMMAND, PASTE_COMMAND, SKIP_DOM_SELECTION_TAG, type RangeSelection } from "lexical";
import { ArrowUp, AtSign, Bold, Check, ImageIcon, Italic, Link, List, ListOrdered, Paperclip, Quote, Smile, Strikethrough, Underline, X } from "lucide-react";
import { t } from "@/i18n";
import { TaskEmojiPicker } from "./task-emoji-picker";
import { TaskDescriptionMentions } from "./task-description-mentions";
import type { DenOrganizationMember } from "@/app/lib/den";

type Props = { value: string; onChange: (value: string) => void; onBlur?: () => void; readOnly?: boolean; testId?: string; compact?: boolean; members?: readonly DenOrganizationMember[] };
type CommentProps = Required<Pick<Props, "value" | "onChange" | "members">> & { onSend: () => void; pending: boolean };
type CommentControls = { expanded: boolean; toggle: () => void; canSend: boolean; send: () => void; frame: React.RefObject<HTMLFormElement | null> };
const tools = { bold: Bold, strike: Strikethrough, italic: Italic, underline: Underline, ordered: ListOrdered, bullet: List, quote: Quote, link: Link, emoji: Smile, mention: AtSign, image: ImageIcon };
type Tool = keyof typeof tools;
const toggleTools = ["bold", "strike", "italic", "underline", "ordered", "bullet", "quote"] as const;
type ToggleTool = typeof toggleTools[number];

function selectedTools(selection: RangeSelection): ToggleTool[] {
  const block = selection.anchor.getNode().getTopLevelElement();
  return toggleTools.filter(tool => {
    if (tool === "quote") return $isQuoteNode(block);
    if (tool === "ordered" || tool === "bullet") return $isListNode(block) && block.getListType() === (tool === "ordered" ? "number" : "bullet");
    return selection.hasFormat(tool === "strike" ? "strikethrough" : tool);
  });
}
const theme = {
  ...composerRichTheme, link: "text-blue-10 underline", quote: "border-l-2 border-dls-border pl-3 text-dls-secondary",
  text: { ...composerRichTheme.text, underline: "underline", strikethrough: "line-through", underlineStrikethrough: "[text-decoration-line:underline_line-through]" },
};
const external = "task-description-external";
const toolClass = "flex size-8 shrink-0 items-center justify-center rounded-md text-dls-secondary hover:bg-dls-hover hover:text-dls-text disabled:opacity-45";

const tooltipClass = "pointer-events-none invisible absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background group-hover/tool:visible group-focus-visible/tool:visible";
const toggleClass = "aria-pressed:bg-blue-3 aria-pressed:text-blue-10 aria-pressed:hover:bg-blue-4 aria-pressed:hover:text-blue-10";

function Toolbar({ comment }: { comment?: CommentControls }) {
  const [editor] = useLexicalComposerContext();
  const saved = React.useRef<RangeSelection | null>(null);
  const resourceRange = React.useRef<RangeSelection | null>(null);
  const [resource, setResource] = React.useState<"link" | "image" | "emoji" | null>(null);
  const toolbar = React.useRef<HTMLDivElement>(null);
  const [address, setAddress] = React.useState("");
  const [linkText, setLinkText] = React.useState("");
  const [active, setActive] = React.useState<readonly Tool[]>([]);
  const url = resource && descriptionAddress(address, resource === "image");
  const canConfirm = Boolean(url && (resource !== "link" || linkText.trim()));

  React.useLayoutEffect(() => {
    function sync(reset: boolean) {
      const selection = $getSelection();
      if (reset) { saved.current = null; resourceRange.current = null; }
      else if ($isRangeSelection(selection)) saved.current = selection.clone();
      const next = $isRangeSelection(selection) ? selectedTools(selection) : [];
      setActive(prev => prev.length === next.length && next.every((tool, i) => prev[i] === tool) ? prev : next);
    }
    editor.getEditorState().read(() => sync(false));
    return editor.registerUpdateListener(({ editorState, tags }) => editorState.read(() => sync(tags.has(external))));
  }, [editor]);

  function apply(action: (selection: RangeSelection) => void, snapshot = saved.current) {
    editor.getRootElement()?.focus({ preventScroll: true });
    editor.update(() => {
      if (!editor.isEditable()) return;
      const selection = snapshot && $getNodeByKey(snapshot.anchor.key) && $getNodeByKey(snapshot.focus.key)
        ? snapshot.clone() : $getSelection();
      const range = $isRangeSelection(selection) ? selection : $getRoot().selectEnd();
      $setSelection(range);
      $addUpdateTag(HISTORY_PUSH_TAG);
      action(range);
    }, { discrete: true });
  }

  function run(tool: Tool) {
    if (tool === "emoji") {
      if (resource === "emoji") { setResource(null); editor.focus(); return; }
      resourceRange.current = saved.current;
      setResource("emoji"); return;
    }
    setResource(null);
    if (tool === "image" || tool === "link") {
      // Keep focus inside the frame when keyboard activation replaces this button.
      resourceRange.current = saved.current;
      if (tool === "link") setLinkText(editor.getEditorState().read(() => resourceRange.current?.getTextContent() ?? ""));
      editor.getRootElement()?.focus({ preventScroll: true });
      setAddress(""); setResource(tool); return;
    }
    apply(range => {
      switch (tool) {
        case "bold": case "italic": case "underline": case "strike": range.formatText(tool === "strike" ? "strikethrough" : tool); break;
        case "ordered": case "bullet": {
          const type = tool === "ordered" ? "number" : "bullet";
          const block = range.anchor.getNode().getTopLevelElement();
          if ($isListNode(block) && block.getListType() === type) $removeList();
          else $insertList(type);
          break;
        }
        case "quote": {
          if (range.getNodes().some(n => $isListNode(n.getTopLevelElement()))) $removeList();
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) break;
          const blocks = new Set(selection.getNodes().map(n => n.getTopLevelElement()));
          const unquote = [...blocks].every($isQuoteNode);
          for (const block of blocks) if (block) block.replace(unquote ? $createParagraphNode() : $createQuoteNode(), true);
          break;
        }
        case "mention": {
          const start = range.isBackward() ? range.focus : range.anchor;
          const before = start.type === "text" ? start.getNode().getTextContent().slice(0, start.offset) : "";
          range.insertText(/[A-Za-z0-9._%+@-]$/.test(before) ? " @" : "@"); break;
        }
      }
    });
  }

  function finish(confirm: boolean) {
    if (confirm && !canConfirm) return;
    apply(range => {
      if (!confirm || !url) return;
      if (resource === "image") range.insertNodes([$createTaskImage(range.getTextContent() || t("tasks.rich_text_image"), url)]);
      else if (!range.isCollapsed() && range.getTextContent() === linkText) $toggleLink(url);
      else range.insertNodes([$createLinkNode(url).append($createTextNode(linkText).setFormat(range.format))]);
    }, resourceRange.current);
    setResource(null);
  }

  function imageFields() {
    return <>
      <input autoFocus type="url" aria-label={t("tasks.rich_text_image")} placeholder="https://" value={address} onChange={event => setAddress(event.target.value)}
        className="min-w-0 flex-1 px-2 text-sm outline-none" onKeyDown={event => {
          if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && (event.key === "Enter" || event.key === "Escape")) {
            event.preventDefault(); event.stopPropagation(); finish(event.key === "Enter");
          }
        }} />
      <button type="button" className={toolClass} title={t("common.confirm")} aria-label={t("common.confirm")} disabled={!url} onClick={() => finish(true)}><Check size={18} /></button>
      <button type="button" className={toolClass} title={t("common.cancel")} aria-label={t("common.cancel")} onClick={() => finish(false)}><X size={18} /></button>
    </>;
  }

  function toolButton(tool: Tool) {
      const Icon = tools[tool]; const label = t(`tasks.rich_text_${tool}`);
      return <button key={tool} type="button" data-testid={`task-${comment ? "comment" : "description"}-format-${tool}`} aria-label={label}
        aria-haspopup={tool === "emoji" ? "dialog" : undefined} aria-expanded={tool === "emoji" ? resource === "emoji" : undefined}
        aria-pressed={toggleTools.some(toggle => toggle === tool) ? active.includes(tool) : undefined}
        onClick={() => run(tool)} className={`${toolClass} group/tool relative ${toggleClass}${!comment && tool === "emoji" ? " ml-auto" : ""}`}><Icon size={18} /><span role="tooltip" className={tooltipClass}>{label}</span></button>;
  }

  const aaLabel = t(comment?.expanded ? "tasks.hide_comment_formatting" : "tasks.show_comment_formatting");
  return <div ref={toolbar} className={comment ? "min-w-0 max-w-full" : "relative"} onBlur={event => { if (resource === "emoji" && !event.currentTarget.contains(event.relatedTarget)) setResource(null); }}><div role="toolbar" aria-label={t("composer.format_toolbar")} data-testid={comment ? "task-comment-toolbar" : "task-create-description-toolbar"}
    className={comment ? "flex flex-wrap items-center justify-end gap-0.5 p-1" : "flex min-h-12 flex-wrap items-center gap-0.5 border-t border-dls-border px-2"}
    onMouseDown={event => { if (!(event.target as Element).closest("input")) event.preventDefault(); }}>
    {comment ? <>
      {comment.expanded && <div className="mr-auto flex flex-wrap gap-0.5">{toggleTools.map(toolButton)}{toolButton("link")}</div>}
      <div className="ml-auto flex max-w-full flex-wrap justify-end gap-0.5">
        <button type="button" data-testid="task-comment-format-toggle" aria-label={aaLabel} aria-pressed={comment.expanded} aria-expanded={comment.expanded} onClick={() => { setResource(null); comment.toggle(); }} className={`${toolClass} group/tool relative ${toggleClass}`}>Aa<span className={tooltipClass} role="tooltip">{aaLabel}</span></button>
        {toolButton("emoji")}{toolButton("mention")}{toolButton("image")}
        <button type="button" aria-disabled="true" aria-label={t("tasks.comment_attachment_unavailable")} className={`${toolClass} group/tool relative cursor-not-allowed`}><Paperclip size={18} /><span role="tooltip" className={`${tooltipClass} right-0`}>{t("tasks.comment_attachment_unavailable")}</span></button>
        <button type="submit" disabled={!comment.canSend || resource !== null} aria-label={t("tasks.send_comment")} title={t("tasks.send_comment")} className={toolClass}><ArrowUp size={18} /></button>
      </div>
    </> : resource === "image" ? imageFields() : (Object.keys(tools) as Tool[]).map(toolButton)}
    {comment && resource === "image" && <div role="dialog" aria-label={t("tasks.rich_text_image")} className="absolute bottom-full right-0 z-20 mb-1 flex w-full max-w-[420px] items-center rounded-xl border border-dls-border bg-dls-surface p-2 shadow-xl" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setResource(null); }}>{imageFields()}</div>}
  </div>{resource === "emoji" && <TaskEmojiPicker anchor={comment?.frame ?? toolbar} onPick={value => { apply(range => range.insertText(value), resourceRange.current); setResource(null); }} onCancel={() => { apply(() => {}, resourceRange.current); setResource(null); }} />}{resource === "link" && <div role="dialog" aria-label={t("tasks.rich_text_link")} className="absolute bottom-full left-0 z-20 mb-1 grid w-full max-w-[420px] gap-3 rounded-xl border border-dls-border bg-dls-surface p-4 text-sm shadow-xl"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setResource(null); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape" || (event.key === "Enter" && event.target instanceof HTMLInputElement)) {
        event.preventDefault(); event.stopPropagation(); finish(event.key === "Enter");
      }
    }}>
    <label className="flex items-center gap-2 text-dls-secondary">{t("tasks.rich_text_text")}<input autoFocus value={linkText} placeholder={t("tasks.link_text_placeholder")} onChange={e => setLinkText(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-dls-border bg-transparent px-2 focus:border-blue-8 focus:outline-none" /></label>
    <label className="flex items-center gap-2 text-dls-secondary">{t("tasks.rich_text_link")}<input type="url" value={address} placeholder={t("tasks.link_url_placeholder")} onChange={e => setAddress(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-dls-border bg-transparent px-2 focus:border-blue-8 focus:outline-none" /></label>
    <div className="flex justify-end gap-2"><button type="button" onClick={() => finish(false)} className="rounded-md border border-dls-border px-3 py-1">{t("common.cancel")}</button><button type="button" disabled={!canConfirm} onClick={() => finish(true)} className="rounded-md bg-blue-9 px-3 py-1 text-white disabled:bg-dls-secondary disabled:opacity-50">{t("common.confirm")}</button></div>
  </div>}</div>;
}

function DocumentBody({ value, onChange, autoFocus, members, comment }: Pick<Props, "value" | "onChange" | "members"> & { autoFocus?: boolean; comment?: CommentControls }) {
  const [editor] = useLexicalComposerContext();
  const lastValue = React.useRef(value);
  React.useLayoutEffect(() => registerRichText(editor), [editor]);
  const send = comment?.send;
  React.useLayoutEffect(() => {
    if (!send) return;
    // Mentions handle Enter at HIGH; rich text handles line breaks at EDITOR.
    return editor.registerCommand(KEY_ENTER_COMMAND, event => {
      if (!event) return false;
      if (event.isComposing || event.keyCode === 229 || editor.isComposing()) return true;
      if (event.shiftKey) return false;
      event.preventDefault();
      if (!event.repeat) send();
      return true;
    }, COMMAND_PRIORITY_NORMAL);
  }, [editor, send]);
  React.useEffect(() => registerMarkdownShortcuts(editor, descriptionTransformers), [editor]);
  React.useEffect(() => {
    // Never hand clipboard HTML, embedded resources or foreign editor JSON to
    // the DOM importer. Accept plain text at the current visual selection.
    return editor.registerCommand(PASTE_COMMAND, event => {
      const text = "clipboardData" in event ? event.clipboardData?.getData("text/plain") : null;
      event.preventDefault();
      const selection = $getSelection();
      if (text && $isRangeSelection(selection)) selection.insertRawText(text);
      return true;
    }, COMMAND_PRIORITY_HIGH);
  }, [editor]);
  React.useLayoutEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    editor.update(() => { $addUpdateTag(SKIP_DOM_SELECTION_TAG); $readDescription(value); }, { tag: external, discrete: true });
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, value]);
  React.useLayoutEffect(() => {
    return editor.registerUpdateListener(({ editorState, prevEditorState, tags, dirtyElements, dirtyLeaves }) => {
      if (prevEditorState.isEmpty() || tags.has(external) || (!dirtyElements.size && !dirtyLeaves.size)) return;
      const next = editorState.read($writeDescription);
      if (next === lastValue.current || next === prevEditorState.read($writeDescription)) return;
      lastValue.current = next;
      onChange(next);
    });
  }, [editor, onChange]);
  const placeholder = t(comment ? "tasks.add_comment" : "tasks.add_description");
  return <>
    <div className={`relative min-h-0 min-w-0 overflow-y-auto ${comment ? (comment.expanded ? "max-h-40" : "max-h-40 flex-[1_1_6rem]") : "flex-1"}`}>
      <ContentEditable data-testid={comment ? "task-comment-input" : undefined} aria-label={comment ? placeholder : t("tasks.description_field")} aria-multiline="true" onDropCapture={event => event.preventDefault()}
        aria-placeholder={placeholder} placeholder={<span className="pointer-events-none absolute left-4 top-3 text-sm text-dls-secondary">{placeholder}</span>}
        className="min-h-full whitespace-pre-wrap break-words px-4 py-3 text-sm outline-none" />
    </div>
    <HistoryPlugin /><ListPlugin /><Toolbar comment={comment} />{members && <TaskDescriptionMentions members={members} />}{autoFocus && <AutoFocusPlugin defaultSelection="rootEnd" />}
  </>;
}

function $hasCommentContent() {
  // Empty lists/quotes can serialize to Markdown markers; images can have empty alt text.
  return Boolean($getRoot().getTextContent().trim()) || $nodesOfType(TaskImageNode).length > 0;
}

function CommentForm({ value, onChange, onSend, pending, members }: CommentProps) {
  const [editor] = useLexicalComposerContext();
  const frame = React.useRef<HTMLFormElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [hasContent, setHasContent] = React.useState(() => editor.getEditorState().read($hasCommentContent));
  React.useLayoutEffect(() => editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
    if (dirtyElements.size || dirtyLeaves.size) setHasContent(editorState.read($hasCommentContent));
  }), [editor]);
  const canSend = !pending && hasContent;
  const send = React.useCallback(() => { if (canSend) onSend(); }, [canSend, onSend]);
  return <form ref={frame} data-testid="task-comment-editor" onSubmit={event => { event.preventDefault(); send(); }}
    className={`relative flex min-w-0 rounded-xl border border-dls-border bg-dls-surface focus-within:border-blue-8 ${expanded ? "flex-col" : "flex-wrap items-center justify-end"}`}>
    <DocumentBody value={value} onChange={onChange} members={members} comment={{ expanded, toggle: () => setExpanded(v => !v), canSend, send, frame }} />
  </form>;
}

export function TaskCommentEditor(props: CommentProps) {
  return <LexicalComposer initialConfig={{ namespace: "TaskComment", theme, nodes: descriptionNodes,
    editorState: () => $readDescription(props.value), onError: error => { throw error; } }}>
    <CommentForm {...props} />
  </LexicalComposer>;
}

export function TaskDescriptionEditor(props: Props) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = !!props.readOnly || (!!props.compact && !expanded);
  const editorId = props.testId ?? (props.compact ? "task-detail-description-editor" : "task-create-description-editor");
  const content = React.useMemo(() => preview && props.value.trim() ? renderDescription(props.value) : null, [preview, props.value]);

  if (preview) {
    const interactive = !props.readOnly;
    return <div data-testid={props.compact ? "task-detail-description-preview" : editorId}
      role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined} aria-expanded={interactive ? false : undefined}
      onClick={interactive ? () => setExpanded(true) : undefined} onKeyDown={interactive ? event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded(true); }
      } : undefined}
      className={`min-w-0 flex-1 overflow-y-auto rounded-xl text-left ${props.compact ? "max-h-[168px]" : "h-[168px]"} ${interactive ? "cursor-text hover:bg-dls-hover focus-visible:outline-ring" : ""}`}>
      <div className="whitespace-pre-wrap break-words px-4 py-2 text-sm">{content ?? <span className="text-dls-secondary">{t("tasks.add_description")}</span>}</div>
    </div>;
  }
  return <div data-testid={editorId} onBlur={event => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    props.onBlur?.();
    if (props.compact) setExpanded(false);
  }} className="relative flex h-[168px] min-w-0 flex-1 flex-col rounded-xl border border-dls-border bg-dls-surface focus-within:border-blue-8 focus-within:ring-2 focus-within:ring-blue-8/15">
    <LexicalComposer initialConfig={{ namespace: "TaskDescription", theme, nodes: descriptionNodes,
      editorState: () => $readDescription(props.value), onError: error => { throw error; } }}>
      <DocumentBody value={props.value} onChange={props.onChange} members={props.members} autoFocus={!!props.compact} />
    </LexicalComposer>
  </div>;
}
