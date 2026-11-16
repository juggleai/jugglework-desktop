/** @jsxImportSource react */
import {
  CloudUpload,
  Copy,
  ExternalLink,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { canUploadToCloud } from "../../cloud-docs/upload-file";
import {
  useArtifactActions,
  type ArtifactAction,
} from "./artifact-actions-provider";

/**
 * 文件卡片和变更文件行共用的更多菜单，沿用已有动作与禁用规则。
 * @param props 文件路径、可用性、操作中状态、操作回调和按钮尺寸
 */
export function ArtifactFileMenu({
  path,
  available,
  busy,
  onAction,
  size = "icon-sm",
}: {
  path: string;
  available: boolean;
  busy: boolean;
  onAction: (action: ArtifactAction) => Promise<void>;
  size?: "icon-xs" | "icon-sm";
}) {
  const actions = useArtifactActions();
  const native = Boolean(actions?.desktop && available && !busy);
  const uploadSupported = canUploadToCloud(path);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={size}
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
          onClick={() => void onAction("reveal")}
        >
          <FolderOpen />
          {t("artifact.open_folder")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!native || actions?.running}
          onClick={() => void onAction("external")}
        >
          <ExternalLink />
          {t("artifact.open_external")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!actions || !available || busy || actions.running}
          onClick={() => void onAction("attach")}
        >
          <MessageSquarePlus />
          {t("artifact.add_to_chat")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!native}
          onClick={() => void onAction("copy-path")}
        >
          <Copy />
          {t("artifact.copy_path")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!native || actions?.running}
          onClick={() => void onAction("save-copy")}
        >
          <Save />
          {t("artifact.save_copy")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!native || actions?.running || !uploadSupported}
          title={
            !uploadSupported ? t("cloud_docs.upload_unsupported") : undefined
          }
          onClick={() => void onAction("upload-cloud")}
        >
          <CloudUpload />
          {t("artifact.upload")}
        </DropdownMenuItem>
        {!uploadSupported ? (
          <p className="max-w-64 px-2 py-1 text-xs text-dls-secondary">
            {t("cloud_docs.upload_unsupported")}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
