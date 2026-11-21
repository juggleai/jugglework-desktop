import * as React from "react";
import { Download, FileImage, FileText, Paperclip, Plus } from "lucide-react";
import { t } from "@/i18n";
import { descriptionAddress, type AttachmentRef } from "./task-description-markdown";
import type { TaskFileUpload } from "./task-file-picker";

import { downloadAttachment, formatSize } from "./task-attachment-file";

export function TaskAttachmentSection({ files, upload, onAdd }: { files: AttachmentRef[]; upload?: TaskFileUpload; onAdd: (file: AttachmentRef) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const request = React.useRef<AbortController | null>(null);
  const latest = React.useRef(onAdd);
  React.useLayoutEffect(() => { latest.current = onAdd; }, [onAdd]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useLayoutEffect(() => { setBusy(false); return () => { request.current?.abort(); request.current = null; }; }, [upload]);
  async function run(action: (signal: AbortSignal) => Promise<void>, message: string) {
    if (request.current) return;
    const ctl = new AbortController(); request.current = ctl; setBusy(true); setError("");
    try { await action(ctl.signal); } catch { if (!ctl.signal.aborted) setError(message); }
    finally { if (ctl === request.current) { request.current = null; setBusy(false); } }
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
  return <section data-testid="task-detail-attachments" className="flex items-start gap-3 py-1"><Paperclip className="mt-0.5 size-4 shrink-0 text-dls-secondary" /><div className="min-w-0 flex-1 space-y-2">
    {hasFiles && <><div className="flex flex-wrap items-center gap-3 text-xs text-dls-secondary"><span>{t("tasks.attachment_summary", { count: files.length })}{files.every(f => f.size !== null) && ` (${formatSize(files.reduce((n, f) => n + f.size!, 0))})`}</span><button type="button" disabled={busy} onClick={() => saveFiles(files)} className="inline-flex items-center gap-1 text-blue-10"><Download size={14} />{t("tasks.download_all_files")}</button></div>
    {files.map((file, i) => { const Icon = /\.(?:jpg|jpeg|png|webp|gif)$/i.test(file.name) ? FileImage : FileText; return <button type="button" key={`${i}:${file.url}`} disabled={busy} onClick={() => saveFiles([file])} className="flex min-h-14 w-full max-w-72 items-center gap-3 rounded-lg border border-dls-border px-3 py-2 text-left hover:bg-dls-hover"><Icon className="size-7 shrink-0 text-blue-10" /><span className="min-w-0"><span className="block truncate text-sm" title={file.name}>{file.name}</span><span className="text-xs text-dls-secondary">{file.size === null ? t("tasks.attachment_size_unknown") : formatSize(file.size)}</span></span></button>; })}</>}
    {add}{upload && <input ref={input} hidden type="file" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; choose(file); }} />}
    {busy && <span role="status" className="ml-2 text-xs text-dls-secondary">…</span>}{error && <p role="alert" className="text-xs text-red-9">{error}</p>}
  </div></section>;
}
