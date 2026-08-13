import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function signatureMatches(mime, bytes) {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/** Main-process validation for Codex local image inputs. */
export async function validateCodexImageInputs(parts, workspaceRoot) {
  const attachments = (Array.isArray(parts) ? parts : []).filter((part) => part?.type === "attachment");
  if (attachments.length > MAX_IMAGES) throw new Error("Codex accepts at most 20 images per message.");
  if (attachments.length === 0) return new Map();
  const root = await realpath(path.resolve(workspaceRoot));
  const inbox = path.join(root, ".opencode", "jugglework", "inbox");
  const validated = new Map();
  for (const part of attachments) {
    const attachment = part.attachment;
    if (attachment?.kind !== "image" || !SUPPORTED_MIME.has(attachment?.mimeType)) {
      throw new Error("Codex supports PNG, JPEG, GIF, and WebP image attachments only.");
    }
    const requested = path.resolve(String(attachment.objectRef ?? ""));
    const resolved = await realpath(requested).catch(() => { throw new Error("Codex image is unavailable."); });
    if (!inside(inbox, resolved)) throw new Error("Codex image must be inside the workspace attachment inbox.");
    const info = await stat(resolved);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES || info.size !== attachment.sizeBytes) {
      throw new Error("Codex image size is invalid.");
    }
    const handle = await open(resolved, "r");
    try {
      const header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      if (!signatureMatches(attachment.mimeType, header)) throw new Error("Codex image content does not match its MIME type.");
    } finally {
      await handle.close();
    }
    validated.set(attachment.attachmentId, resolved);
  }
  return validated;
}

export const CODEX_IMAGE_LIMITS = Object.freeze({ maxImages: MAX_IMAGES, maxBytes: MAX_IMAGE_BYTES });
