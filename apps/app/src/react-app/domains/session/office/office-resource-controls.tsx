import * as React from "react";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

/** 两种文件宿主共用字体偏好及实际请求失败提示，不把未使用的目录字体标为缺失。 */
export function OfficeResourceControls({ documentId }: { documentId: string }) {
  const native =
    typeof window !== "undefined"
      ? window.__JUGGLEWORK_ELECTRON__?.office
      : undefined;
  const [state, setState] = React.useState<{
    online: boolean;
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
  if (!state || !native?.setFontOnline) return null;
  const change = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
    } catch {
      toast.error(t("office.font_update_failed"));
    } finally {
      setBusy(false);
    }
  };
  const hint = state.readyOnReopen
    ? t("office.font_ready_reopen")
    : state.fontFailures
      ? t("office.font_unavailable")
      : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            title={hint ?? t("office.font_settings")}
            aria-label={t("office.font_settings")}
          />
        }
      >
        <Languages className="size-4" />
        {hint && (
          <span role="status" className="max-w-40 truncate">
            {hint}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={state.online}
          disabled={busy}
          onCheckedChange={(value) =>
            void change(() => native.setFontOnline!(value))
          }
        >
          {t("office.font_online")}
        </DropdownMenuCheckboxItem>
        {Boolean(state.retryableFonts) && native.retryFonts && (
          <DropdownMenuItem
            disabled={busy || !state.online}
            onClick={() => void change(() => native.retryFonts!(documentId))}
          >
            {t("office.font_retry")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
