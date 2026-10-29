import type { FilePartInput } from "@opencode-ai/sdk/v2/client";
import type { ComposerPart } from "@/app/types";
import { attachmentModelMime, GENERIC_BINARY_MIME, resolveAttachmentMimeFromFilename } from "./attachment-mime";

function encodeFilePath(path: string) {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

export function toFileUrl(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeFilePath(normalized).replace(/^([A-Za-z])%3A/, "$1:")}`;
  return `file://${encodeFilePath(normalized)}`;
}

export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string) {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !relative) return "";
  return `${root}/${relative}`;
}

export function composerFilePartToPromptPart(
  part: Extract<ComposerPart, { type: "file" }>,
  workspaceRoot: string,
): FilePartInput | null {
  const path = part.path.trim();
  if (!path) return null;
  const absolute = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
    ? path
    : joinWorkspaceRelativePath(workspaceRoot, path);
  if (!absolute) return null;
  const filename = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "file";
  return {
    type: "file",
    mime: attachmentModelMime(resolveAttachmentMimeFromFilename(filename) ?? GENERIC_BINARY_MIME),
    url: toFileUrl(absolute),
    filename,
  };
}
