/**
 * Keeps inline tool images from dominating model context and session storage.
 *
 * OpenCode stores image results as data URLs. Re-reading the same unchanged
 * image can therefore add several megabytes to both the part and event tables
 * on every attempt, and auto-compaction can accidentally turn that into a
 * read/compact/continue loop. This plugin provides two independent guards:
 *
 * - an unchanged raster image may only be read once per session/process;
 * - model-bound history keeps the newest copy of duplicate inline images and
 *   applies a byte budget to older unique images.
 *
 * The history hook only marks the request projection as compacted. The stored
 * session remains intact for diagnostics; the desktop applies its own bounded
 * projection when it renders historical read results.
 */

import { stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const TARGET_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;
const PRESERVE_RECENT_IMAGE_PARTS = 2;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

type JsonRecord = Record<string, unknown>;

type InlineImage = {
  key: string;
  url: string;
  bytes: number;
};

type InlineImagePart = {
  state: JsonRecord;
  images: InlineImage[];
  inlineBytes: number;
  compacted: boolean;
};

type ToolInput = {
  tool?: unknown;
  sessionID?: unknown;
  args?: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineImage(value: unknown): InlineImage | null {
  if (!isRecord(value)) return null;
  if (typeof value.mime !== "string" || !value.mime.toLowerCase().startsWith("image/")) return null;
  if (typeof value.url !== "string" || !value.url.toLowerCase().startsWith("data:image/")) return null;
  const url = value.url;
  // The sampled key avoids allocating or hashing the whole multi-megabyte data
  // URL. Exact string equality below prevents a sampled-key collision from
  // incorrectly treating different images as duplicates.
  const key = `${value.mime.toLowerCase()}\0${url.length}\0${url.slice(0, 192)}\0${url.slice(-192)}`;
  return { key, url, bytes: url.length };
}

function inlineImagePart(value: unknown): InlineImagePart | null {
  if (!isRecord(value) || value.type !== "tool") return null;
  if (!isRecord(value.state) || value.state.status !== "completed") return null;

  const attachments = Array.isArray(value.state.attachments) ? value.state.attachments : [];
  const images = attachments.flatMap((attachment) => {
    const image = inlineImage(attachment);
    return image ? [image] : [];
  });
  if (images.length === 0) return null;

  const time = isRecord(value.state.time) ? value.state.time : {};
  return {
    state: value.state,
    images,
    inlineBytes: images.reduce((total, image) => total + image.bytes, 0),
    compacted: typeof time.compacted === "number",
  };
}

function inlineImageParts(messages: unknown[]): InlineImagePart[] {
  const result: InlineImagePart[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const imagePart = inlineImagePart(part);
      if (imagePart) result.push(imagePart);
    }
  }
  return result;
}

function markCompacted(part: InlineImagePart): void {
  const time = isRecord(part.state.time) ? part.state.time : {};
  part.state.time = { ...time, compacted: Date.now() };
  part.compacted = true;
}

function hasExactDuplicate(image: InlineImage, seen: Map<string, string[]>): boolean {
  return seen.get(image.key)?.some((url) => url === image.url) ?? false;
}

function rememberImages(images: InlineImage[], seen: Map<string, string[]>): void {
  for (const image of images) {
    const urls = seen.get(image.key);
    if (!urls) {
      seen.set(image.key, [image.url]);
    } else if (!urls.some((url) => url === image.url)) {
      urls.push(image.url);
    }
  }
}

function compactDuplicateImages(parts: InlineImagePart[]): void {
  const seen = new Map<string, string[]>();
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.compacted) continue;
    if (part.images.every((image) => hasExactDuplicate(image, seen))) {
      markCompacted(part);
      continue;
    }
    rememberImages(part.images, seen);
  }
}

function applyInlineImageBudget(parts: InlineImagePart[]): void {
  const active = parts.filter((part) => !part.compacted);
  let activeBytes = active.reduce((total, part) => total + part.inlineBytes, 0);
  if (activeBytes <= TARGET_INLINE_IMAGE_BYTES) return;

  const prunable = active.slice(0, Math.max(0, active.length - PRESERVE_RECENT_IMAGE_PARTS));
  for (const part of prunable) {
    markCompacted(part);
    activeBytes = Math.max(0, activeBytes - part.inlineBytes);
    if (activeBytes <= TARGET_INLINE_IMAGE_BYTES) break;
  }
}

function factoryDirectory(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.directory === "string" && value.directory) return value.directory;
  if (typeof value.worktree === "string" && value.worktree) return value.worktree;
  return null;
}

function imagePath(input: ToolInput, output?: { args?: unknown }): string | null {
  if (input.tool !== "read" || typeof input.sessionID !== "string" || !input.sessionID) return null;
  const args = isRecord(output?.args) ? output.args : isRecord(input.args) ? input.args : null;
  if (!args) return null;
  const value = typeof args.filePath === "string"
    ? args.filePath
    : typeof args.path === "string"
      ? args.path
      : null;
  if (!value || !IMAGE_EXTENSIONS.has(extname(value).toLowerCase())) return null;
  return value;
}

async function imageVersion(path: string, directory: string | null): Promise<{ path: string; version: string } | null> {
  const resolvedPath = isAbsolute(path) ? path : directory ? resolve(directory, path) : resolve(path);
  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) return null;
    return {
      path: resolvedPath,
      version: `${info.size}:${info.mtimeMs}`,
    };
  } catch {
    // Let OpenCode's read tool report missing or inaccessible paths normally.
    return null;
  }
}

function deletedSessionID(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.event) || value.event.type !== "session.deleted") return null;
  const properties = value.event.properties;
  if (!isRecord(properties)) return null;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  return isRecord(properties.info) && typeof properties.info.id === "string" ? properties.info.id : null;
}

// Single export: the OpenCode plugin loader treats every export as a factory.
export const JuggleWorkScreenshotHistory = async (factoryInput?: unknown) => {
  const directory = factoryDirectory(factoryInput);
  const readVersions = new Map<string, Map<string, string>>();

  return {
    "tool.execute.before": async (input: ToolInput, output: { args?: unknown }) => {
      const path = imagePath(input, output);
      if (!path || typeof input.sessionID !== "string") return;
      const current = await imageVersion(path, directory);
      if (!current) return;
      if (readVersions.get(input.sessionID)?.get(current.path) !== current.version) return;
      throw new Error(
        `jugglework_duplicate_image_read: ${current.path} was already read in this session and has not changed; reuse the existing image result instead of reading it again`,
      );
    },

    "tool.execute.after": async (input: ToolInput) => {
      const path = imagePath(input);
      if (!path || typeof input.sessionID !== "string") return;
      const current = await imageVersion(path, directory);
      if (!current) return;
      const sessionReads = readVersions.get(input.sessionID) ?? new Map<string, string>();
      sessionReads.set(current.path, current.version);
      readVersions.set(input.sessionID, sessionReads);
    },

    event: async (input: unknown) => {
      const sessionID = deletedSessionID(input);
      if (sessionID) readVersions.delete(sessionID);
    },

    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: unknown[] }) => {
      const parts = inlineImageParts(output.messages);
      compactDuplicateImages(parts);
      applyInlineImageBudget(parts);
    },
  };
};
