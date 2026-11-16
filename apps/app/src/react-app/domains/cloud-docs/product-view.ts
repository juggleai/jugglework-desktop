import { fileCloudDocView } from "@/app/lib/cloud-doc-turn";
import { createDenClient, readDenSettings, readDenUserId, isCurrentDenSessionRevocation } from "@/app/lib/den";
import { denSettingsChangedEvent, denSessionUpdatedEvent, denSessionRevokedEvent } from "@/app/lib/den-session-events";
import type { CloudDocsBridge } from "@/app/lib/cloud-docs-types";
import { createProductViewPool } from "./product-view-pool";

/** 非敏感来源范围；令牌不进入缓存键或持久记录。 */
export function cloudDocsScope(tenantId = readDenSettings().activeOrgId ?? "") {
  const settings = readDenSettings();
  return JSON.stringify([settings.baseUrl, readDenUserId(), tenantId]);
}
const origins = new Map<string, string>();
/** 只记录真正启动过的产品页来源，后续分享不申请交接凭据。 */
export function rememberCloudDocsOrigin(tenantId: string, url: string) { origins.set(cloudDocsScope(tenantId), new URL(url).origin); }
/** 已知的当前来源账号、组织 Docs 域名。 */
export function cloudDocsOrigin(tenantId: string) { return origins.get(cloudDocsScope(tenantId)); }

const pool = createProductViewPool({
  idleMs: 120_000,
  async create(instanceId, key, active) {
    const settings = readDenSettings();
    const tenantId = settings.activeOrgId;
    const sourceUserId = readDenUserId();
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    if (!bridge || !tenantId || !settings.authToken || !sourceUserId || key !== cloudDocsScope(tenantId)) throw new Error("switch_organization_required");
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      unsubscribe = bridge.onState(state => {
        if (state.instanceId !== instanceId) return;
        if (state.status === "ready") resolve();
        else if (state.status === "error" || state.status === "unauthorized") reject(new Error("cloud_docs_unavailable"));
      });
      // TIPS: 后台首次加载与可见产品页采用相同的远端资源等待窗口。
      timer = setTimeout(() => reject(new Error("cloud_docs_unavailable")), 60_000);
    });
    void ready.catch(() => undefined);
    try {
      const launch = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken }).launchCloudDocs({ tenantId, target: { kind: "home" }, presentation: { instanceId, mode: "product" } });
      if (!active() || key !== cloudDocsScope() || readDenSettings().authToken !== settings.authToken) throw new Error("cloud_docs_scope_changed");
      rememberCloudDocsOrigin(tenantId, launch.bootstrapUrl);
      await bridge.open({ ...launch, instanceId, sourceServerOrigin: settings.baseUrl, sourceUserId, background: true });
      await ready;
    } finally { clearTimeout(timer); unsubscribe(); }
  },
  close: id => window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.close(id) ?? Promise.resolve(),
});
let installed = false;
/** 复用组织后台页，搜索、链接校验、AI 和上传共用；授权变化会立即清理。 */
export async function withProductView<T>(bridge: CloudDocsBridge, tenantId: string, run: (instanceId: string) => Promise<T>) {
  const fileView = fileCloudDocView();
  if (fileView?.tenantId === tenantId) return run(fileView.instanceId);
  if (!installed) {
    installed = true;
    let scope = cloudDocsScope();
    let token = readDenSettings().authToken;
    const changed = () => {
      const next = cloudDocsScope(), nextToken = readDenSettings().authToken;
      if (scope !== next || token !== nextToken || !nextToken) pool.clear();
      scope = next; token = nextToken;
    };
    window.addEventListener(denSettingsChangedEvent, changed);
    window.addEventListener(denSessionUpdatedEvent, changed);
    window.addEventListener(denSessionRevokedEvent, event => { if (isCurrentDenSessionRevocation(event)) pool.clear(); });
    window.addEventListener("pagehide", () => pool.clear());
    bridge.onState(state => { if (state.status === "error" || state.status === "unauthorized") pool.invalidate(state.instanceId); });
  }
  if (!readDenSettings().authToken || readDenSettings().activeOrgId !== tenantId) throw new Error("switch_organization_required");
  return pool.run(cloudDocsScope(tenantId), run);
}

/** 固定域名从当前权威 Work 读取；仅缓存来源，绝不为链接申请 grant。 */
export async function configuredCloudDocsOrigin(tenantId: string) {
  const fileView = fileCloudDocView();
  if (fileView?.tenantId === tenantId && fileView.docsOrigin) return fileView.docsOrigin;
  const known = cloudDocsOrigin(tenantId);
  if (known) return known;
  const settings = readDenSettings();
  const result = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken }).docsConfiguration();
  if (!result.docs?.enabled || !result.docs.publicOrigin) return undefined;
  if (settings.baseUrl !== readDenSettings().baseUrl || settings.authToken !== readDenSettings().authToken) return undefined;
  const origin = new URL(result.docs.publicOrigin).origin;
  rememberCloudDocsOrigin(tenantId, origin);
  return origin;
}

// 开发热更新也释放旧模块持有的后台页，避免遗留无主原生实例。
if (import.meta.hot) import.meta.hot.dispose(() => pool.clear());
