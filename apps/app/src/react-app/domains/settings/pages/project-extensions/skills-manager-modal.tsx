/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { CheckSquare, Loader2, Search, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import type { SkillItem } from "../mcp-view";
import { SkillAvatar } from "./skill-avatar";
import { SkillHubModal } from "./skill-hub-modal";
import { SkillDetailModal } from "./skill-detail-modal";
import { SkillAddMenu } from "./skill-add-menu";
import type { WorkspaceSkillPolicy } from "./types";

function SkillCard({ skill, workspaceSkillPolicy, onUninstall, onOpen }: {
  skill: SkillItem;
  workspaceSkillPolicy?: WorkspaceSkillPolicy;
  onUninstall: (skill: SkillItem) => void;
  onOpen: (skill: SkillItem) => void;
}) {
  const isGlobal = skill.scope === "global";
  const disabledHere = workspaceSkillPolicy?.disabledSkillNames.includes(skill.name) ?? false;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(skill); } }}
      className={cn(
        "group flex cursor-pointer gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 text-left transition-colors hover:border-dls-border-hover",
        disabledHere && "bg-dls-bg/50",
      )}
    >
      <SkillAvatar name={skill.name} sizeClass="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-dls-text">{skill.name}</p>
          {/* TIPS: 列表混排全局与本工作区技能，用标签区分来源与可管理性（全局只读）。 */}
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px]",
              isGlobal ? "bg-dls-bg text-dls-secondary" : "bg-green-3 text-green-11",
            )}
          >
            {t(isGlobal ? "project_extensions.scope_global" : "project_extensions.scope_workspace")}
          </span>
          {disabledHere ? (
            <span className="shrink-0 rounded-full bg-dls-bg px-1.5 py-0.5 text-[10px] text-dls-secondary">
              {t("connect.workspace_disabled_here")}
            </span>
          ) : null}
        </div>
        {skill.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{skill.description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        {workspaceSkillPolicy?.available ? (
          <div className="flex items-center gap-1.5">
            {workspaceSkillPolicy.savingName === skill.name ? <Loader2 className="size-3.5 animate-spin text-dls-secondary" /> : null}
            <Switch
              size="sm"
              checked={!disabledHere}
              disabled={workspaceSkillPolicy.savingName === skill.name}
              onCheckedChange={(enabled) => void workspaceSkillPolicy.setSkillEnabled(skill.name, enabled)}
              aria-label={t("connect.workspace_toggle_label", { name: skill.name })}
            />
          </div>
        ) : null}
        {/* Global skills can be disabled here, but can only be uninstalled in global settings. */}
        {!isGlobal ? (
          <button
            type="button"
            onClick={() => onUninstall(skill)}
            className="rounded-md p-1 text-dls-secondary transition-colors hover:text-destructive"
            aria-label={t("project_extensions.uninstall")}
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 技能管理弹窗：展示本地已安装技能，卡片上用标签区分本工作区与全局；
 * 本工作区技能可卸载；全局技能不可卸载，但两者都可在当前工作区关闭。
 * 标题行提供搜索、恒为选中态的「我安装的」与「添加技能」入口。
 * @param open 是否打开
 * @param projectDir 项目根目录
 * @param skills 已安装技能（本工作区 + 全局）
 * @param workspaceSkillPolicy 当前工作区技能可用性策略
 * @param onClose 关闭回调
 * @param onUninstall 卸载本工作区技能
 * @param onUpload 从本地上传技能
 * @param onRefresh 刷新技能列表
 */
export function SkillsManagerModal({ open, projectDir, skills, workspaceSkillPolicy, onClose, onUninstall, onUpload, onRefresh }: {
  open: boolean;
  projectDir: string;
  skills: SkillItem[];
  workspaceSkillPolicy?: WorkspaceSkillPolicy;
  onClose: () => void;
  onUninstall: (name: string) => void;
  onUpload: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  const [hubOpen, setHubOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<SkillItem | null>(null);
  const [query, setQuery] = useState("");

  // TIPS: 弹窗只呈现「我安装的」技能（本工作区 + 全局），因此该项恒为选中态，仅用搜索词过滤。
  const visibleSkills = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return skills;
    return skills.filter((skill) => (
      skill.name.toLowerCase().includes(keyword) ||
      (skill.description ?? "").toLowerCase().includes(keyword)
    ));
  }, [skills, query]);

  const installedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const skill of skills) set.add(skill.name.trim().toLowerCase());
    return set;
  }, [skills]);

  return (
    <>
      <Dialog
        open={open && !hubOpen && !detailSkill}
        onOpenChange={(next) => {
          if (next) return;
          setQuery("");
          onClose();
        }}
      >
        <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[1000px] flex-col sm:max-w-[1000px]">
          <DialogHeader className="space-y-0">
            {/* TIPS: 标题与搜索、筛选、添加同处一行，右侧留出关闭按钮的位置。 */}
            <div className="flex items-center gap-3 pr-8">
              <DialogTitle className="shrink-0">{t("project_extensions.group_skill")}</DialogTitle>
              <div className="relative w-56 shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t("project_extensions.search_skills")}
                  className="w-full rounded-lg border border-dls-border bg-dls-surface py-1.5 pl-8 pr-3 text-sm text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
                />
              </div>
              <Button type="button" variant="secondary" size="sm" aria-current="true">
                <CheckSquare className="size-4" />
                {t("project_extensions.my_installed")}
                <span className="text-dls-secondary tabular-nums">{skills.length}</span>
              </Button>
              <SkillAddMenu onUpload={onUpload} onOpenSkillHub={() => setHubOpen(true)} />
            </div>
          </DialogHeader>

          {workspaceSkillPolicy?.error ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {workspaceSkillPolicy.error}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {skills.length === 0 ? (
              <p className="py-10 text-center text-sm text-dls-secondary">
                {t("project_extensions.no_skills_installed")}
              </p>
            ) : visibleSkills.length === 0 ? (
              <p className="py-10 text-center text-sm text-dls-secondary">
                {t("project_extensions.no_skills_found")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {visibleSkills.map((skill) => (
                  <SkillCard
                    key={`${skill.scope ?? "project"}:${skill.name}`}
                    skill={skill}
                    workspaceSkillPolicy={workspaceSkillPolicy}
                    onUninstall={setUninstallTarget}
                    onOpen={setDetailSkill}
                  />
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

      <ConfirmModal
        open={Boolean(uninstallTarget)}
        title={t("skills.uninstall_title")}
        message={t("skills.uninstall_warning").replace("{name}", uninstallTarget?.name ?? "")}
        confirmLabel={t("skills.uninstall")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setUninstallTarget(null)}
        onConfirm={() => {
          const target = uninstallTarget;
          setUninstallTarget(null);
          if (target && target.scope !== "global") onUninstall(target.name);
        }}
      />
    </>
  );
}
