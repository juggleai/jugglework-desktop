import { withProductView, cloudDocsOrigin } from "./product-view";
import { rememberUploadedCloudFile } from "./uploaded-files";
import type { CloudDocsBridge, CloudFileIntakeResult } from "@/app/lib/cloud-docs-types";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { readDenSettings, readDenUserId } from "@/app/lib/den";

const MAX_BYTES = 50 * 1024 * 1024;
const storageKey = "jugglework-cloud-docs-file-intake-v1";

/** Docs 支持的上传类型，与服务端白名单一致。 */
export const CLOUD_UPLOAD_EXTENSIONS = ["docx", "md", "markdown", "html", "htm", "doc", "xls", "xlsx", "csv", "ppt", "pptx", "pdf"] as const;

export function canUploadToCloud(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (CLOUD_UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

type Cached = { requestId: string; scope: string; createdAt: number };

/** 同一账号、组织、摘要的重试复用 requestId；另存为新云文档时强制新建。不保存文件内容或令牌。 */
function requestIdFor(scope: string, fresh: boolean) {
  try {
    const prior: Cached | null = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (!fresh && prior?.scope === scope)
      return prior.requestId;
  } catch {
    /* 损坏的缓存由新请求覆盖。 */
  }
  const value: Cached = { requestId: crypto.randomUUID(), scope, createdAt: Date.now() };
  sessionStorage.setItem(storageKey, JSON.stringify(value));
  return value.requestId;
}

function clearRequest(requestId: string) {
  try {
    if (JSON.parse(sessionStorage.getItem(storageKey) || "null")?.requestId === requestId)
      sessionStorage.removeItem(storageKey);
  } catch {
    sessionStorage.removeItem(storageKey);
  }
}

export type CloudUploadOutcome =
  | { status: "opened"; tenantId: string; workspaceId: string; pageId: string }
  | { status: "uploaded"; tenantId: string; workspaceId: string; pageId: string; warnings: string[] };

/**
 * 读取已保存的本地文件，一次性上传为当前组织云文档。
 * 重复上传时由 onDuplicate 决定打开已有云文档或另存为新云文档。
 */
export async function uploadCloudFile(input: {
  bridge: CloudDocsBridge;
  fileClient: Pick<JuggleWorkServerClient, "statWorkspaceFile" | "downloadWorkspaceFile">;
  localWorkspaceId: string;
  relativePath: string;
  /** AI 请求所属组织；组织切换后的迟到请求不得上传到当前其他组织。 */
  expectedTenantId?: string;
  onDuplicate: (existing: NonNullable<CloudFileIntakeResult["existing"]>) => Promise<"open" | "new" | "cancel">;
}): Promise<CloudUploadOutcome | null> {
  const { bridge, fileClient } = input;
  const settings = readDenSettings();
  const sourceUserId = readDenUserId();
  const tenantId = settings.activeOrgId;
  if (!settings.authToken || !tenantId || !sourceUserId) throw new Error("cloud_upload_organization_required");
  if (input.expectedTenantId && input.expectedTenantId !== tenantId) throw new Error("switch_organization_required");
  const assertScope = () => {
    const current = readDenSettings();
    if (current.baseUrl !== settings.baseUrl || current.activeOrgId !== tenantId ||
      current.authToken !== settings.authToken || readDenUserId() !== sourceUserId)
      throw new Error("cloud_upload_source_changed");
  };
  const stat = await fileClient.statWorkspaceFile(input.localWorkspaceId, input.relativePath);
  if (!stat.exists || stat.kind !== "file" || !Number.isSafeInteger(stat.size) || stat.size! <= 0)
    throw new Error("cloud_upload_file_unavailable");
  if (stat.size! > MAX_BYTES) throw new Error("cloud_upload_file_too_large");
  const original = await fileClient.downloadWorkspaceFile(input.localWorkspaceId, input.relativePath);
  if (original.data.byteLength > MAX_BYTES) throw new Error("cloud_upload_file_too_large");
  const digest = await crypto.subtle.digest("SHA-256", original.data);
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const fileName = original.filename || input.relativePath.split(/[\\/]/).pop() || "file";
  assertScope();
  return withProductView(bridge, tenantId, async instanceId => {
    const target = { instanceId };
    assertScope();
    const scope = `${settings.baseUrl}\0${sourceUserId}\0${tenantId}\0${checksum}`;
    const lookup = await bridge.fileIntake({ action: "lookup", ...target, requestId: crypto.randomUUID(), checksum });
    let fresh = false;
    if (lookup.existing?.length) {
      const choice = await input.onDuplicate(lookup.existing);
      if (choice === "cancel") return null;
      if (choice === "open") {
        assertScope();
        const existing = lookup.existing[0];
        remember(existing.workspaceId, existing.pageId);
        return { status: "opened", tenantId, workspaceId: existing.workspaceId, pageId: existing.pageId };
      }
      fresh = true;
    }
    const requestId = requestIdFor(scope, fresh);
    const result = await bridge.fileIntake({
      action: "upload", ...target, requestId, checksum, fileName,
      mimeType: original.contentType || "application/octet-stream", fileData: original.data,
    });
    assertScope();
    if (!result.pageId || !result.workspaceId || result.state !== "completed") throw new Error("cloud_upload_result_unknown");
    clearRequest(requestId);
    remember(result.workspaceId, result.pageId);
    return { status: "uploaded", tenantId, workspaceId: result.workspaceId, pageId: result.pageId, warnings: result.warnings ?? [] };
  });
  /** 记录可分享的原生页面地址；链接不包含交接凭据，也不改变页面权限。 */
  function remember(workspaceId: string, pageId: string) {
    const origin = cloudDocsOrigin(tenantId!);
    if (!origin) return;
    rememberUploadedCloudFile({ localWorkspaceId: input.localWorkspaceId, path: input.relativePath, tenantId: tenantId!, workspaceId, pageId,
      url: `${origin}/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pageId)}?tenantId=${encodeURIComponent(tenantId!)}` });
  }
}

/** 首次打开旧文件时按完整摘要核对既有上传；仅精确匹配，不按文件名猜测关联。 */
export async function lookupUploadedCloudFile(fileClient: Pick<JuggleWorkServerClient, "statWorkspaceFile" | "downloadWorkspaceFile">, localWorkspaceId: string, path: string) {
  if (!canUploadToCloud(path)) return;
  const settings = readDenSettings();
  const sourceUserId = readDenUserId();
  const tenantId = settings.activeOrgId;
  const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
  if (!bridge || !tenantId || !settings.authToken || !sourceUserId) return;
  const stat = await fileClient.statWorkspaceFile(localWorkspaceId, path);
  if (!stat.exists || stat.kind !== "file" || !stat.size || stat.size > MAX_BYTES) return;
  const original = await fileClient.downloadWorkspaceFile(localWorkspaceId, path);
  if (!original.data.byteLength || original.data.byteLength > MAX_BYTES) return;
  const digest = await crypto.subtle.digest("SHA-256", original.data);
  const checksum = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const result = await withProductView(bridge, tenantId, instanceId => bridge.fileIntake({ action: "lookup", instanceId, requestId: crypto.randomUUID(), checksum }));
  const current = readDenSettings();
  const origin = cloudDocsOrigin(tenantId);
  const existing = result.existing?.[0];
  if (!existing || !origin || current.baseUrl !== settings.baseUrl || current.authToken !== settings.authToken || current.activeOrgId !== tenantId || readDenUserId() !== sourceUserId) return;
  rememberUploadedCloudFile({ localWorkspaceId, path, tenantId, workspaceId: existing.workspaceId, pageId: existing.pageId,
    url: `${origin}/workspace/${encodeURIComponent(existing.workspaceId)}/${encodeURIComponent(existing.pageId)}?tenantId=${encodeURIComponent(tenantId!)}` });
}
