import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const QINIU_BLOCK_SIZE = 4 * 1024 * 1024;

const MIME_TYPES = new Map([
  [".zip", "application/zip"],
  [".dmg", "application/x-apple-diskimage"],
  [".blockmap", "application/octet-stream"],
  [".yml", "text/yaml"],
  [".yaml", "text/yaml"],
  [".json", "application/json"],
  [".lock", "application/json"],
]);

export function mimeTypeForPath(filePath) {
  const lower = filePath.toLowerCase();
  for (const [extension, mime] of MIME_TYPES) {
    if (lower.endsWith(extension)) return mime;
  }
  return "application/octet-stream";
}

function encodeQiniuEtag(blockDigests) {
  const singleBlock = blockDigests.length === 1;
  const digest = singleBlock
    ? blockDigests[0]
    : createHash("sha1").update(Buffer.concat(blockDigests)).digest();
  return Buffer.concat([Buffer.from([singleBlock ? 0x16 : 0x96]), digest]).toString("base64url");
}

export function qiniuEtagBuffer(value, blockSize = QINIU_BLOCK_SIZE) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const blockDigests = [];
  if (buffer.length === 0) blockDigests.push(createHash("sha1").update(buffer).digest());
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blockDigests.push(createHash("sha1").update(buffer.subarray(offset, offset + blockSize)).digest());
  }
  return encodeQiniuEtag(blockDigests);
}

export function metadataForBuffer(value, name) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return {
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sha512: createHash("sha512").update(buffer).digest("base64"),
    etag: qiniuEtagBuffer(buffer),
    mime: mimeTypeForPath(name),
  };
}

export async function inspectArtifact(filePath) {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error(`Artifact is not a regular file: ${filePath}`);

  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const blockDigests = [];
  let blockHash = createHash("sha1");
  let blockBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    sha256.update(chunk);
    sha512.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const available = QINIU_BLOCK_SIZE - blockBytes;
      const part = chunk.subarray(offset, offset + available);
      blockHash.update(part);
      blockBytes += part.length;
      offset += part.length;
      if (blockBytes === QINIU_BLOCK_SIZE) {
        blockDigests.push(blockHash.digest());
        blockHash = createHash("sha1");
        blockBytes = 0;
      }
    }
  }
  if (blockBytes > 0 || file.size === 0) blockDigests.push(blockHash.digest());

  return {
    size: file.size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
    etag: encodeQiniuEtag(blockDigests),
    mime: mimeTypeForPath(filePath),
  };
}

export function isCanonicalSha512(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 64 && Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}
