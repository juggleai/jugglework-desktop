import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2/client";

import type { ComposerAttachment } from "../../../../app/types";
import { joinWorkspaceRelativePath, toFileUrl } from "./prompt-file-parts";
import {
  attachmentModelMime,
  DOCX_MIME,
  extensionFromFilename,
  isOfficeMime,
  normalizedMime,
  PPTX_MIME,
  resolveAttachmentMime,
  resolveAttachmentMimeFromFilename,
  XLSX_MIME,
} from "./attachment-mime";

type AttachmentKind = "image" | "file";

type AttachmentFile = Pick<File, "arrayBuffer" | "name" | "type">;

type AttachmentFileMetadata = {
  filename: string;
  mime: string;
  kind: AttachmentKind;
  readable: boolean;
};

type InboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

type ChatAttachmentUploadClient = {
  uploadInbox: (workspaceId: string, file: File, options?: { path?: string }) => Promise<InboxUploadResult>;
};

export type ChatAttachmentWorkspaceEndpoint = {
  client: ChatAttachmentUploadClient;
  workspaceId: string;
};

type UploadedChatAttachment = {
  filename: string;
  mime: string;
  bytes: number;
  workspacePath: string;
  url: string;
  file: AttachmentFile;
};

const WORKSPACE_INBOX_ROOT = ".opencode/jugglework/inbox";

const MIME_FILENAME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  [DOCX_MIME]: "docx",
  [PPTX_MIME]: "pptx",
  [XLSX_MIME]: "xlsx",
  "application/json": "json",
  "application/javascript": "js",
  "application/xml": "xml",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/css": "css",
  "text/html": "html",
  "text/yaml": "yaml",
  "text/plain": "txt",
};

export { resolveAttachmentMime } from "./attachment-mime";

export function isResolvedAttachmentMimeReadable(mimeType: string) {
  const mime = normalizedMime(mimeType);
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (isOfficeMime(mime)) return true;
  if (mime === "application/pdf" || mime === "application/json") return true;
  return mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || mime === "application/javascript";
}

function normalizeFilenameExtension(filename: string, mime: string) {
  const original = filename.trim() || "attachment";
  const preferredExtension = MIME_FILENAME_EXTENSIONS[mime];
  if (!preferredExtension) return original;

  const extension = extensionFromFilename(original);
  const extensionMime = extension ? resolveAttachmentMimeFromFilename(original) : undefined;
  if (extensionMime === mime) return original;

  const strictMime = mime.startsWith("image/") || mime === "application/pdf" || mime === "application/json" || isOfficeMime(mime);
  if (!strictMime && extensionMime === undefined) return original;

  const stem = extension ? original.slice(0, -(extension.length + 1)) : original;
  return `${stem.trim() || "attachment"}.${preferredExtension}`;
}

export function safeAttachmentFilename(filename: string) {
  const normalized = filename.replace(/\\/g, "/");
  const basename = normalized.split("/").filter(Boolean).pop()?.trim() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "attachment";
}

function safePathSegment(value: string, fallback: string) {
  const safe = safeAttachmentFilename(value).replace(/\.+/g, ".");
  return safe && safe !== "." ? safe : fallback;
}

export function resolveAttachmentFileMetadata(file: Pick<File, "name" | "type">): AttachmentFileMetadata {
  const mime = resolveAttachmentMime(file);
  return {
    filename: safeAttachmentFilename(normalizeFilenameExtension(file.name, mime)),
    mime,
    kind: mime.startsWith("image/") ? "image" : "file",
    readable: isResolvedAttachmentMimeReadable(mime),
  };
}

export function isAttachmentFileReadable(file: Pick<File, "name" | "type">) {
  return resolveAttachmentFileMetadata(file).readable;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fileToDataUrl(file: AttachmentFile, mime: string) {
  return `data:${mime};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
}

function randomAttachmentId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  cryptoApi?.getRandomValues(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function buildChatAttachmentInboxPath(input: { sessionId: string; filename: string; id: string }) {
  const session = safePathSegment(input.sessionId, "session");
  const id = safePathSegment(input.id, "attachment");
  const filename = safeAttachmentFilename(input.filename);
  return `chat-attachments/${session}/${id}-${filename}`;
}

export function workspaceInboxPath(inboxRelativePath: string) {
  return joinWorkspaceRelativePath(WORKSPACE_INBOX_ROOT, inboxRelativePath);
}

function uploadErrorMessage(filename: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || "Unknown upload error");
  return `Failed to copy attachment "${filename}" into this worker workspace: ${detail}`;
}

function attachmentPathNotePart(uploaded: UploadedChatAttachment[]): TextPartInput {
  // Synthetic: model/tools still see workspace paths, but the chat UI renders
  // file parts as compact badges instead of this wall of path text.
  return {
    type: "text",
    synthetic: true,
    text: [
      "Attached files were copied into this worker workspace for tool access:",
      ...uploaded.map((item) => `- ${item.filename}: ${item.workspacePath} (${item.url})`),
      "Use these paths with Read/Bash/MCP/Docling when a tool needs the file bytes.",
    ].join("\n"),
  };
}

async function uploadedAttachmentFilePart(item: UploadedChatAttachment): Promise<FilePartInput> {
  // Images need a browser-displayable URL so the transcript can show the same
  // expandable miniature preview as paste/composer attachments. Workspace
  // `file://` paths stay in the synthetic note for tool access.
  if (item.mime.startsWith("image/")) {
    return {
      type: "file",
      url: await fileToDataUrl(item.file, item.mime),
      filename: item.filename,
      mime: item.mime,
    };
  }

  return {
    type: "file",
    url: item.url,
    filename: item.filename,
    mime: attachmentModelMime(item.mime),
  };
}

/**
 * 为预览或发送创建一次工作区附件副本，后续发送保留在文件视图中的编辑结果。
 * @param input 附件、所属工作区和会话
 */
export async function materializeComposerAttachment(input: {
  attachment: ComposerAttachment;
  endpoint: ChatAttachmentWorkspaceEndpoint;
  sessionId: string;
  createId?: () => string;
}): Promise<string> {
  const workspaceId = input.endpoint.workspaceId.trim();
  if (!workspaceId) throw new Error("Workspace endpoint is unavailable.");
  if (input.attachment.workspaceCopy?.workspaceId === workspaceId)
    return input.attachment.workspaceCopy.path;
  const metadata = resolveAttachmentFileMetadata(input.attachment.file);
  const path = buildChatAttachmentInboxPath({ sessionId: input.sessionId, filename: metadata.filename, id: input.createId ? input.createId() : randomAttachmentId() });
  let result: InboxUploadResult;
  try {
    result = await input.endpoint.client.uploadInbox(workspaceId, input.attachment.file, { path });
    if (!result.ok) throw new Error("upload was rejected");
    if (!result.path.trim()) throw new Error("upload did not return a path");
    if (result.bytes !== input.attachment.file.size)
      throw new Error(`expected ${input.attachment.file.size} bytes, wrote ${result.bytes}`);
  } catch (error) { throw new Error(uploadErrorMessage(metadata.filename, error)); }
  const workspacePath = workspaceInboxPath(result.path);
  input.attachment.workspaceCopy = { workspaceId, path: workspacePath };
  return workspacePath;
}

export async function composerAttachmentsToWorkspaceFileParts(input: {
  attachments: ComposerAttachment[];
  endpoint: ChatAttachmentWorkspaceEndpoint;
  sessionId: string;
  workspaceRoot: string;
  createId?: () => string;
}): Promise<Array<TextPartInput | FilePartInput>> {
  if (input.attachments.length === 0) return [];

  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new Error("Workspace path is unavailable; attachments could not be copied for tool access.");
  }

  const workspaceId = input.endpoint.workspaceId.trim();
  if (!workspaceId) {
    throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
  }

  const uploaded: UploadedChatAttachment[] = [];
  for (const attachment of input.attachments) {
    const metadata = resolveAttachmentFileMetadata(attachment.file);
    const workspacePath = await materializeComposerAttachment({ ...input, attachment });
    const absolutePath = joinWorkspaceRelativePath(workspaceRoot, workspacePath);
    uploaded.push({
      filename: metadata.filename,
      mime: metadata.mime,
      bytes: attachment.file.size,
      workspacePath,
      url: toFileUrl(absolutePath),
      file: attachment.file,
    });
  }

  return [
    attachmentPathNotePart(uploaded),
    ...(await Promise.all(uploaded.map(uploadedAttachmentFilePart))),
  ];
}

export async function materializeGenerationSourceImage(input: {
  attachment: ComposerAttachment;
  endpoint: ChatAttachmentWorkspaceEndpoint;
  sessionId: string;
  workspaceRoot: string;
  createId?: () => string;
}): Promise<{ workspacePath: string; mimeType: string; bytes: number; filename: string }> {
  const metadata = resolveAttachmentFileMetadata(input.attachment.file);
  if (!metadata.mime.startsWith("image/")) throw new Error("Video generation reference must be an image.");
  const id = input.createId ? input.createId() : randomAttachmentId();
  const inboxPath = buildChatAttachmentInboxPath({ sessionId: input.sessionId, filename: metadata.filename, id });
  const result = await input.endpoint.client.uploadInbox(input.endpoint.workspaceId.trim(), input.attachment.file, { path: inboxPath });
  if (!result.ok || !result.path.trim() || result.bytes !== input.attachment.file.size) throw new Error(uploadErrorMessage(metadata.filename, "upload was rejected"));
  return { workspacePath: workspaceInboxPath(result.path), mimeType: metadata.mime, bytes: result.bytes, filename: metadata.filename };
}

export async function composerAttachmentToFilePart(attachment: ComposerAttachment): Promise<FilePartInput> {
  const metadata = resolveAttachmentFileMetadata(attachment.file);
  const mime = attachmentModelMime(metadata.mime);
  return {
    type: "file",
    url: await fileToDataUrl(attachment.file, mime),
    filename: metadata.filename,
    mime,
  };
}
