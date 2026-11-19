import { createDenClient, readDenSettings, readDenUserId } from "@/app/lib/den";
import { desktopBridge, resolveWorkspaceListSelectedId } from "@/app/lib/desktop";
import { isFileWindowRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { parseWorkspaceAppPath } from "../../shell/workspace-routes";
import { useJuggleWorkServer } from "../connections/jugglework-server-provider";
import { CloudDocsApiResponder } from "./cloud-docs-api-responder";
import { FileWindowUploadRelay } from "./use-cloud-upload";

/** 使用 Desk 当前登录为独立标签申请一次性授权。 */
function useOpenCloudTabRequests() {
  const { pathname } = useLocation();
  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.fileWindow;
    return bridge?.onOpenCloudTabRequest?.(request => {
      if (!bridge.openCloud) return;
      const { document, sourceInstanceId, sourceServerOrigin, sourceUserId } = request;
      const settings = readDenSettings();
      const isCurrent = () => {
        const current = readDenSettings();
        return Boolean(settings.authToken) && current.authToken === settings.authToken &&
          current.activeOrgId === document.tenantId && current.baseUrl === sourceServerOrigin &&
          readDenUserId() === sourceUserId;
      };
      if (!isCurrent()) return;
      void (async () => {
        const list = await desktopBridge.workspaceBootstrap();
        const workspaces = list.workspaces.filter(item => item.path && item.workspaceType !== "remote" && !item.hidden && !item.fileAssistantManaged);
        const route = parseWorkspaceAppPath(pathname);
        const inSession = route?.view === "session" && Boolean(route.sessionId) &&
          workspaces.some(item => item.id === route.workspaceId);
        const workspaceId = inSession ? route.workspaceId : resolveWorkspaceListSelectedId({ ...list, workspaces });
        const sessionId = (inSession ? route.sessionId : null) ?? "file-browser";
        if (!workspaceId) throw new Error("local_workspace_unavailable");
        if (!isCurrent()) return;
        const launch = await createDenClient({ baseUrl: sourceServerOrigin, token: settings.authToken }).launchCloudDocs({
          tenantId: document.tenantId,
          target: { kind: "page", workspaceId: document.workspaceId, pageId: document.docId },
          presentation: { instanceId: crypto.randomUUID(), mode: "product" },
        });
        // TIPS: 不把迟到的授权交给已切换账号或组织的宿主。
        if (isCurrent()) await bridge.openCloud?.({ workspaceId, sessionId, document, launch, sourceServerOrigin, sourceUserId, sourceInstanceId });
      })().catch(() => {
        if (isCurrent()) toast.error(t("cloud_docs.connection_failed"));
      });
    });
  }, [pathname]);
}

/** 根层只保留一份请求监听；导航或关闭文件面板不影响上传、分享查找和后台 AI 请求。 */
export function CloudDocsCoordinator() {
  const store = useJuggleWorkServer();
  useOpenCloudTabRequests();
  if (isFileWindowRuntime()) return null;
  const client = store.getSnapshot().juggleworkServerClient;
  return <><CloudDocsApiResponder client={client} /><FileWindowUploadRelay client={client} /></>;
}
