import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { ToonAssetDescriptor, ToonWorkspaceNode } from "@jugglework/types/toon-workspace";
import { TOON_ASSET_MAX_BYTES } from "@jugglework/types/toon-workspace";
import { ApiError } from "../errors.js";

type DetectedAsset = {
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export type InspectedAssetStream = DetectedAsset & {
  bytes: number;
  checksum: string;
  sourceDev?: number;
  sourceIno?: number;
  parentDev?: number;
  parentIno?: number;
};

const ASSET_INSPECTION_PREFIX_BYTES = 1024 * 1024;

const EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4", ".m4v"],
  "video/webm": [".webm"],
  "audio/wav": [".wav"],
  "audio/mpeg": [".mp3"],
  "audio/ogg": [".ogg", ".oga"],
  "text/plain": [".txt", ".text"],
  "text/markdown": [".md", ".markdown"],
};

export function normalizeAssetFilename(input: string): string {
  const value = input.normalize("NFKC").trim();
  if (!value || value !== basename(value) || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new ApiError(400, "toon_asset_filename_invalid", "Asset filename must be a plain filename");
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").slice(0, 255).trim();
  if (!normalized) throw new ApiError(400, "toon_asset_filename_invalid", "Asset filename is invalid");
  return normalized;
}

export function inspectAssetBytes(bytes: Uint8Array, filename: string, declaredMimeType?: string): DetectedAsset {
  if (bytes.byteLength === 0) throw new ApiError(400, "toon_asset_empty", "Empty assets are not supported");
  if (bytes.byteLength > TOON_ASSET_MAX_BYTES) {
    throw new ApiError(413, "toon_asset_too_large", "Asset exceeds the 100 MB project limit", { maxBytes: TOON_ASSET_MAX_BYTES, size: bytes.byteLength });
  }
  const name = normalizeAssetFilename(filename);
  const extension = extname(name).toLowerCase();
  const rawDetected = detect(bytes);
  const detected = rawDetected.mimeType === "text/plain" && [".md", ".markdown"].includes(extension)
    ? { ...rawDetected, mimeType: "text/markdown" }
    : rawDetected;
  const expectedExtensions = EXTENSIONS[detected.mimeType] ?? [];
  if (!expectedExtensions.includes(extension)) {
    throw new ApiError(400, "toon_asset_signature_mismatch", "Asset extension does not match its content signature", { detectedMimeType: detected.mimeType });
  }
  if (declaredMimeType && declaredMimeType.toLowerCase() !== detected.mimeType) {
    throw new ApiError(400, "toon_asset_signature_mismatch", "Declared MIME type does not match the asset signature", { detectedMimeType: detected.mimeType });
  }
  return { ...detected, extension };
}

export async function inspectAssetStream(chunks: AsyncIterable<Uint8Array>, filename: string, declaredMimeType?: string): Promise<InspectedAssetStream> {
  const hash = createHash("sha256");
  const prefix: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let prefixBytes = 0;
  let bytes = 0;
  let textValid = true;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > TOON_ASSET_MAX_BYTES) throw new ApiError(413, "toon_asset_too_large", "Asset exceeds the 100 MB project limit", { maxBytes: TOON_ASSET_MAX_BYTES, size: bytes });
    hash.update(chunk);
    if (prefixBytes < ASSET_INSPECTION_PREFIX_BYTES) {
      const retained = Buffer.from(chunk.subarray(0, ASSET_INSPECTION_PREFIX_BYTES - prefixBytes));
      prefix.push(retained);
      prefixBytes += retained.byteLength;
    }
    if (textValid) {
      if (chunk.includes(0)) textValid = false;
      else {
        try { decoder.decode(chunk, { stream: true }); } catch { textValid = false; }
      }
    }
  }
  if (bytes === 0) throw new ApiError(400, "toon_asset_empty", "Empty assets are not supported");
  if (textValid) {
    try { decoder.decode(); } catch { textValid = false; }
  }
  const inspected = inspectAssetBytes(Buffer.concat(prefix), filename, declaredMimeType);
  if (inspected.mimeType.startsWith("text/") && !textValid) throw new ApiError(415, "toon_asset_type_unsupported", "Only safe image, video, audio, and plain-text assets are supported");
  return { ...inspected, bytes, checksum: hash.digest("hex") };
}

export function assetChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compatibleAssetNode(asset: Pick<ToonAssetDescriptor, "id" | "title" | "mimeType" | "checksum">, nodeId: string, position: { x: number; y: number }): ToonWorkspaceNode {
  const dataType = asset.mimeType.startsWith("image/") ? "image" : asset.mimeType.startsWith("video/") ? "video" : asset.mimeType.startsWith("text/") ? "text" : null;
  if (!dataType) throw new ApiError(415, "toon_asset_node_unsupported", "This asset type cannot create a canvas node");
  const kind = dataType === "image" ? "image-asset" : dataType === "video" ? "video-asset" : "text";
  return {
    id: nodeId,
    kind,
    position,
    handles: [
      { id: `${nodeId}-in`, direction: "target", dataType },
      { id: `${nodeId}-out`, direction: "source", dataType },
    ],
    config: { label: asset.title, asset: { kind: "asset", id: asset.id, revision: asset.checksum } },
  };
}

export function isSafeAssetPreviewMime(mimeType: string): boolean {
  return [
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "video/mp4", "video/webm",
    "audio/wav", "audio/mpeg", "audio/ogg",
    "text/plain",
  ].includes(mimeType);
}

function detect(bytes: Uint8Array): Omit<DetectedAsset, "extension"> {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", ...(b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : {}) };
  }
  if (b.length >= 10 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mimeType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = b.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { mimeType: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return { mimeType: "image/webp" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const dimensions = jpegDimensions(b);
    return { mimeType: "image/jpeg", ...dimensions };
  }
  if (b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp") {
    return { mimeType: "video/mp4", ...mp4Duration(b) };
  }
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: "video/webm" };
  if (b.length >= 44 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WAVE") {
    const byteRate = b.readUInt32LE(28);
    const dataOffset = b.indexOf("data", 12, "ascii");
    const dataBytes = dataOffset >= 0 && dataOffset + 8 <= b.length ? b.readUInt32LE(dataOffset + 4) : 0;
    return { mimeType: "audio/wav", ...(byteRate > 0 && dataBytes > 0 ? { durationSeconds: dataBytes / byteRate } : {}) };
  }
  if (b.length >= 3 && (b.subarray(0, 3).toString("ascii") === "ID3" || b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { mimeType: "audio/mpeg" };
  if (b.length >= 4 && b.subarray(0, 4).toString("ascii") === "OggS") return { mimeType: "audio/ogg" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (b.includes(0)) throw new Error("binary");
    return { mimeType: "text/plain" };
  } catch {
    throw new ApiError(415, "toon_asset_type_unsupported", "Only safe image, video, audio, and plain-text assets are supported");
  }
}

function jpegDimensions(bytes: Buffer): { width?: number; height?: number } {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += size + 2;
  }
  return {};
}

function mp4Duration(bytes: Buffer): { durationSeconds?: number } {
  const offset = bytes.indexOf("mvhd", 0, "ascii");
  if (offset < 0 || offset + 24 >= bytes.length) return {};
  const version = bytes[offset + 4];
  const timescaleOffset = offset + (version === 1 ? 24 : 16);
  const durationOffset = timescaleOffset + 4;
  if (durationOffset + (version === 1 ? 8 : 4) > bytes.length) return {};
  const timescale = bytes.readUInt32BE(timescaleOffset);
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(durationOffset)) : bytes.readUInt32BE(durationOffset);
  return timescale > 0 && duration > 0 ? { durationSeconds: duration / timescale } : {};
}
