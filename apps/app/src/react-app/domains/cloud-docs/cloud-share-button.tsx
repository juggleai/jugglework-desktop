import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** 复制最近一次上传的云文档链接；不修改文档的成员和权限。 */
export function CloudShareButton({ disabled = false, onClick }: { disabled?: boolean; onClick: () => void }) {
  return <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" disabled={disabled}
    title={t("cloud_docs.copy_link")} aria-label={t("cloud_docs.copy_link")} onClick={onClick} data-cloud-share>
    <Share2 className="size-4" />
  </Button>;
}
