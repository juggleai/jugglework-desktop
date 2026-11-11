import { Button } from "@/components/ui/button";

/** 云朵上传图标。 */
function OfficeCloudUploadIcon({ busy }: { busy: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`size-5${busy ? " animate-pulse" : ""}`}>
    <path d="M4.8 17a4.5 4.5 0 0 1 .4-8.8 7 7 0 0 1 13.6 0 4.5 4.5 0 0 1 .4 8.8" />
    <path d="M12 21v-9m-3.5 3.5L12 12l3.5 3.5" />
  </svg>;
}

/** 两种文件宿主共用的“上传云文档”按钮；只有一种状态，没有同步关联。 */
export function OfficeCloudUploadButton({ title, busy = false, disabled = false, onClick }: {
  title: string; busy?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  return <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground"
    title={title} aria-label={title} aria-busy={busy} aria-disabled={disabled}
    data-office-cloud-upload onClick={() => { if (!disabled) onClick?.(); }}>
    <OfficeCloudUploadIcon busy={busy} />
  </Button>;
}
