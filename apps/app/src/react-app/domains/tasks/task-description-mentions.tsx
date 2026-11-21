import * as React from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { $createTextNode, $getSelection, $isRangeSelection, $isTextNode, $nodesOfType, COMMAND_PRIORITY_HIGH, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND } from "lexical";
import { $createTaskMention, TaskMentionNode } from "./task-description-markdown";
import type { DenOrganizationMember } from "@/app/lib/den";
import { t } from "@/i18n";

function currentMention() {
  const range = $getSelection();
  if (!$isRangeSelection(range) || !range.isCollapsed() || range.anchor.type !== "text") return null;
  const node = range.anchor.getNode();
  if (!$isTextNode(node) || node.hasFormat("code")) return null;
  const end = range.anchor.offset;
  const prefix = node.getTextContent().slice(0, end);
  // Don't open on the @ inside an email address. Chinese prose needn't have a space before @.
  const match = /(?<![A-Za-z0-9._%+@-])@([^@\s]{0,80})$/u.exec(prefix);
  return match ? { range, key: node.getKey(), start: match.index, end, query: match[1] } : null;
}

const nameOf = (m: DenOrganizationMember) => m.user.name?.trim() || m.user.account || m.user.email || m.id;

export function TaskDescriptionMentions({ members }: { members: readonly DenOrganizationMember[] }) {
  const [editor] = useLexicalComposerContext();
  const host = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const dismissed = React.useRef("");
  const [query, setQuery] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const [used, setUsed] = React.useState<Set<string>>(() => new Set());
  const [pos, setPos] = React.useState({ left: 12, top: 32, above: false, height: 224 });
  const id = React.useId();
  const options = React.useMemo(() => members.filter(m => [nameOf(m), m.user.account, m.user.email].some(v => v?.toLocaleLowerCase().includes((query ?? "").toLocaleLowerCase()))), [query, members]);
  const enabled = React.useMemo(() => options.map((m, i) => used.has(m.id) ? -1 : i).filter(i => i >= 0), [options, used]);
  const active = enabled.includes(index) ? index : enabled[0] ?? -1;

  React.useLayoutEffect(() => editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
    const hit = currentMention();
    if (hit) {
      const ids = $nodesOfType(TaskMentionNode).map(n => n.memberId());
      setUsed(prev => prev.size === ids.length && ids.every(id => prev.has(id)) ? prev : new Set(ids));
    }
    const token = hit ? `${hit.key}:${hit.start}:${hit.query}` : "";
    if (token !== dismissed.current) dismissed.current = "";
    setQuery(hit && !editor.isComposing() && dismissed.current !== token ? hit.query : null);
  })), [editor]);
  React.useLayoutEffect(() => setIndex(0), [query]);
  React.useLayoutEffect(() => {
    if (query === null) return;
    const root = editor.getRootElement();
    if (!root || !host.current) return;
    const measure = () => {
      const selection = root.ownerDocument.getSelection();
      if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return;
      const caret = selection.getRangeAt(0).getBoundingClientRect();
      const frame = host.current!.getBoundingClientRect();
      let top = 0, bottom = window.innerHeight;
      for (let el = host.current!.parentElement; el; el = el.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(el).overflowY)) continue;
        const y = el.getBoundingClientRect().top + el.clientTop;
        top = Math.max(top, y); bottom = Math.min(bottom, y + el.clientHeight);
      }
      const down = bottom - caret.bottom - 4, up = caret.top - top - 4;
      const above = down < Math.min(224, Math.max(options.length, 1) * 44 + 4) && up > down;
      setPos({ left: Math.max(0, Math.min(caret.left - frame.left, frame.width - 240)), top: (above ? caret.top - 4 : caret.bottom + 4) - frame.top, above, height: Math.max(0, Math.min(224, above ? up : down)) });
    };
    measure();
    root.setAttribute("aria-controls", id);
    window.addEventListener("scroll", measure, true); window.addEventListener("resize", measure);
    return () => { root.removeAttribute("aria-controls"); window.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); };
  }, [editor, id, options.length, query]);
  React.useEffect(() => {
    const el = list.current?.children[active];
    if (!el || !list.current) return;
    const box = list.current.getBoundingClientRect(), row = el.getBoundingClientRect();
    if (row.bottom > box.bottom) list.current.scrollTop += row.bottom - box.bottom;
    else if (row.top < box.top) list.current.scrollTop -= box.top - row.top;
  }, [active]);

  const insert = React.useCallback((member: DenOrganizationMember) => {
    const hit = currentMention();
    if (!hit || hit.query !== query || $nodesOfType(TaskMentionNode).some(n => n.memberId() === member.id)) return;
    hit.range.anchor.set(hit.key, hit.start, "text");
    hit.range.insertNodes([$createTaskMention(member.id, nameOf(member)), $createTextNode(" ").setFormat(hit.range.format)]);
    setQuery(null);
  }, [query]);
  React.useLayoutEffect(() => {
    if (query === null) return;
    const arrow = (e: KeyboardEvent, delta: number) => {
      if (e.isComposing || editor.isComposing() || !enabled.length) return false;
      e.preventDefault(); setIndex(enabled[(enabled.indexOf(active) + delta + enabled.length) % enabled.length]); return true;
    };
    const off = [editor.registerCommand(KEY_ARROW_DOWN_COMMAND, e => arrow(e, 1), COMMAND_PRIORITY_HIGH), editor.registerCommand(KEY_ARROW_UP_COMMAND, e => arrow(e, -1), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ENTER_COMMAND, e => {
        if (!e || e.isComposing || e.keyCode === 229 || editor.isComposing() || e.shiftKey) return false;
        // While the list owns Enter, even an empty result must not submit a comment.
        e.preventDefault();
        if (options[active]) insert(options[active]);
        return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, e => { if (e.isComposing) return false; const hit = currentMention(); if (!hit) return false; dismissed.current = `${hit.key}:${hit.start}:${hit.query}`; e.preventDefault(); e.stopPropagation(); setQuery(null); return true; }, COMMAND_PRIORITY_HIGH)];
    return () => off.forEach(f => f());
  }, [active, editor, enabled, insert, options, query]);
  return <div className="pointer-events-none absolute inset-0" ref={host}>{query !== null && <div id={id} ref={list} role="listbox" aria-label={t("tasks.rich_text_mention")} className="pointer-events-auto absolute z-30 w-60 max-w-full overflow-y-auto overscroll-contain rounded-lg border border-dls-border bg-dls-surface py-0.5 shadow-lg" style={{ top: pos.top, left: pos.left, maxHeight: pos.height, transform: pos.above ? "translateY(-100%)" : undefined }} onMouseDown={e => e.preventDefault()}>
    {options.length ? options.map((m, i) => <div key={m.id} role="option" aria-disabled={used.has(m.id)} aria-selected={i === active} className={`flex h-11 items-center gap-3 px-4 text-sm ${used.has(m.id) ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${i === active ? "bg-dls-hover" : ""}`} onMouseEnter={used.has(m.id) ? undefined : () => setIndex(i)} onClick={used.has(m.id) ? undefined : () => editor.update(() => insert(m), { discrete: true })}>
      {m.user.avatar ? <img src={m.user.avatar} alt="" className="size-8 rounded-full object-cover" /> : <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-3 text-blue-10">{nameOf(m).slice(0, 1)}</span>}<span className="truncate">{nameOf(m)}</span>
    </div>) : <p className="px-4 py-2 text-sm text-dls-secondary">{t("tasks.no_matching_members")}</p>}
  </div>}</div>;
}
