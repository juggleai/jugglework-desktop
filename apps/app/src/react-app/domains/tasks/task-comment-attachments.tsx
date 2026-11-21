import * as React from "react";
import { FileImage, FileText, X } from "lucide-react";
import { t } from "@/i18n";
import { downloadAttachment, formatSize } from "./task-attachment-file";
import type { AttachmentRef } from "./task-description-markdown";

const cardClass = "group flex min-h-14 w-full max-w-64 items-center gap-3 rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-left";

function FileLabel({ file }: { file: AttachmentRef }) {
  const Icon = /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? FileImage : FileText;
  return <><span className="flex h-9 w-8 shrink-0 items-center justify-center rounded bg-blue-9 text-white"><Icon size={20} /></span>
    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-dls-text" title={file.name}>{file.name}</span>
      <span className="text-xs text-dls-secondary">{file.size === null ? t("tasks.attachment_size_unknown") : formatSize(file.size)}</span></span></>;
}

function DownloadCard({ file }: { file: AttachmentRef }) {
  const request = React.useRef<AbortController | null>(null);
  const [status, setStatus] = React.useState<"idle" | "busy" | "error">("idle");
  React.useEffect(() => () => request.current?.abort(), []);
  async function download() {
    if (request.current) return;
    const ctl = new AbortController(); request.current = ctl; setStatus("busy");
    try { await downloadAttachment(file, ctl.signal); if (!ctl.signal.aborted) setStatus("idle"); }
    catch { if (!ctl.signal.aborted) setStatus("error"); }
    finally { request.current = null; }
  }
  return <><button type="button" disabled={status === "busy"} onClick={download} aria-label={`${t("tasks.download_file")}: ${file.name}`} className={`${cardClass} hover:bg-dls-hover`}><FileLabel file={file} /></button>
    {status === "error" && <p role="alert" className="text-xs text-red-9">{t("tasks.attachment_download_failed")}</p>}</>;
}

export function CommentAttachments({ files, remove, draft = false }: { files: readonly AttachmentRef[]; remove?: (index: number) => void; draft?: boolean }) {
  if (!files.length) return null;
  return <div data-testid="comment-attachments" className={`space-y-1.5 ${draft ? "mx-3 mb-2 max-h-40 overflow-y-auto" : "mt-1.5"}`}>
    {files.map((file, i) => draft ? <div key={`${i}:${file.url}`} className={cardClass}><FileLabel file={file} />
      {remove && <button type="button" aria-label={`${t("tasks.remove_attachment")}: ${file.name}`} onClick={() => remove(i)} className="rounded p-1 text-dls-secondary hover:bg-dls-hover"><X size={14} /></button>}</div>
      : <DownloadCard key={`${i}:${file.url}`} file={file} />)}
  </div>;
}
