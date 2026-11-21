import type { AttachmentRef } from "./task-description-markdown";

export function formatSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  return bytes < 1000000 ? `${+(bytes / 1000).toFixed(2)} KB` : `${+(bytes / 1000000).toFixed(2)} MB`;
}

export async function downloadAttachment(file: AttachmentRef, signal: AbortSignal) {
  const response = await fetch(file.url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
  if (!response.ok) throw new Error("download failed");
  const blob = await response.blob();
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
