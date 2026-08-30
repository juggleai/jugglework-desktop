/** @jsxImportSource react */
import { Plus, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

/**
 * 技能添加菜单。
 *
 * @param disabled 是否禁用添加操作
 * @param onUpload 从本地目录导入技能
 * @param onOpenSkillHub 打开 SkillHub
 */
export function SkillAddMenu(props: {
  disabled?: boolean;
  onUpload: () => void | Promise<void>;
  onOpenSkillHub: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={props.disabled}>
            <Plus className="size-4" />
            {t("project_extensions.add_skill")}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => void props.onUpload()}>
          <Upload className="size-4" />
          <div>
            <p className="text-sm">{t("project_extensions.upload_skill")}</p>
            <p className="text-xs text-dls-secondary">{t("project_extensions.upload_skill_desc")}</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={props.onOpenSkillHub}>
          <Plus className="size-4" />
          <div>
            <p className="text-sm">{t("project_extensions.from_skill_hub")}</p>
            <p className="text-xs text-dls-secondary">{t("project_extensions.from_skill_hub_desc")}</p>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
