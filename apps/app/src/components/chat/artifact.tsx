/** @jsxImportSource react */
import * as React from "react";
import type { UIMessage } from "ai";
import type { TurnDelivery } from "@jugglework/types/file-artifacts";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import {
  ChevronDown,
  CloudUpload,
  Copy,
  ExternalLink,
  FileDiff,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Save,
  Share2,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";

import { ArtifactIcon } from "@/components/chat/artifact-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type ArtifactItem,
  canDisplayArtifact,
  canOpenArtifact,
  useArtifacts,
  usePreviewArtifact,
} from "@/lib/artifacts";
import { formatFileSize } from "@/lib/utils";
import { t } from "@/i18n";
import { toast } from "sonner";
import {
  useArtifactActions,
  type ArtifactAction,
} from "@/react-app/domains/session/artifacts/artifact-actions-provider";

/** 紧凑文件行：显示真实元信息，快捷操作与默认打开相互独立。 */
export function ArtifactCard({ artifact, compact = false, onViewChange, onOpenInTab }: { artifact: ArtifactItem; compact?: boolean; onViewChange?: () => void; onOpenInTab?: () => void }) {
  const previewArtifact = usePreviewArtifact();
  const actions = useArtifactActions();
  const [busy, setBusy] = React.useState(false);
  const canOpen = canOpenArtifact(artifact);
  const native = Boolean(actions?.desktop && canOpen && !busy);
  const run = async (action: ArtifactAction) => {
    if (!actions || busy) return;
    setBusy(true);
    try {
      await actions.run(action, artifact);
    } finally {
      setBusy(false);
    }
  };
  const size =
    artifact.sizeBytes === undefined
      ? t("artifact.size_unknown")
      : formatFileSize(artifact.sizeBytes);
  const hasUpdate =
    artifact.legacy_target.reason === "turn-delivery" &&
    artifact.legacy_target.exists !== false &&
    ((artifact.updatedAt !== undefined &&
      artifact.legacy_target.updatedAt !== undefined &&
      artifact.updatedAt !== artifact.legacy_target.updatedAt) ||
      (artifact.sizeBytes !== undefined &&
        artifact.legacy_target.size !== undefined &&
        artifact.sizeBytes !== artifact.legacy_target.size) ||
      artifact.name !== artifact.legacy_target.name);

  const path = artifact.path.replace(/\\/g, "/").replace(/^\.\//, "");
  const separator = path.lastIndexOf("/");
  const directory = separator >= 0 ? path.slice(0, separator) : "";
  const filename = separator >= 0 ? path.slice(separator + 1) : path;

  return (
    <div
      data-testid="artifact-card"
      className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/40 sm:gap-2"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        disabled={!canOpen && !onViewChange}
        onClick={() => onViewChange ? onViewChange() : previewArtifact(artifact)}
        title={path}
      >
        {!compact ? <span className="flex size-5 shrink-0 items-center justify-center">
          <ArtifactIcon className="size-5" type={artifact.type} />
        </span> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex min-w-0 flex-1 items-center text-sm font-normal text-muted-foreground" data-testid="artifact-path">
            {directory ? <span
              className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl]"
              data-testid="artifact-path-directory"
            ><span className="[direction:ltr]">{directory}</span></span> : null}
            {directory ? <span className="shrink-0" data-testid="artifact-path-separator">/</span> : null}
            <span className="max-w-full shrink-0 truncate" data-testid="artifact-path-filename">{filename}</span>
          </span>
          {artifact.change ? <ChangeCounts change={artifact.change} /> : !compact ? <span className="block shrink-0 text-xs tabular-nums text-muted-foreground">
            {artifact.legacy_target.exists === false
              ? t("artifact.file_missing")
              : size}
            {hasUpdate ? ` · ${t("artifact.file_updated")}` : null}
          </span> : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={
                  artifact.legacy_target.exists === false ||
                  (!onOpenInTab && (
                    !actions?.desktop ||
                    !actions.fileWindowAvailable ||
                    busy ||
                    (actions.running && !getOfficeDocumentKind(artifact.path)) ||
                    typeof window === "undefined" ||
                    !window.__JUGGLEWORK_ELECTRON__?.fileWindow
                  ))
                }
                onClick={() => onOpenInTab ? onOpenInTab() : void run("window")}
                aria-label={t(onOpenInTab ? "artifact.open_tab" : "artifact.open_window")}
                title={
                  onOpenInTab
                    ? t("artifact.open_tab")
                    : actions?.desktop && !actions.fileWindowAvailable
                    ? t("artifact.restart_desktop")
                    : t("artifact.open_window")
                }
              />
            }
          >
            <SquareArrowOutUpRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {onOpenInTab
              ? t("artifact.open_tab")
              : actions?.desktop && !actions.fileWindowAvailable
              ? t("artifact.restart_desktop")
              : t("artifact.open_window")}
          </TooltipContent>
        </Tooltip>
        {!compact ? <span title={t("artifact.share_unavailable")}>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled
            aria-label={t("artifact.share")}
          >
            <Share2 className="size-4" />
          </Button>
        </span> : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("artifact.more")}
                title={t("artifact.more")}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              disabled={!native}
              onClick={() => void run("reveal")}
            >
              <FolderOpen />
              {t("artifact.open_folder")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!native || actions?.running}
              onClick={() => void run("external")}
            >
              <ExternalLink />
              {t("artifact.open_external")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!actions || !canOpen || busy || actions.running}
              onClick={() => void run("attach")}
            >
              <MessageSquarePlus />
              {t("artifact.add_to_chat")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!native}
              onClick={() => void run("copy-path")}
            >
              <Copy />
              {t("artifact.copy_path")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!native || actions?.running}
              onClick={() => void run("save-copy")}
            >
              <Save />
              {t("artifact.save_copy")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled title={t("artifact.upload_unavailable")}>
              <CloudUpload />
              {t("artifact.upload")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** 当前轮次统一产物卡片：前三项预览，其余原地展开，差异在右侧查看。 */
export function ChangeCounts({ change }: { change: { additions: number; deletions: number; source?: "snapshot" | "edits" } }) {
  return <span className="inline-flex shrink-0 gap-1 text-sm tabular-nums" data-testid="artifact-change-counts" title={t(change.source === "edits" ? "artifact.edit_counts" : "artifact.text_changes_only")}>
    <span className="text-green-11">+{change.additions}</span>
    <span className="text-red-11">-{change.deletions}</span>
  </span>;
}

export function ArtifactCards({ artifacts, turnId, onUndo }: { artifacts: ArtifactItem[]; turnId?: string; onUndo?: () => void }) {
  const actions = useArtifactActions();
  const [confirmUndo, setConfirmUndo] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const openChanges = (artifact?: ArtifactItem) => {
    actions?.openChanges(turnId ?? artifacts[0]?.messageId ?? "", artifacts, artifact?.path);
  };
  const changes = artifacts.flatMap((artifact) => artifact.change ? [artifact.change] : []);
  const totals = changes.reduce((sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }), { additions: 0, deletions: 0 });
  if (!artifacts.length) return null;
  return (
    <div
      className="mx-auto mt-1 mb-1 w-full max-w-5xl px-3 md:px-8"
      data-testid="turn-artifacts"
    >
      <section className="overflow-hidden rounded-2xl border border-border bg-background" aria-label={t("artifact.turn_files")} data-testid="artifact-summary">
        <header className="flex items-center gap-3 border-b border-border px-3 py-3 sm:px-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground" aria-hidden="true">
            <FileDiff className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t("artifact.summary_count", { count: artifacts.length })}</h3>
            {changes.length ? <div className="mt-0.5"><ChangeCounts change={{ ...totals, source: changes.some((change) => change.source === "edits") ? "edits" : "snapshot" }} /></div> : null}
          </div>
          {onUndo ? <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={() => setConfirmUndo(true)}>{t("artifact.undo")}<Undo2 className="size-4" /></Button> : null}
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 rounded-xl"
            aria-label={t("artifact.view_all", { count: artifacts.length })}
            disabled={!actions}
            onClick={() => openChanges()}
          >
            {t("artifact.view_changes")}
          </Button>
        </header>
        <div>
          <div id={listId} className="flex min-w-0 flex-col">
            {(expanded ? artifacts : artifacts.slice(0, 3)).map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} compact onViewChange={actions ? () => openChanges(artifact) : undefined} />
            ))}
          </div>
          {artifacts.length > 3 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-full justify-start gap-2 rounded-none px-3 text-sm font-medium"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t("artifact.show_less") : t("artifact.show_more", { count: artifacts.length - 3 })}
              <ChevronDown className={expanded ? "size-4 rotate-180" : "size-4"} />
            </Button>
          ) : null}
        </div>
      </section>
      <Dialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <DialogContent className="max-w-md">
          <DialogTitle>{t("artifact.undo")}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t("artifact.undo_warning")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmUndo(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => { setConfirmUndo(false); onUndo?.(); }}>{t("artifact.undo")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 单独显示文件交付进度及失败重试，不改变聊天的模型运行状态。 */
export function ArtifactDeliveryStatus({
  delivery,
  onRetry,
}: {
  delivery: TurnDelivery;
  onRetry: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  if (!delivery.targets.length || delivery.status === "ready") return null;
  const failed = delivery.status === "partial" || delivery.status === "failed";
  const retryable = delivery.targets.some(
    (target) => target.status === "failed" && target.retryable,
  );
  return (
    <div
      className="mx-auto mb-1 w-full max-w-5xl px-3 text-xs text-muted-foreground md:px-8"
      role="status"
    >
      <span>
        {t(failed ? "artifact.delivery_failed" : "artifact.finalizing")}
      </span>
      {failed && retryable ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1 h-7 px-1"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRetry();
            } catch {
              toast.error(t("artifact.operation_failed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("artifact.retry_confirmation")}
        </Button>
      ) : null}
    </div>
  );
}

/** 兼容已有调用方；只展示服务端已确认的当前消息范围交付文件。 */
export function ArtifactList({
  messages,
  includeTargetFallbacks = false,
}: {
  messages: UIMessage[];
  includeTargetFallbacks?: boolean;
}) {
  const artifacts = useArtifacts(messages, {
    includeTargetFallbacks,
    deliverablesOnly: true,
    stableOrder: true,
  });
  return <ArtifactCards artifacts={artifacts.filter(canDisplayArtifact)} />;
}
