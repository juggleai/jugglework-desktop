import type { BusinessFilePurpose, DenClient } from "./den";

const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const businessImageAccept = imageTypes.join(",");
// Same upload origins allowed by the organization's storage settings.
const qiniuOrigin = /^https:\/\/(?:up|upload)(?:-(?:z0|z1|z2|cn-east-2|na0|as0))?\.qiniup\.com\/?$/;
const directUploadOptions = { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" } as const;
const invalidGrant = "上传凭据无效或已过期，请重新选择文件。";

function secureUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function putGrantUrl(value: unknown) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\#]/.test(value)) return null;
  const authority = /^https:\/\/([^/?]+)/.exec(value)?.[1];
  return authority && !authority.includes("@") ? secureUrl(value) : null;
}

function downloadPathMatchesKey(url: URL, key: string) {
  const segments = key.split("/");
  const path = url.pathname.slice(1).split("/");
  if (path.length < segments.length || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return false;
  try {
    return path.slice(-segments.length).every((segment, index) => decodeURIComponent(segment) === segments[index]);
  } catch {
    return false;
  }
}

function putUploadHeaders(value: unknown, contentType: string, oss: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const overwrite = oss ? "x-oss-forbid-overwrite" : "If-None-Match";
  const overwriteValue = oss ? "true" : "*";
  const entries = Object.entries(value);
  // Validate before Fetch normalizes or coalesces names. Send only these two
  // known values, and let the browser supply Content-Length for the Blob.
  if (entries.length !== 2 ||
      !entries.some(([name, val]) => name.toLowerCase() === "content-type" && val === contentType) ||
      !entries.some(([name, val]) => name.toLowerCase() === overwrite.toLowerCase() && val === overwriteValue)) return null;
  return { "Content-Type": contentType, [overwrite]: overwriteValue };
}

function hasUploadSignature(url: URL, oss: boolean) {
  // The storage provider verifies the signature; reject unsigned grants here.
  const names = oss ? ["x-oss-signature", "Signature"] : ["X-Amz-Signature"];
  const values = names.flatMap(name => url.searchParams.getAll(name));
  return values.length === 1 && Boolean(values[0].trim());
}

export async function uploadBusinessFile({ client, organizationId, file, purpose, taskId, signal }: {
  client: Pick<DenClient, "createFileUploadCredentials">;
  organizationId: string;
  file: File;
  purpose: BusinessFilePurpose;
  taskId?: string;
  signal?: AbortSignal;
}): Promise<{ url: string; name: string }> {
  signal?.throwIfAborted();
  if (!organizationId.trim()) throw new Error("请先选择上传文件所属的组织。");
  if (!["avatar", "task_image", "task_attachment"].includes(purpose)) throw new Error("不支持此文件用途。");
  const attachment = purpose === "task_attachment";
  if (!attachment && !imageTypes.includes(file.type)) {
    throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  }
  const limit = attachment ? 20 : 5;
  if (!file.name.trim() || !file.size) throw new Error("请选择非空文件。");
  if (file.size > limit * 1024 * 1024) throw new Error(`文件不能超过 ${limit} MiB。`);

  // Generic attachments are downloads, not inline resources. This also handles
  // files with no extension or browser-provided MIME type.
  const payload = attachment ? file.slice(0, file.size, "application/octet-stream") : file;
  const grant = await client.createFileUploadCredentials(organizationId, {
    purpose, fileName: file.name, contentType: payload.type, sizeBytes: file.size,
    ...(taskId !== undefined ? { taskId } : {}),
  }, { signal });
  signal?.throwIfAborted();
  if (typeof grant?.key !== "string" || !grant.key.trim() || typeof grant.expiresAt !== "string" ||
      !(Date.parse(grant.expiresAt) > Date.now())) throw new Error(invalidGrant);

  // File bytes go directly from the renderer to storage, never through Den.
  if (grant.provider !== "qiniu") {
    const oss = grant.provider === "oss";
    if ((!oss && grant.provider !== "aws" && grant.provider !== "minio") || grant.method !== "PUT") throw new Error(invalidGrant);
    const upload = putGrantUrl(grant.uploadUrl);
    const download = putGrantUrl(grant.fileUrl);
    const headers = putUploadHeaders(grant.headers, payload.type, oss);
    if (!upload || !hasUploadSignature(upload, oss) || !download || grant.fileUrl.includes("?") ||
        !downloadPathMatchesKey(download, grant.key) || !headers) throw new Error(invalidGrant);

    const response = await fetch(upload.href, {
      ...directUploadOptions, method: "PUT", body: payload, headers, signal,
    }).catch(() => {
      signal?.throwIfAborted();
      // Fetch failures can include the signed request URL on some runtimes.
      throw new Error("文件上传失败，请重试。");
    });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`文件上传失败（HTTP ${response.status}）。`);
    return { url: grant.fileUrl, name: file.name };
  }

  const upload = secureUrl(grant.uploadUrl);
  // Match upload service hosts only, not arbitrary Qiniu-hosted customer domains.
  if (!upload || !qiniuOrigin.test(grant.uploadUrl) || !secureUrl(grant.fileUrl) ||
      typeof grant.token !== "string" || !grant.token.trim()) {
    throw new Error(invalidGrant);
  }

  const form = new FormData();
  form.append("token", grant.token);
  form.append("key", grant.key);
  form.append("file", payload, attachment ? "attachment.bin" : file.name);
  const response = await fetch(upload.href, {
    ...directUploadOptions, method: "POST", body: form, signal,
  });
  if (!response.ok) throw new Error(`文件上传失败（HTTP ${response.status}）。`);
  const receipt = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (receipt?.key !== grant.key) throw new Error("上传回执无效，请重新上传。");
  return { url: grant.fileUrl, name: file.name };
}
