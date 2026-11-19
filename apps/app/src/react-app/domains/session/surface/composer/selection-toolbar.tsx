import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bold, Check, ChevronDown, Italic, Link as LinkIcon, X } from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { $addUpdateTag, $getNodeByKey, $getSelection, $isRangeSelection, $setSelection, HISTORY_PUSH_TAG, type RangeSelection } from "lexical";
import { t } from "@/i18n";
import { $applyBlockStyle, $applyInlineStyle, $selectionFormatInfo, blockStyles, type BlockStyle } from "./selection-formatting";
import { $toggleLink } from "@lexical/link";
import { linkAddress } from "./markdown-editing";

type ToolbarState = NonNullable<ReturnType<typeof $selectionFormatInfo>> & { x: number; y: number; above: boolean };
const button = "inline-flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-ring disabled:opacity-35 aria-pressed:bg-accent";

function label(style: BlockStyle) {
  if (style === "body") return t("composer.format_body");
  if (style === "ordered") return t("tasks.rich_text_ordered");
  if (style === "bullet") return t("tasks.rich_text_bullet");
  return t("composer.format_heading", { level: style.slice(1) });
}

export function ComposerSelectionToolbar() {
  const [editor] = useLexicalComposerContext();
  const [bar, setBar] = useState<ToolbarState | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const saved = useRef<{ range: RangeSelection; text: string } | null>(null);

  function dismiss() {
    saved.current = null;
    setBar(null);
    setAddress(null);
  }

  useEffect(() => {
    let cleanup = () => {};
    const unregister = editor.registerRootListener(root => {
      cleanup();
      if (!root) return;
      const doc = root.ownerDocument;
      const win = doc.defaultView!;
      let frame = 0;
      function refresh() {
        if (toolbar.current?.contains(doc.activeElement)) return;
        const dom = doc.getSelection();
        if (!dom?.rangeCount || dom.isCollapsed || !root!.contains(dom.anchorNode) || !root!.contains(dom.focusNode)) { dismiss(); return; }
        const rect = dom.getRangeAt(0).getBoundingClientRect();
        const bounds = root!.getBoundingClientRect();
        if (rect.bottom < bounds.top || rect.top > bounds.bottom || rect.bottom < 0 || rect.top > win.innerHeight) { dismiss(); return; }
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          const info = $isRangeSelection(selection) && !selection.isCollapsed() && $selectionFormatInfo(selection);
          if (!info || !$isRangeSelection(selection)) { dismiss(); return; }
          saved.current = { range: selection.clone(), text: selection.getTextContent() };
          const above = rect.top >= 54;
          setBar({ ...info, x: (rect.left + rect.right) / 2, above, y: above ? Math.max(rect.top, bounds.top) - 6 : Math.min(rect.bottom, bounds.bottom) + 6 });
        });
      }
      function schedule() {
        win.cancelAnimationFrame(frame);
        frame = win.requestAnimationFrame(refresh);
      }
      function outside(e: Event) {
        const target = e.target as Node;
        if (!toolbar.current?.contains(target) && !root!.contains(target)) dismiss();
      }
      function escape(e: KeyboardEvent) {
        if (e.key === "Escape" && saved.current) {
          e.preventDefault();
          e.stopPropagation();
          if (toolbar.current?.contains(doc.activeElement)) root!.focus();
          dismiss();
        }
      }
      doc.addEventListener("selectionchange", schedule);
      doc.addEventListener("scroll", schedule, true);
      doc.addEventListener("pointerdown", outside, true);
      doc.addEventListener("focusin", outside);
      doc.addEventListener("keydown", escape, true);
      win.addEventListener("resize", schedule);
      const stopUpdates = editor.registerUpdateListener(schedule);
      cleanup = () => {
        stopUpdates();
        win.cancelAnimationFrame(frame);
        doc.removeEventListener("selectionchange", schedule);
        doc.removeEventListener("scroll", schedule, true);
        doc.removeEventListener("pointerdown", outside, true);
        doc.removeEventListener("focusin", outside);
        doc.removeEventListener("keydown", escape, true);
        win.removeEventListener("resize", schedule);
      };
    });
    return () => { unregister(); cleanup(); };
  }, [editor]);

  function apply(action: (selection: RangeSelection) => void) {
    const snapshot = saved.current;
    if (!snapshot) return;
    editor.getRootElement()?.focus({ preventScroll: true });
    editor.update(() => {
      const range = snapshot.range.clone();
      if (!editor.isEditable() || !$getNodeByKey(range.anchor.key) || !$getNodeByKey(range.focus.key) || range.getTextContent() !== snapshot.text) return;
      $setSelection(range);
      action(range);
    });
    dismiss();
  }

  const root = editor.getRootElement();
  if (!bar || !root) return null;
  const width = Math.min(address === null ? 198 : 284, root.ownerDocument.documentElement.clientWidth - 16);
  const link = address === null ? null : linkAddress(address);
  function applyLink() {
    if (link) apply(() => { $addUpdateTag(HISTORY_PUSH_TAG); $toggleLink(link); });
  }
  return createPortal(
    <div ref={toolbar} data-composer-selection-toolbar role="toolbar" aria-label={t("composer.format_toolbar")}
      className="fixed z-[100] flex items-center gap-0.5 rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ width, top: bar.y, left: Math.max(8, Math.min(bar.x - width / 2, root.ownerDocument.documentElement.clientWidth - width - 8)), transform: bar.above ? "translateY(-100%)" : undefined }}
      onKeyDown={e => { e.stopPropagation(); if (address !== null && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); applyLink(); } }}
      onMouseDown={e => { if ((e.target as Element).closest("button")) e.preventDefault(); }}>
      {address !== null ? <>
        <input autoFocus type="url" aria-label={t("tasks.rich_text_link")} placeholder="https://" value={address} onChange={e => setAddress(e.target.value)}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 outline-none" />
        <button type="button" disabled={!link} className={button} aria-label={t("common.confirm")} onClick={applyLink}><Check size={16} /></button>
        <button type="button" className={button} aria-label={t("common.cancel")} onClick={() => apply(() => {})}><X size={16} /></button>
      </> : <>
        <button type="button" className={button} title={t("tasks.rich_text_link")} aria-label={t("tasks.rich_text_link")} disabled={!bar.link} onClick={() => setAddress(bar.url)}><LinkIcon size={16} /></button>
        <button type="button" className={button} title={t("tasks.rich_text_bold")} aria-label={t("tasks.rich_text_bold")} aria-pressed={bar.bold} disabled={!bar.inline} onClick={() => apply(range => $applyInlineStyle(editor, range, "bold"))}><Bold size={16} /></button>
        <button type="button" className={button} title={t("tasks.rich_text_italic")} aria-label={t("tasks.rich_text_italic")} aria-pressed={bar.italic} disabled={!bar.inline} onClick={() => apply(range => $applyInlineStyle(editor, range, "italic"))}><Italic size={16} /></button>
        <div className="relative flex min-w-0 flex-1 items-center">
          <select className="w-full appearance-none truncate rounded-lg bg-popover py-1.5 pl-2 pr-5 hover:bg-accent" aria-label={t("composer.format_toolbar")} value={bar.style}
            onChange={e => { const style = e.target.value as BlockStyle; apply(range => $applyBlockStyle(range, style)); }}>
            {blockStyles.map(style => <option key={style} value={style}>{label(style)}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-1" />
        </div>
      </>}
    </div>, root.ownerDocument.body);
}
