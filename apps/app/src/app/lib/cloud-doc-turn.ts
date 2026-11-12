import { useSyncExternalStore } from "react";
import { readDenSettings } from "./den";
import { denSessionRevokedEvent, denSessionUpdatedEvent, denSettingsChangedEvent } from "./den-session-events";
import { cloudDocReferences, type CloudDocReference } from "./cloud-doc-reference";
export type { CloudDocReference } from "./cloud-doc-reference";

/** 入队后保留的本轮范围，不在后台发送时重读面板。 */
export type CloudDocTurnInput = { currentTenantId: string | null; references: CloudDocReference[]; activeDoc: CloudDocReference | null };
let fileCloudView: { tenantId: string; instanceId: string; docsOrigin?: string } | null = null;
/** 文件窗口仅记录已授权视图的非敏感绑定，不持有源长期凭据。 */
export function setFileCloudView(value: { tenantId: string; instanceId: string; docsOrigin?: string } | null) { fileCloudView = value; if (typeof window !== "undefined") window.dispatchEvent(new Event("jugglework:file-cloud-view")); }
/** 返回本文件窗口当前实际就绪的原生页。 */
export function fileCloudDocView() { return fileCloudView; }

const activeDocuments = new Map<string, CloudDocReference>();

/** 按会话记录当前打开的云文档；其他会话不能读取该面板上下文。 */
export function setActiveCloudDoc(sessionId: string, doc: CloudDocReference | null) {
  if (doc) activeDocuments.set(sessionId, doc);
  else activeDocuments.delete(sessionId);
}

/** 当前可使用云文档的组织；无云文档桥或未登录时为空。 */
export function cloudDocsTenantId(): string | null {
  if (typeof window === "undefined" || !window.__JUGGLEWORK_ELECTRON__?.cloudDocs) return null;
  const settings = readDenSettings();
  return settings.authToken ? settings.activeOrgId?.trim() || null : fileCloudView?.tenantId ?? null;
}

/** 登录或组织变化时通知订阅方。 */
function subscribeCloudDocsTenant(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("jugglework:file-cloud-view", listener);
  window.addEventListener(denSettingsChangedEvent, listener);
  window.addEventListener(denSessionRevokedEvent, listener);
  window.addEventListener(denSessionUpdatedEvent, listener);
  return () => {
    window.removeEventListener("jugglework:file-cloud-view", listener);
    window.removeEventListener(denSettingsChangedEvent, listener);
    window.removeEventListener(denSessionRevokedEvent, listener);
    window.removeEventListener(denSessionUpdatedEvent, listener);
  };
}

/** 订阅当前云文档组织；enabled 为 false 时恒为空。 */
export function useCloudDocsTenantId(enabled = true): string | null {
  return useSyncExternalStore(subscribeCloudDocsTenant, () => (enabled ? cloudDocsTenantId() : null), () => null);
}

/** 构造草稿时冻结范围；排队发送和重试始终复用这一份快照。 */
export function captureCloudDocTurn(sessionId: string, text: string, includeActive = true): CloudDocTurnInput {
  const currentTenantId = cloudDocsTenantId();
  const active = includeActive ? activeDocuments.get(sessionId) : null;
  return structuredClone({ currentTenantId, references: cloudDocReferences(text), activeDoc: active?.tenantId === currentTenantId ? active : null });
}
