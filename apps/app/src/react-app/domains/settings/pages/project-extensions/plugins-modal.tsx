/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * 插件弹窗：展示云端市场下发的插件（SKILL、MCP、命令的集合）。
 * 标题行提供搜索与刷新，搜索词下发给内容区（宿主注入的市场视图）统一过滤。
 * @param open 是否打开
 * @param contentSlot 内容区渲染函数，入参为当前搜索词
 * @param onClose 关闭回调
 * @param onRefresh 刷新插件列表
 */
export function PluginsModal({ open, contentSlot, onClose, onRefresh }: {
  open: boolean;
  contentSlot?: (controls: { search: string }) => ReactNode;
  onClose: () => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setSearch("");
        onClose();
      }}
    >
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[1000px] flex-col sm:max-w-[1000px]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pr-8">
          <DialogTitle className="shrink-0">{t("project_extensions.group_plugin")}</DialogTitle>
          <div className="relative w-56 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t("project_extensions.search_plugins")}
              className="w-full rounded-lg border border-dls-border bg-dls-surface py-1.5 pl-8 pr-3 text-sm text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
            />
          </div>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
              aria-label={t("den.refresh")}
            >
              <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            </Button>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {contentSlot ? contentSlot({ search }) : (
            <p className="py-10 text-center text-sm text-dls-secondary">
              {t("project_extensions.no_plugins")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
