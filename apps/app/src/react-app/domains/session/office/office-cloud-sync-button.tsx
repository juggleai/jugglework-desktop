import * as React from "react";
import { Button } from "@/components/ui/button";

/** 云端同步图标：未开启／暂停为向上箭头，已开启为上下双箭头，两种状态均跟随主题灰色。 */
export function OfficeCloudSyncIcon({ enabled, busy = false }: { enabled: boolean; busy?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`size-5${busy ? " animate-pulse" : ""}`}>
    <path d="M4.8 17a4.5 4.5 0 0 1 .4-8.8 7 7 0 0 1 13.6 0 4.5 4.5 0 0 1 .4 8.8" />
    {enabled ? <path d="M8.5 21v-9m-3 3 3-3 3 3M16 12v9m-3-3 3 3 3-3" /> :
      <path d="M12 21v-9m-3.5 3.5L12 12l3.5 3.5" />}
  </svg>;
}

/** 两种文件宿主共用的云端图标按钮；说明放入系统提示，避免被原生 Office 页面遮挡。 */
export function OfficeCloudSyncButton({ status, title, disabled = false, onClick }: {
  status: string; title: string; disabled?: boolean; onClick?: () => void;
}) {
  const busy = status === "uploading" || status === "attaching";
  return <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground"
    title={title} aria-label={title} aria-busy={busy} aria-disabled={disabled || !onClick}
    data-office-cloud-sync={status} onClick={() => { if (!disabled) onClick?.(); }}>
    <OfficeCloudSyncIcon enabled={status === "active"} busy={busy} />
  </Button>;
}
