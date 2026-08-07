/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import { Plus, Trash2, Upload } from "lucide-react";

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
import type { SkillItem } from "../mcp-view";
import { SkillAvatar } from "./skill-avatar";
import { SkillHubModal } from "./skill-hub-modal";
import { SkillDetailModal } from "./skill-detail-modal";

function SkillCard({ skill, onUninstall, onOpen }: {
  skill: SkillItem;
  onUninstall: (name: string) => void;
  onOpen: (skill: SkillItem) => void;
}) {
  const isGlobal = skill.scope === "global";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(skill); } }}
      className="group relative flex cursor-pointer gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 text-left transition-colors hover:border-dls-border-hover"
    >
      <SkillAvatar name={skill.name} sizeClass="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-dls-text">{skill.name}</p>
          {/* TIPS: 本地列表同时包含全局与本工作区技能，用标签区分来源与可管理性。 */}
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px]",
              isGlobal ? "bg-dls-bg text-dls-secondary" : "bg-green-3 text-green-11",
            )}
          >
            {t(isGlobal ? "project_extensions.scope_global" : "project_extensions.scope_workspace")}
          </span>
        </div>
        {skill.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{skill.description}</p>
        ) : null}
      </div>
      {!isGlobal ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onUninstall(skill.name); }}
          className="absolute right-2 top-2 rounded-md bg-dls-surface p-1 text-dls-secondary opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          aria-label={t("project_extensions.uninstall")}
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

type SkillsTab = "local" | "cloud";

/**
 * 技能管理弹窗：分「本地已安装 / 云端运行」两个页签。
 * 本地页展示项目已装技能网格，项目级技能可卸载；全局技能只读并标注「全局」，计数只统计项目级。
 * 云端页由宿主注入扩展市场视图（同一数据源与详情弹窗）。
 * @param open 是否打开
 * @param projectDir 项目根目录
 * @param skills 已安装技能（项目级 + 全局）
 * @param cloudSkillsSlot 云端运行页内容（扩展市场视图）
 * @param onClose 关闭回调
 * @param onUninstall 卸载项目级技能
 * @param onUpload 从本地上传技能
 * @param onRefresh 刷新技能列表
 */
export function SkillsManagerModal({ open, projectDir, skills, cloudSkillsSlot, onClose, onUninstall, onUpload, onRefresh }: {
  open: boolean;
  projectDir: string;
  skills: SkillItem[];
  cloudSkillsSlot?: ReactNode;
  onClose: () => void;
  onUninstall: (name: string) => void;
  onUpload: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  const [hubOpen, setHubOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [tab, setTab] = useState<SkillsTab>("local");

  const projectCount = useMemo(
    () => skills.filter((skill) => skill.scope !== "global").length,
    [skills],
  );

  const installedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const skill of skills) set.add(skill.name.trim().toLowerCase());
    return set;
  }, [skills]);

  return (
    <>
      <Dialog open={open && !hubOpen && !detailSkill} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[1150px] flex-col sm:max-w-[1150px]">
          <DialogHeader className="gap-2 space-y-0">
            <div className="flex items-center justify-between gap-4 pr-8">
              <DialogTitle>{t("project_extensions.group_skill")}</DialogTitle>
            </div>
            <div className="flex items-center justify-between gap-4">
              <DialogDescription>
                {t("project_extensions.skill_count", { count: projectCount })}
              </DialogDescription>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm">
                      <Plus className="size-4" />
                      {t("project_extensions.add")}
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => void onUpload()}>
                  <Upload className="size-4" />
                  <div>
                    <p className="text-sm">{t("project_extensions.upload_skill")}</p>
                    <p className="text-xs text-dls-secondary">{t("project_extensions.upload_skill_desc")}</p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHubOpen(true)}>
                  <Plus className="size-4" />
                  <div>
                    <p className="text-sm">{t("project_extensions.from_skill_hub")}</p>
                    <p className="text-xs text-dls-secondary">{t("project_extensions.from_skill_hub_desc")}</p>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
            <div className="flex items-center gap-1.5">
              {(["local", "cloud"] as SkillsTab[]).map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant={tab === key ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setTab(key)}
                >
                  {t(`project_extensions.tab_${key}_skills`)}
                </Button>
              ))}
            </div>
          </DialogHeader>

          <div className={cn("min-h-0 flex-1 overflow-y-auto")}>
            {tab === "cloud" ? (
              cloudSkillsSlot ?? (
                <p className="py-10 text-center text-sm text-dls-secondary">
                  {t("project_extensions.no_cloud_skills")}
                </p>
              )
            ) : skills.length === 0 ? (
              <p className="py-10 text-center text-sm text-dls-secondary">
                {t("project_extensions.no_skills_installed")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {skills.map((skill) => (
                  <SkillCard key={skill.name} skill={skill} onUninstall={onUninstall} onOpen={setDetailSkill} />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <SkillHubModal
        open={open && hubOpen}
        projectDir={projectDir}
        installedSlugs={installedSlugs}
        onClose={() => setHubOpen(false)}
        onInstalled={onRefresh}
      />

      <SkillDetailModal
        open={open && Boolean(detailSkill)}
        skill={detailSkill}
        projectDir={projectDir}
        onClose={() => setDetailSkill(null)}
      />
    </>
  );
}
