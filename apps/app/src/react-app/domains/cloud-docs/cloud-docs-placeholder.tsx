import { LoaderCircle } from "lucide-react";
import { t } from "@/i18n";

/** 截图不可用时为宿主浮层保留明确的文档背景；原生实例继续保留和保存。 */
export function CloudDocsPlaceholder() {
  return <div
    aria-hidden="true"
    data-cloud-docs-placeholder
    className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
  >
    <LoaderCircle className="size-4 animate-spin" />
    {t("cloud_docs.title")}
  </div>;
}
