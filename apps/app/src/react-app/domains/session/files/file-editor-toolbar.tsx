import * as React from "react";
import {
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Save,
  SquareArrowOutUpRight,
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
import { OfficeResourceControls } from "../office/office-resource-controls";

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
  external: "artifact.external_active",
} as const;

/**
 * 文件编辑顶栏：两种宿主共用文件名、保存状态和操作布局，具体操作仍由原宿主管理。
 * @param props 文件状态、保存及文件操作；trailingActions 为更多菜单右侧的宿主操作
 */
export function FileEditorToolbar({
  name,
  status,
  saveDisabled,
  onSave,
  onReveal,
  onSaveCopy,
  onOpenWindow,
  onUploadCloud,
  showFolderShortcut = false,
  fileActionsDisabled = false,
  openWindowDisabled = fileActionsDisabled,
  officeDocumentId,
  children,
  trailingActions,
}: {
  name: string;
  status: FileEditorStatus;
  saveDisabled: boolean;
  onSave: () => void;
  onReveal?: () => void;
  onSaveCopy?: () => void;
  onOpenWindow?: () => void;
  /** 一次性上传为云文档。 */
  onUploadCloud?: () => void;
  showFolderShortcut?: boolean;
  fileActionsDisabled?: boolean;
  /** Office 开窗可以进入等待流程，其他需要保存的操作仍受任务运行限制。 */
  openWindowDisabled?: boolean;
  officeDocumentId?: string;
  children?: React.ReactNode;
  trailingActions?: React.ReactNode;
}) {
  // TIPS：失败原因由内容区统一展示，顶栏保留内部状态用于禁用保存，不重复显示通用失败文案。
  const label = status === "error" ? null : t(statusLabels[status]);
  // TIPS: 不使用原生 disabled，确保已保存时仍可悬浮查看状态；点击保护保留在操作边界。
  const saveLabel = label ? `${t("session_files.save")} · ${label}` : t("session_files.save");
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
      </div>
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {children}
        {officeDocumentId && (
          <OfficeResourceControls documentId={officeDocumentId} />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-disabled={saveDisabled || status !== "unsaved"}
          onClick={() => { if (!saveDisabled && status === "unsaved") onSave(); }}
          title={saveLabel}
          aria-label={t("session_files.save")}
          data-save-status={status}
          className={saveDisabled || status !== "unsaved" ? "opacity-50" : undefined}
        >
          {status === "saving" || status === "loading" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("file_window.more")}
                aria-label={t("file_window.more")}
                disabled={!onReveal && !onSaveCopy && !onOpenWindow && !onUploadCloud}
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
            {onUploadCloud && (
              <DropdownMenuItem disabled={fileActionsDisabled} onClick={onUploadCloud}>
                <Save />
                {t("cloud_docs.upload")}
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
        {trailingActions}
      </div>
    </div>
  );
}
