import type { BusinessFilePurpose, DenClient } from "./den";

const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const businessImageAccept = imageTypes.join(",");
// Same upload origins allowed by the organization's storage settings.
const qiniuOrigin = /^https:\/\/(?:up|upload)(?:-(?:z0|z1|z2|cn-east-2|na0|as0))?\.qiniup\.com\/?$/;

function secureUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
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
  const upload = secureUrl(grant?.uploadUrl);
  // Match upload service hosts only, not arbitrary Qiniu-hosted customer domains.
  if (grant?.provider !== "qiniu" || !upload || !qiniuOrigin.test(grant.uploadUrl) ||
      !secureUrl(grant.fileUrl) || typeof grant.token !== "string" || !grant.token.trim() ||
      typeof grant.key !== "string" || !grant.key.trim() || typeof grant.expiresAt !== "string" ||
      !(Date.parse(grant.expiresAt) > Date.now())) {
    throw new Error("上传凭据无效或已过期，请重新选择文件。");
  }

  const form = new FormData();
  form.append("token", grant.token);
  form.append("key", grant.key);
  form.append("file", payload, attachment ? "attachment.bin" : file.name);
  // Use renderer fetch, never the authenticated Den/main-process transport.
  const response = await fetch(upload.href, {
    method: "POST", body: form, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`文件上传失败（HTTP ${response.status}）。`);
  const receipt = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (receipt?.key !== grant.key) throw new Error("上传回执无效，请重新上传。");
  return { url: grant.fileUrl, name: file.name };
}
