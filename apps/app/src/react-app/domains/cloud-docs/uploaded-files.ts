import { readDenSettings, readDenUserId, isCurrentDenSessionRevocation } from "@/app/lib/den";
import { denSettingsChangedEvent, denSessionUpdatedEvent, denSessionRevokedEvent } from "@/app/lib/den-session-events";
import { cloudDocsScope } from "./product-view";

/** 最近一次上传结果，仅用于复制链接；不跟踪或同步本地文件内容。 */
export type UploadedCloudFile = { localWorkspaceId: string; path: string; tenantId: string; workspaceId: string; pageId: string; url: string };
const key = "jugglework-cloud-upload-results-v1";
const listeners = new Set<() => void>();
let loadedScope: string | null = null;
let records: UploadedCloudFile[] = [];
let installed = false;
let revokedToken: string | null = null;

/** 当前账号组织的最近上传结果，其他账号和组织不参与展示。 */
export function uploadedCloudFiles(): UploadedCloudFile[] {
  const token = readDenSettings().authToken;
  const scope = token && token !== revokedToken && readDenUserId() ? cloudDocsScope() : "";
  if (loadedScope === scope) return records;
  loadedScope = scope;
  try { const saved = scope ? JSON.parse(localStorage.getItem(key) || "{}")[scope] : null; records = Array.isArray(saved) ? saved : []; }
  catch { records = []; }
  return records;
}

/** 向独立文件窗口同步链接展示数据，不传递凭据。 */
function publish() {
  const files = uploadedCloudFiles();
  void window.__JUGGLEWORK_ELECTRON__?.fileWindow?.setCloudUploads?.({ scope: loadedScope || null, records: files }).catch(() => undefined);
  listeners.forEach(listener => listener());
}

/** 安装主窗口的范围变化收口；退出和切换后独立窗口立即撤下旧分享入口。 */
export function installUploadedCloudFiles() {
  if (installed) return;
  installed = true;
  window.addEventListener(denSettingsChangedEvent, publish);
  window.addEventListener(denSessionUpdatedEvent, publish);
  window.addEventListener(denSessionRevokedEvent, event => {
    if (!isCurrentDenSessionRevocation(event)) return;
    revokedToken = readDenSettings().authToken ?? null;
    records = []; loadedScope = null;
    void window.__JUGGLEWORK_ELECTRON__?.fileWindow?.setCloudUploads?.({ scope: null, records: [] });
    listeners.forEach(listener => listener());
  });
  publish();
}

/** 成功上传或选择已有文档后记录最新链接；再次上传只更新最近结果。 */
export function rememberUploadedCloudFile(file: UploadedCloudFile) {
  uploadedCloudFiles();
  records = [...records.filter(item => item.localWorkspaceId !== file.localWorkspaceId || item.path !== file.path), file].slice(-200);
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    if (loadedScope) saved[loadedScope] = records;
    localStorage.setItem(key, JSON.stringify(saved));
  } catch { /* 存储不可用时本次窗口仍可分享。 */ }
  publish();
}

/** 订阅当前范围的上传结果。 */
export function subscribeUploadedCloudFiles(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
