import * as React from "react";
import {
  CircleCheck,
  Clock3,
  CloudUpload,
  ExternalLink,
  Eye,
  FolderOpen,
  Forward,
  LoaderCircle,
  MoreHorizontal,
  Save,
  SquareArrowOutUpRight,
  TriangleAlert,
} from "lucide-react";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export type FileEditorStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "loading"
  | "error"
  | "external"
  | "readonly";

/** 以模型生命周期优先确定保存状态，避免故障或导入中的文档被显示为已保存。 */
export function getOfficeEditorStatus(
  document: OfficeDocumentSession | undefined,
  saving = false,
): FileEditorStatus {
  if (document?.state === "error" || document?.state === "closed")
    return "error";
  if (document?.state === "external") return "external";
  if (saving || document?.state === "saving") return "saving";
  if (document?.state !== "ready") return "loading";
  return document.dirty ? "unsaved" : "saved";
}

const statusLabels = {
  readonly: "office.readonly",
  saved: "office.saved",
  unsaved: "office.unsaved",
  saving: "session_files.saving",
  loading: "office.loading",
  error: "office.open_failed",
  external: "artifact.external_active",
} as const;
const statusIcons = {
  readonly: Eye,
  saved: CircleCheck,
  unsaved: Clock3,
  saving: LoaderCircle,
  loading: LoaderCircle,
  error: TriangleAlert,
  external: ExternalLink,
};

/**
 * 文件编辑顶栏：两种宿主共用文件名、保存状态和操作布局，具体操作仍由原宿主管理。
 * @param props 文件状态、保存及文件操作；未接入的云端能力保持禁用
 */
export function FileEditorToolbar({
  name,
  status,
  saveDisabled,
  onSave,
  onReveal,
  onSaveCopy,
  onOpenWindow,
  showFolderShortcut = false,
  fileActionsDisabled = false,
  openWindowDisabled = fileActionsDisabled,
  children,
}: {
  name: string;
  status: FileEditorStatus;
  saveDisabled: boolean;
  onSave: () => void;
  onReveal?: () => void;
  onSaveCopy?: () => void;
  onOpenWindow?: () => void;
  showFolderShortcut?: boolean;
  fileActionsDisabled?: boolean;
  /** Office 开窗可以进入等待流程，其他需要保存的操作仍受任务运行限制。 */
  openWindowDisabled?: boolean;
  children?: React.ReactNode;
}) {
  const StatusIcon = statusIcons[status];
  const label = t(statusLabels[status]);
  return (
    <div
      data-file-editor-toolbar
      className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="truncate text-sm font-medium text-foreground"
          title={name}
        >
          {name}
        </span>
        {showFolderShortcut && onReveal && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={onReveal}
            title={t("artifact.open_folder")}
            aria-label={t("artifact.open_folder")}
          >
            <FolderOpen className="size-4" />
          </Button>
        )}
        <span
          role="status"
          aria-live="polite"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
          title={label}
        >
          <StatusIcon
            aria-hidden="true"
            className={`size-3.5 ${status === "saving" || status === "loading" ? "animate-spin" : ""}`}
          />
          {label}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {children}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={saveDisabled || status !== "unsaved"}
          onClick={onSave}
          title={t("session_files.save")}
          aria-label={t("session_files.save")}
        >
          <Save className="size-4" />
        </Button>
        <span title={t("artifact.upload_unavailable")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("artifact.upload")}
            disabled
          >
            <CloudUpload className="size-4" />
          </Button>
        </span>
        <span title={t("artifact.share_unavailable")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("artifact.share")}
            disabled
          >
            <Forward className="size-4" />
          </Button>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("file_window.more")}
                aria-label={t("file_window.more")}
                disabled={!onReveal && !onSaveCopy && !onOpenWindow}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {onOpenWindow && (
              <DropdownMenuItem
                disabled={openWindowDisabled}
                onClick={onOpenWindow}
              >
                <SquareArrowOutUpRight />
                {t("artifact.open_window")}
              </DropdownMenuItem>
            )}
            {onReveal && (
              <DropdownMenuItem onClick={onReveal}>
                <FolderOpen />
                {t("artifact.open_folder")}
              </DropdownMenuItem>
            )}
            {onSaveCopy && (
              <DropdownMenuItem
                disabled={fileActionsDisabled}
                onClick={onSaveCopy}
              >
                <Save />
                {t("artifact.save_copy")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
