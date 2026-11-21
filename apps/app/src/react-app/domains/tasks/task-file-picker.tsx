import * as React from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { $addUpdateTag, $getRoot, $getSelection, $setSelection, HISTORY_PUSH_TAG, type RangeSelection } from "lexical";
import { t } from "@/i18n";
import { $createTaskFile, descriptionAddress } from "./task-description-markdown";

export type TaskFilePurpose = "task_image" | "task_attachment";
export type TaskFileUpload = (file: File, purpose: TaskFilePurpose, signal: AbortSignal) => Promise<{ url: string; name: string }>;
const images = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const insertion = "task-file-insertion";

export function TaskFilePicker({ purpose, upload, range, close, onAttachment }: {
  onAttachment?: (file: {name: string; url: string; size: number}) => void;
  purpose: TaskFilePurpose; upload: TaskFileUpload; range: RangeSelection | null; close: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState<File | null>(null);
  const [stale, setStale] = React.useState(false);
  const invalid = React.useRef(false);
  const initialUpload = React.useRef(upload);
  const attempt = React.useRef<AbortController | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const opened = React.useRef(false);
  const image = purpose === "task_image";
  const label = t(image ? "tasks.choose_image" : "tasks.choose_attachment");

  React.useLayoutEffect(() => {
    const element = input.current;
    element?.addEventListener("cancel", close);
    if (element && !opened.current) {
      opened.current = true;
      element.click();
    }
    return () => element?.removeEventListener("cancel", close);
  }, [close]);

  React.useLayoutEffect(() => {
    if (initialUpload.current !== upload) { invalid.current = true; setStale(true); setBusy(false); }
    // A native chooser can clear Lexical's selection. Only null is benign;
    // an edit, external reset, or a different caret invalidates this insertion.
    const unregister = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
      if (prevEditorState.isEmpty() || tags.has(insertion)) return;
      const selection = editorState.read($getSelection);
      if (dirtyElements.size || dirtyLeaves.size || tags.has("task-description-external") || (selection && !selection.is(range))) {
        invalid.current = true;
        attempt.current?.abort(); attempt.current = null;
        setStale(true); setBusy(false);
      }
    });
    return () => { unregister(); attempt.current?.abort(); attempt.current = null; };
  }, [editor, range, upload]);

  async function pick(file: File) {
    if (attempt.current || invalid.current || !editor.isEditable()) return;
    setError(""); setRetry(null);
    if (!file.size || !file.name.trim() || (image && !images.includes(file.type))) { setError(t(image ? "tasks.invalid_image_file" : "tasks.invalid_attachment_file")); return; }
    if (file.size > (image ? 5 : 20) * 1024 ** 2) { setError(t(image ? "tasks.image_file_too_large" : "tasks.attachment_too_large")); return; }
    const controller = new AbortController();
    attempt.current = controller; setBusy(true);
    try {
      const result = await upload(file, purpose, controller.signal);
      if (controller.signal.aborted || invalid.current || !editor.isEditable()) return;
      const url = descriptionAddress(result.url, true);
      if (!url) throw new Error("Invalid upload URL");
      if (!image && onAttachment) onAttachment({ name: file.name, url, size: file.size });
      else editor.update(() => {
        const target = range?.clone() ?? $getRoot().selectEnd();
        $setSelection(target); $addUpdateTag(HISTORY_PUSH_TAG);
        target.insertNodes([$createTaskFile(file.name || result.name, url, image, image ? null : file.size)]);
      }, { discrete: true, tag: insertion });
      close();
    } catch {
      if (!controller.signal.aborted) { setError(t("tasks.upload_failed")); setRetry(file); }
    } finally {
      if (attempt.current === controller) { attempt.current = null; setBusy(false); }
    }
  }

  return <>
    <input ref={input} hidden aria-label={label} type="file" accept={image ? images.join(",") : undefined} disabled={busy || stale} onChange={e => {
      const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void pick(file);
    }} />
    {(busy || error || stale) && <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2 px-2 text-sm" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
      {busy && <span role="status">{t("tasks.uploading_file")}</span>}
      {(error || stale) && <span role="alert">{stale ? t("tasks.upload_selection_changed") : error}</span>}
      {error && !stale && <button type="button" onClick={() => retry ? void pick(retry) : input.current?.click()}>{t("tasks.retry")}</button>}
      <button type="button" onClick={close}>{t("common.cancel")}</button>
    </div>}
  </>;
}
