import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { VideoArtifact } from "./types.js";

const MIME_EXTENSION: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

export function safeWorkspaceChild(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${sep}`)) throw new Error("invalid_video_artifact_path");
  return target;
}

function validSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  if (mimeType === "video/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

export async function publishVideoArtifact(input: { response: Response; workspaceRoot: string; jobId: string; filename?: string; maxBytes: number }): Promise<VideoArtifact> {
  if (!input.response.ok) throw new Error("video_result_download_failed");
  if (input.response.url) {
    const url = new URL(input.response.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("video_result_insecure_url");
  }
  const mimeType = input.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = MIME_EXTENSION[mimeType];
  if (!extension) throw new Error("video_result_invalid_mime");
  const declared = Number(input.response.headers.get("content-length") ?? 0);
  if (declared > input.maxBytes) throw new Error("video_result_too_large");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (input.response.body) {
    const reader = input.response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > input.maxBytes) { await reader.cancel(); throw new Error("video_result_too_large"); }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!validSignature(mimeType, bytes)) throw new Error("video_result_invalid_signature");
  const slug = (input.filename ?? "jugglework-video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "jugglework-video";
  const relativePath = `artifacts/${slug}-${input.jobId}.${extension}`;
  const finalPath = safeWorkspaceChild(input.workspaceRoot, relativePath);
  const tempPath = `${finalPath}.partial`;
  await mkdir(dirname(finalPath), { recursive: true });
  try { await writeFile(tempPath, bytes); await rename(tempPath, finalPath); } catch (error) { await rm(tempPath, { force: true }).catch(() => undefined); throw error; }
  return { path: relativePath, mimeType, bytes: bytes.byteLength };
}
