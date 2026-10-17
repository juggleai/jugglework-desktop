/** @jsxImportSource react */
import * as React from "react";
import type { UIMessage } from "ai";
import type { TurnDelivery } from "@jugglework/types/file-artifacts";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import {
  CloudUpload,
  Copy,
  ExternalLink,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Save,
  Share2,
  SquareArrowOutUpRight,
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

/** 文件交付卡片：显示真实元信息，快捷操作与默认打开相互独立。 */
export function ArtifactCard({ artifact }: { artifact: ArtifactItem }) {
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

  return (
    <div
      data-testid="artifact-card"
      className="flex min-w-0 items-center gap-2 rounded-2xl bg-muted/70 p-3"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        disabled={!canOpen}
        onClick={() => previewArtifact(artifact)}
        title={artifact.name}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/80">
          <ArtifactIcon className="size-7" type={artifact.type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {artifact.name}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {artifact.legacy_target.exists === false
              ? t("artifact.file_missing")
              : size}
            {hasUpdate ? ` · ${t("artifact.file_updated")}` : null}
          </span>
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
                  !actions?.desktop ||
                  !actions.fileWindowAvailable ||
                  busy ||
                  (actions.running && !getOfficeDocumentKind(artifact.path)) ||
                  typeof window === "undefined" ||
                  !window.__JUGGLEWORK_ELECTRON__?.fileWindow ||
                  artifact.legacy_target.exists === false
                }
                onClick={() => void run("window")}
                aria-label={t("artifact.open_window")}
                title={
                  actions?.desktop && !actions.fileWindowAvailable
                    ? t("artifact.restart_desktop")
                    : t("artifact.open_window")
                }
              />
            }
          >
            <SquareArrowOutUpRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {actions?.desktop && !actions.fileWindowAvailable
              ? t("artifact.restart_desktop")
              : t("artifact.open_window")}
          </TooltipContent>
        </Tooltip>
        <span title={t("artifact.share_unavailable")}>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled
            aria-label={t("artifact.share")}
          >
            <Share2 className="size-4" />
          </Button>
        </span>
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

/** 当前轮次文件卡片列表；超过三项时通过同一数据源查看全部。 */
export function ArtifactCards({ artifacts }: { artifacts: ArtifactItem[] }) {
  const [showAll, setShowAll] = React.useState(false);
  if (!artifacts.length) return null;
  return (
    <div
      className="mx-auto mt-1 mb-1 w-full max-w-5xl px-3 md:px-8"
      data-testid="turn-artifacts"
    >
      <div className="flex min-w-0 flex-col gap-2">
        {artifacts.slice(0, 3).map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} />
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-0.5 h-7 px-0.5 py-0 text-muted-foreground"
        onClick={() => setShowAll(true)}
      >
        {t("artifact.view_all", { count: artifacts.length })} ›
      </Button>
      <Dialog open={showAll} onOpenChange={setShowAll}>
        <DialogContent className="max-w-xl">
          <DialogTitle>{t("artifact.turn_files")}</DialogTitle>
          <div className="subtle-scrollbar flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
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
