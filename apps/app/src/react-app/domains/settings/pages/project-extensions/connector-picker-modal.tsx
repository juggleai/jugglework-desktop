/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, Plug2, Plus, Store } from "lucide-react";
import { ExtensionDetailModal } from "@/react-app/design-system/extension-detail-modal";
import { ExtensionMeshAvatar } from "@/react-app/design-system/extension-mesh-avatar";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";

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
import type { AddMcpInitialValue } from "@/react-app/domains/connections/modals/add-mcp-modal";
import { AddMcpModal } from "@/react-app/domains/connections/modals/add-mcp-modal";
import {
  isJuggleWorkExtensionHidden,
  setJuggleWorkExtensionHidden,
} from "@/react-app/domains/settings/extension-state";
import { explainConnectorErrorKey } from "./connectors-source";
import type { ConnectorRow } from "./types";

/** 连接器头像：品牌图标 → 服务域名 favicon → 名称哈希占位，与扩展卡片同一套解析规则。 */
function ConnectorIcon({ row }: { row: ConnectorRow }) {
  const iconUrl = resolveExtensionIconUrl({
    iconSrc: row.iconSrc,
    iconSlug: row.iconSlug,
    serviceUrl: row.url,
  });
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dls-border bg-dls-bg text-dls-secondary">
      {iconUrl ? (
        <span className="flex size-6 items-center justify-center rounded-md bg-white">
          <img src={iconUrl} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
        </span>
      ) : row.name ? (
        <ExtensionMeshAvatar name={row.name} category="mcp" className="size-6 rounded-md" />
      ) : (
        <Plug2 className="size-4" />
      )}
    </span>
  );
}

function ConnectorItem({ row, onOpenDetail }: { row: ConnectorRow; onOpenDetail: (row: ConnectorRow) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(row)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenDetail(row);
      }}
      className="flex cursor-pointer items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2.5 transition-colors hover:border-dls-border-hover hover:bg-dls-hover"
    >
      <ConnectorIcon row={row} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-dls-text">{row.name}</p>
        {/* TIPS: 失败原文优先于描述——服务器自述的缺参数原因才是用户此刻需要的信息。 */}
        {row.errorDetail ? (
          <p className="truncate text-xs text-red-11" title={row.errorDetail}>{row.errorDetail}</p>
        ) : row.description ? (
          <p className="truncate text-xs text-dls-secondary">{row.description}</p>
        ) : null}
      </div>
      {/* TIPS: 行本身可点开详情，行内按钮需阻止冒泡，否则点「连接」会同时弹出详情。 */}
      <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
      {!row.connected && row.disabled ? (
        <span className="mr-2 inline-flex items-center rounded-full bg-dls-bg px-2 py-0.5 text-xs text-dls-secondary">
          {t("project_extensions.disabled_badge")}
        </span>
      ) : null}
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
              {row.disconnectKind === "disable"
                ? t("project_extensions.disable")
                : t("project_extensions.disconnect")}
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
          {row.disabled ? t("project_extensions.enable") : t("project_extensions.connect")}
        </Button>
      )}
      </div>
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
export function ConnectorPickerModal({ open, connectors, error, busy, isRemoteWorkspace, onAddCustomMcp, configSlotForEntry, onClose }: {
  open: boolean;
  connectors: ConnectorRow[];
  error?: string | null;
  busy?: boolean;
  isRemoteWorkspace?: boolean;
  onAddCustomMcp?: (entry: McpDirectoryInfo) => void | Promise<void>;
  configSlotForEntry?: (entry: McpDirectoryInfo) => ReactNode | null;
  onClose: () => void;
}) {
  const [addCustomOpen, setAddCustomOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const { connected, unconnected } = useMemo(() => {
    const connectedRows = connectors.filter((row) => row.connected);
    const unconnectedRows = connectors.filter((row) => !row.connected);
    return { connected: connectedRows, unconnected: unconnectedRows };
  }, [connectors]);

  // TIPS: 详情按 key 回查而非存快照，连接/断开后状态才会实时反映到已打开的详情里。
  const detailRow = useMemo(
    () => connectors.find((row) => row.key === detailKey) ?? null,
    [connectors, detailKey],
  );

  // TIPS: 编辑对象同样按 key 回查，配置保存后回填的是最新值而非打开弹窗那一刻的快照。
  const editingRow = useMemo(
    () => connectors.find((row) => row.key === editingKey) ?? null,
    [connectors, editingKey],
  );

  const editingInitial = useMemo((): AddMcpInitialValue | undefined => {
    if (!editingRow?.serverName || !editingRow.serverConfig) return undefined;
    const config = editingRow.serverConfig;
    return {
      serverName: editingRow.serverName,
      type: config.type,
      url: config.url,
      command: config.command,
      environment: config.environment,
      headers: config.headers,
      cwd: config.cwd,
      timeout: config.timeout,
    };
  }, [editingRow]);

  return (
    <>
      <Dialog open={open && !addCustomOpen && !detailRow && !editingRow} onOpenChange={(next) => { if (!next) onClose(); }}>
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
              onOpenDetail={(row) => setDetailKey(row.key)}
            />
            <ConnectorGroup
              title={t("project_extensions.unconnected_group")}
              count={unconnected.length}
              rows={unconnected}
              emptyLabel={t("project_extensions.no_unconnected")}
              onOpenDetail={(row) => setDetailKey(row.key)}
            />
          </div>
        </DialogContent>
      </Dialog>

      <AddMcpModal
        open={open && addCustomOpen}
        busy={Boolean(busy)}
        isRemoteWorkspace={Boolean(isRemoteWorkspace)}
        onAdd={(entry) => onAddCustomMcp?.(entry)}
        onClose={() => setAddCustomOpen(false)}
      />

      {editingInitial ? (
        <AddMcpModal
          open={open && Boolean(editingRow)}
          busy={Boolean(busy)}
          isRemoteWorkspace={Boolean(isRemoteWorkspace)}
          initial={editingInitial}
          onAdd={(entry) => onAddCustomMcp?.(entry)}
          onClose={() => setEditingKey(null)}
        />
      ) : null}

      {open && detailRow ? (
        <ConnectorDetailModal
          row={detailRow}
          configSlotForEntry={configSlotForEntry}
          onEdit={detailRow.serverConfig ? () => {
            setEditingKey(detailRow.key);
            setDetailKey(null);
          } : undefined}
          onClose={() => setDetailKey(null)}
        />
      ) : null}
    </>
  );
}

/**
 * 连接器详情：字段与扩展页 MCP 详情（`mcp-view` 的 ExtensionDetailModal）保持一致——
 * 安装说明、能力/贡献清单、「What this enables」、启动命令、服务地址、OAuth、隐藏开关。
 * 组织下发连接器没有目录项（无 manifest），此时只展示其自有信息。
 */
function ConnectorDetailModal({ row, configSlotForEntry, onEdit, onClose }: {
  row: ConnectorRow;
  configSlotForEntry?: (entry: McpDirectoryInfo) => ReactNode | null;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const entry = row.entry;
  const hidden = entry ? isJuggleWorkExtensionHidden(entry) : false;
  const configSlot = entry ? configSlotForEntry?.(entry) ?? null : null;

  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={row.name}
      description={row.description ?? entry?.description ?? t("project_extensions.connector_desc")}
      iconSlug={row.iconSlug}
      iconSrc={row.iconSrc}
      kind={entry?.kind ?? "mcp"}
      connected={row.connected}
      connecting={row.busy}
      preview={row.preview}
      hidden={hidden}
      url={row.url}
      oauth={entry?.oauth}
      launchCommand={row.command}
      errorDetail={row.errorDetail}
      errorHint={explainConnectorErrorKey(row.errorDetail)
        ? t(explainConnectorErrorKey(row.errorDetail)!)
        : undefined}
      onEdit={onEdit}
      editLabel={t("mcp.edit_server_button")}
      setupInstructions={entry?.extensionManifest?.setup?.instructions}
      resourceLabels={entry?.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? []}
      contributionLabels={entry?.extensionManifest?.contributions?.map(
        (contribution) => contribution.label ?? contribution.ref ?? contribution.type,
      ) ?? []}
      configSlot={configSlot}
      onConnect={configSlot ? undefined : row.onConnect}
      uninstallLabel={row.disconnectKind === "disable"
        ? t("project_extensions.disable")
        : t("project_extensions.disconnect")}
      onUninstall={row.onDisconnect}
      onRemove={row.onRemove}
      removeLabel={t("project_extensions.remove")}
      removeConfirmLabel={t("project_extensions.remove_confirm")}
      onHide={entry ? () => setJuggleWorkExtensionHidden(entry, true) : undefined}
      onShow={entry ? () => setJuggleWorkExtensionHidden(entry, false) : undefined}
    />
  );
}

function ConnectorGroup({ title, count, rows, emptyLabel, onOpenDetail }: {
  title: string;
  count: number;
  rows: ConnectorRow[];
  emptyLabel: string;
  onOpenDetail: (row: ConnectorRow) => void;
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
            <ConnectorItem key={row.key} row={row} onOpenDetail={onOpenDetail} />
          ))}
        </div>
      )}
    </section>
  );
}
