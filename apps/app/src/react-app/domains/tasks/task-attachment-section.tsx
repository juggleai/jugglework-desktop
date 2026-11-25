import * as React from "react";
import { Download, Eye, FileImage, FileText, FileVideo, Paperclip, Plus, Trash2 } from "lucide-react";
import { t } from "@/i18n";
import { descriptionAddress, type AttachmentRef } from "./task-description-markdown";
import type { TaskFileUpload } from "./task-file-picker";

import { downloadAttachment, formatSize } from "./task-attachment-file";
import { TaskAttachmentPreview } from "./task-attachment-preview";

const actionClass = "inline-flex size-7 items-center justify-center rounded text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:ring-2 focus-visible:ring-blue-8 disabled:opacity-50";

export function TaskAttachmentSection({ files, upload, onAdd, onRemove, onBusyChange }: { files: AttachmentRef[]; onBusyChange?: (busy: boolean) => void; upload?: TaskFileUpload; onAdd: (file: AttachmentRef) => void; onRemove?: (file: AttachmentRef, index: number) => Promise<boolean> }) {
  const input = React.useRef<HTMLInputElement>(null);
  const request = React.useRef<AbortController | null>(null);
  const latest = React.useRef(onAdd);
  React.useLayoutEffect(() => { latest.current = onAdd; }, [onAdd]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [preview, setPreview] = React.useState<AttachmentRef | null>(null);
  React.useLayoutEffect(() => { setBusy(false); return () => { request.current?.abort(); request.current = null; onBusyChange?.(false); }; }, [upload, onBusyChange]);
  async function run(action: (signal: AbortSignal) => Promise<void>, message: string) {
    if (request.current) return;
    const ctl = new AbortController(); request.current = ctl; setBusy(true); onBusyChange?.(true); setError("");
    try { await action(ctl.signal); } catch { if (!ctl.signal.aborted) setError(message); }
    finally { if (ctl === request.current) { request.current = null; setBusy(false); onBusyChange?.(false); } }
  }
  function choose(file?: File) {
    if (!file || !upload) return;
    void run(async signal => {
      const result = await upload(file, "task_attachment", signal); signal.throwIfAborted();
      const url = descriptionAddress(result.url, true); if (!url) throw new Error("invalid URL");
      latest.current({ name: file.name, size: file.size, url });
    }, t("tasks.upload_failed"));
  }
  const hasFiles = files.length > 0;
  if (!hasFiles && !upload) return null;
  const add = upload && <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-1 rounded text-sm text-dls-secondary hover:text-blue-10 disabled:opacity-50">{hasFiles && <Plus size={14} />}{t("tasks.add_attachment")}</button>;
  const saveFiles = (items: AttachmentRef[]) => void run(async signal => { for (const item of items) await downloadAttachment(item, signal); }, t("tasks.attachment_download_failed"));
  const remove = (file: AttachmentRef, index: number) => {
    if (!onRemove || request.current || !globalThis.confirm(t("tasks.attachment_remove_confirm", { name: file.name }))) return;
    void run(async () => { if (!await onRemove(file, index)) throw new Error("remove failed"); }, t("tasks.attachment_remove_failed"));
  };
  return <section data-testid="task-detail-attachments" className="flex items-start gap-3 py-1"><Paperclip className="mt-0.5 size-4 shrink-0 text-dls-secondary" /><div className="min-w-0 flex-1 space-y-2">
    {hasFiles && <><div className="flex flex-wrap items-center gap-3 text-xs text-dls-secondary"><span>{t("tasks.attachment_summary", { count: files.length })}{files.every(f => f.size !== null) && ` (${formatSize(files.reduce((n, f) => n + f.size!, 0))})`}</span><button type="button" disabled={busy} onClick={() => saveFiles(files)} className="inline-flex items-center gap-1 text-blue-10"><Download size={14} />{t("tasks.download_all_files")}</button></div>
    <div className="flex flex-wrap gap-2">{files.map((file, i) => {
      const Icon = /\.(?:jpg|jpeg|png|webp|gif)$/i.test(file.name) ? FileImage : /\.(?:mp4|mov|webm|mkv)$/i.test(file.name) ? FileVideo : FileText;
      const label = (action: string) => `${action}：${file.name}`;
      return <div role="group" aria-label={file.name} key={`${i}:${file.url}`} className="flex min-h-14 w-full max-w-72 items-center gap-2 rounded-lg border border-dls-border px-3 py-2 hover:border-blue-8 focus-within:border-blue-8">
        <Icon aria-hidden="true" className="size-7 shrink-0 text-blue-10" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={file.name}>{file.name}</span><span className="text-xs text-dls-secondary">{file.size === null ? t("tasks.attachment_size_unknown") : formatSize(file.size)}</span></span>
        <div className="flex shrink-0 items-center">
          <button type="button" className={actionClass} disabled={busy} aria-label={label(t("tasks.attachment_preview"))} title={t("tasks.attachment_preview")} onClick={() => setPreview(file)}><Eye size={16} /></button>
          <button type="button" className={actionClass} disabled={busy} aria-label={label(t("tasks.download_file"))} title={t("tasks.download_file")} onClick={() => saveFiles([file])}><Download size={16} /></button>
          {onRemove && <button type="button" className={`${actionClass} hover:text-red-10`} disabled={busy} aria-label={label(t("tasks.remove_attachment"))} title={t("tasks.remove_attachment")} onClick={() => remove(file, i)}><Trash2 size={16} /></button>}
        </div>
      </div>;
    })}</div></>}
    {add}{upload && <input ref={input} hidden type="file" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; choose(file); }} />}
    {busy && <span role="status" className="ml-2 text-xs text-dls-secondary">…</span>}{error && <p role="alert" className="text-xs text-red-9">{error}</p>}
    {preview && <TaskAttachmentPreview file={preview} onClose={() => setPreview(null)} onDownload={() => { setPreview(null); saveFiles([preview]); }} />}
  </div></section>;
}
