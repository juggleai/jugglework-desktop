import * as React from "react";
import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import { OfficeCloudSyncButton } from "./office-cloud-sync-button";

/** 独立窗口只读取所属 Word 的原生状态，云页面跳转由主窗口按当前身份处理。 */
export function FileWindowCloudSyncAction({ documentId, canOpenSession }: { documentId: string; canOpenSession: boolean }) {
  const bridge = window.__JUGGLEWORK_ELECTRON__?.fileWindow;
  const [status, setStatus] = React.useState("detached");
  React.useEffect(() => {
    let disposed = false;
    setStatus("detached");
    const refresh = () => {
      void bridge?.cloudSyncState?.(documentId).then(value => {
        if (!disposed) setStatus(value.status);
      }).catch(() => { if (!disposed) setStatus("detached"); });
    };
    refresh();
    const stop = bridge?.onCloudSyncChanged?.(value => {
      if (!value.documentId || value.documentId === documentId) refresh();
    });
    return () => { disposed = true; stop?.(); };
  }, [bridge, documentId]);
  const linked = status !== "detached";
  return <OfficeCloudSyncButton status={status}
    title={t(status === "active" ? "cloud_docs.word_sync_active" : linked ? "cloud_docs.word_sync_paused" : "cloud_docs.word_sync_window_inactive")}
    disabled={status === "attaching" || !linked && !canOpenSession}
    onClick={() => {
      const operation = linked ? bridge?.openCloudDocument?.(documentId) : bridge?.action("open-session");
      void operation?.catch(error => toast.error(String(error)));
    }} />;
}
