import type { AttachmentRef } from "./task-description-markdown";

// Only inert renderers are supported. In particular, the workspace PDF embed
// is meant for trusted local files, not remote task attachments.
const formats = new Map<string, string>([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"],
  ["mp4", "video/mp4"], ["webm", "video/webm"],
  ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["ogg", "audio/ogg"], ["wav", "audio/wav"],
  ["txt", "text/plain"], ["log", "text/plain"], ["md", "text/markdown"], ["csv", "text/csv"], ["json", "application/json"],
]);

export type AttachmentPreviewResource =
  | { kind: "unsupported" | "too-large" }
  | { kind: "text"; text: string }
  | { kind: "image" | "video" | "audio"; blob: Blob };

export async function loadAttachmentPreview(file: AttachmentRef, signal: AbortSignal): Promise<AttachmentPreviewResource> {
  const mime = formats.get(/\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase() ?? "");
  if (!mime) return { kind: "unsupported" };

  const address = new URL(file.url);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) throw new Error("Invalid attachment URL");
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "text";
  const limit = (kind === "text" ? 1 : 64) * 1024 * 1024;
  if (file.size !== null && file.size > limit) return { kind: "too-large" };

  const response = await fetch(address.href, { signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  signal.throwIfAborted();
  if (!response.ok || response.redirected || !response.body) throw new Error("Attachment unavailable");
  const declared = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  // Object stores may not know the type. Never forward an arbitrary response
  // type to a blob URL; explicit conflicting types fail closed.
  if (declared && declared !== mime && declared !== "application/octet-stream" && !(kind === "text" && declared === "text/plain")) {
    await response.body.cancel();
    return { kind: "unsupported" };
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    return { kind: "too-large" };
  }

  // Neither metadata nor Content-Length bounds the decoded response body.
  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(parts, { type: mime });
  return kind === "text" ? { kind, text: await blob.text() } : { kind, blob };
}
