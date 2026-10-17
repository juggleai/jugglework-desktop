import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

/** 两种文件宿主共用实际字体失败提示及重试；字体自动补充，无需用户设置。 */
export function OfficeResourceControls({ documentId }: { documentId: string }) {
  const native =
    typeof window !== "undefined"
      ? window.__JUGGLEWORK_ELECTRON__?.office
      : undefined;
  const [state, setState] = React.useState<{
    fontFailures?: number;
    readyOnReopen?: boolean;
    retryableFonts?: number;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setState(null);
    const refresh = () =>
      void native
        ?.resources?.(documentId)
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => {});
    refresh();
    const stop = native?.onResourcesChanged?.((event) => {
      if (!event.documentId || event.documentId === documentId) refresh();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [native, documentId]);
  const hint = state?.readyOnReopen
    ? t("office.font_ready_reopen")
    : state?.fontFailures
      ? t("office.font_unavailable")
      : null;
  if (!hint) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await native?.retryFonts?.(documentId);
    } catch {
      toast.error(t("office.font_retry_failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-1 text-xs">
      <span role="status" title={hint} className="max-w-40 truncate">
        {hint}
      </span>
      {Boolean(state?.retryableFonts) &&
        !state?.readyOnReopen &&
        native?.retryFonts && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("office.font_retry")}
            aria-label={t("office.font_retry")}
            disabled={busy}
            onClick={() => void retry()}
          >
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
          </Button>
        )}
    </div>
  );
}
