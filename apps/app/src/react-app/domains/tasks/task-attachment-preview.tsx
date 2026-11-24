import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { AttachmentRef } from "./task-description-markdown";
import { loadAttachmentPreview } from "./task-attachment-preview-resource";

type Props = { file: AttachmentRef; onClose: () => void; onDownload: () => void };
type PreviewState =
  | { kind: "loading" | "failed" | "unsupported" | "too-large" }
  | { kind: "text"; text: string }
  | { kind: "image" | "audio" | "video"; src: string };

function PreviewBody({ name, url, size }: AttachmentRef) {
  const [state, setState] = React.useState<PreviewState>({ kind: "loading" });
  React.useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    loadAttachmentPreview({ name, url, size }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if ("blob" in result) {
        objectUrl = URL.createObjectURL(result.blob);
        setState({ kind: result.kind, src: objectUrl });
      } else setState(result);
    }).catch(() => { if (!controller.signal.aborted) setState({ kind: "failed" }); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [name, url, size]);

  const failed = () => setState({ kind: "failed" });
  switch (state.kind) {
    case "image": return <img src={state.src} alt={name} onError={failed} className="max-h-full max-w-full object-contain" />;
    case "video": return <video src={state.src} aria-label={name} controls playsInline preload="metadata" onError={failed} className="max-h-full max-w-full" />;
    case "audio": return <audio src={state.src} aria-label={name} controls preload="metadata" onError={failed} className="w-full max-w-lg" />;
    case "text": return <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-3 text-sm">{state.text}</pre>;
    case "loading": return <p role="status">{t("common.loading")}</p>;
    case "unsupported": return <p role="status">{t("tasks.attachment_preview_unsupported")}</p>;
    case "too-large": return <p role="status">{t("tasks.attachment_preview_too_large")}</p>;
    case "failed": return <p role="alert">{t("tasks.attachment_preview_failed")}</p>;
  }
}

export function TaskAttachmentPreview({ file, onClose, onDownload }: Props) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
      <DialogHeader className="min-w-0 pe-8">
        <DialogTitle>{t("tasks.attachment_preview")}</DialogTitle>
        <DialogDescription className="truncate" title={file.name}>{file.name}</DialogDescription>
      </DialogHeader>
      <div className="flex h-[55vh] min-h-0 items-center justify-center overflow-hidden rounded-lg bg-dls-subtle text-sm">
        <PreviewBody key={JSON.stringify([file.url, file.name, file.size])} {...file} />
      </div>
      <DialogFooter><Button type="button" variant="outline" onClick={onDownload}><Download />{t("tasks.download_file")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
