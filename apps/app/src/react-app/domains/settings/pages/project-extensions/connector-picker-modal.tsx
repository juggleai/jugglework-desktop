/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Plug2, Plus, Store } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import type { McpDirectoryInfo } from "@/app/constants";
import { AddMcpModal } from "@/react-app/domains/connections/modals/add-mcp-modal";
import type { ConnectorRow } from "./types";

function ConnectorItem({ row }: { row: ConnectorRow }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-bg text-dls-secondary">
        <Plug2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-dls-text">{row.name}</p>
        {row.description ? (
          <p className="truncate text-xs text-dls-secondary">{row.description}</p>
        ) : null}
      </div>
      {row.connected ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-green-3 px-2 py-0.5 text-xs text-green-11">
            <CheckCircle2 className="size-3" />
            {t("ext_card.connected")}
          </span>
          {row.onDisconnect ? (
            <Button
              variant="outline"
              size="sm"
              disabled={row.busy}
              onClick={row.onDisconnect}
              className="border-amber-6/60 bg-amber-2/50 text-amber-11 hover:border-amber-7 hover:bg-amber-3 hover:text-amber-11"
            >
              {row.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("project_extensions.disconnect")}
            </Button>
          ) : null}
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={row.busy || !row.onConnect}
          onClick={row.onConnect}
        >
          {row.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t("project_extensions.connect")}
        </Button>
      )}
    </div>
  );
}

/**
 * 连接器(MCP) 选择弹窗：按「已连接 / 未连接」两组展示汇总的连接器，
 * 右上角「+ 添加」提供自定义 MCP 入口。
 * @param open 是否打开
 * @param connectors 聚合后的连接器列表
 * @param error 连接/断开失败的提示文案
 * @param busy 连接动作是否进行中
 * @param isRemoteWorkspace 远程工作区（不支持本地命令型 MCP）
 * @param onAddCustomMcp 添加自定义 MCP
 * @param onClose 关闭回调
 */
export function ConnectorPickerModal({ open, connectors, error, busy, isRemoteWorkspace, onAddCustomMcp, onClose }: {
  open: boolean;
  connectors: ConnectorRow[];
  error?: string | null;
  busy?: boolean;
  isRemoteWorkspace?: boolean;
  onAddCustomMcp?: (entry: McpDirectoryInfo) => void | Promise<void>;
  onClose: () => void;
}) {
  const [addCustomOpen, setAddCustomOpen] = useState(false);

  const { connected, unconnected } = useMemo(() => {
    const connectedRows = connectors.filter((row) => row.connected);
    const unconnectedRows = connectors.filter((row) => !row.connected);
    return { connected: connectedRows, unconnected: unconnectedRows };
  }, [connectors]);

  return (
    <>
      <Dialog open={open && !addCustomOpen} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent className="max-w-[750px] sm:max-w-[750px]">
          <DialogHeader className="gap-2 space-y-0">
            <div className="flex items-center justify-between gap-4 pr-8">
              <DialogTitle>{t("project_extensions.group_connector")}</DialogTitle>
            </div>
            <div className="flex items-center justify-between gap-4">
              <DialogDescription>{t("project_extensions.connector_desc")}</DialogDescription>
              {onAddCustomMcp ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="sm">
                        <Plus className="size-4" />
                        {t("project_extensions.add")}
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem onClick={() => setAddCustomOpen(true)}>
                      <Plug2 className="size-4" />
                      <div>
                        <p className="text-sm">{t("project_extensions.custom_mcp")}</p>
                        <p className="text-xs text-dls-secondary">{t("project_extensions.custom_mcp_desc")}</p>
                      </div>
                    </DropdownMenuItem>
                    {/* TIPS: MCP 中心尚未实现，先占位置灰。 */}
                    <DropdownMenuItem disabled>
                      <Store className="size-4" />
                      <div>
                        <p className="text-sm">{t("project_extensions.from_mcp_hub")}</p>
                        <p className="text-xs text-dls-secondary">{t("project_extensions.from_mcp_hub_desc")}</p>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </DialogHeader>
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            <ConnectorGroup
              title={t("project_extensions.connected_group")}
              count={connected.length}
              rows={connected}
              emptyLabel={t("project_extensions.no_connected")}
            />
            <ConnectorGroup
              title={t("project_extensions.unconnected_group")}
              count={unconnected.length}
              rows={unconnected}
              emptyLabel={t("project_extensions.no_unconnected")}
            />
          </div>
        </DialogContent>
      </Dialog>

      <AddMcpModal
        open={open && addCustomOpen}
        busy={Boolean(busy)}
        isRemoteWorkspace={Boolean(isRemoteWorkspace)}
        onAdd={(entry) => { void onAddCustomMcp?.(entry); }}
        onClose={() => setAddCustomOpen(false)}
      />
    </>
  );
}

function ConnectorGroup({ title, count, rows, emptyLabel }: {
  title: string;
  count: number;
  rows: ConnectorRow[];
  emptyLabel: string;
}) {
  return (
    <section className="space-y-2">
      <div className={cn("flex items-center gap-2 text-xs font-medium text-dls-secondary")}>
        <span>{title}</span>
        <span className="rounded-full bg-dls-bg px-1.5 py-0.5 tabular-nums">{count}</span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-dls-border px-3 py-4 text-center text-xs text-dls-secondary">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <ConnectorItem key={row.key} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
