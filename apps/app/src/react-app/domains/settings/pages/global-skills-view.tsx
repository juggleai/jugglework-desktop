/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { SkillAvatar } from "./project-extensions/skill-avatar";
import { SkillDetailModal } from "./project-extensions/skill-detail-modal";
import { SkillAddMenu } from "./project-extensions/skill-add-menu";
import { SkillHubModal } from "./project-extensions/skill-hub-modal";
import type { SkillItem } from "./mcp-view";

export type GlobalSkillsViewProps = {
  busy: boolean;
  /** 只包含 scope 为 global 的技能。 */
  skills: SkillItem[];
  status?: string | null;
  error?: string | null;
  /** 正在删除的技能名，用于按条目隔离忙碌状态。 */
  deletingSkillName?: string | null;
  onDeleteSkill: (name: string) => void | Promise<void>;
  onUploadSkill: () => void | Promise<void>;
  onRefresh: () => void;
  /** 详情弹窗读取技能文件时使用的工作区根目录。 */
  projectDir: string;
};

export function GlobalSkillsView(props: GlobalSkillsViewProps) {
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillItem | null>(null);
  const [hubOpen, setHubOpen] = useState(false);
  const installedSlugs = useMemo(
    () => new Set(props.skills.map((skill) => skill.name.trim().toLowerCase())),
    [props.skills],
  );

  return (
    <>
      <LayoutStack>
        <LayoutSection>
          <LayoutSectionHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <LayoutSectionTitle>{t("settings.tab_skills")}</LayoutSectionTitle>
                <LayoutSectionDescription className="mt-1">
                  {t("global_skills.description")}
                </LayoutSectionDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" disabled={props.busy} onClick={props.onRefresh}>
                  <RefreshCw size={14} className={props.busy ? "animate-spin" : undefined} />
                  {t("common.refresh")}
                </Button>
                <SkillAddMenu
                  disabled={props.busy}
                  onUpload={props.onUploadSkill}
                  onOpenSkillHub={() => setHubOpen(true)}
                />
              </div>
            </div>
          </LayoutSectionHeader>

          {props.skills.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {props.skills.map((skill) => {
                const rowDeleting = props.deletingSkillName === skill.name;
                return (
                  <LayoutSectionItem
                    key={skill.path || skill.name}
                    className="flex-col items-stretch gap-3 rounded-2xl border border-dls-border px-4 py-3"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left hover:opacity-80"
                      onClick={() => setDetailSkill(skill)}
                    >
                      <SkillAvatar name={skill.name} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-dls-text">{skill.name}</div>
                        {skill.description ? (
                          <div className="truncate text-xs text-muted-foreground">{skill.description}</div>
                        ) : null}
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.path}</div>
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        disabled={props.busy}
                        onClick={() => setDetailSkill(skill)}
                      >
                        {t("settings.provider_view_details")}
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={props.busy || rowDeleting}
                        onClick={() => setDeleteTarget(skill)}
                      >
                        {rowDeleting ? t("providers.deleting") : t("skills.uninstall")}
                      </Button>
                    </div>
                  </LayoutSectionItem>
                );
              })}
            </div>
          ) : (
            <SettingsNotice>{props.status ?? t("skills.no_skills_found")}</SettingsNotice>
          )}

          {props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
        </LayoutSection>
      </LayoutStack>

      <SkillDetailModal
        open={Boolean(detailSkill)}
        skill={detailSkill}
        projectDir={props.projectDir}
        onClose={() => setDetailSkill(null)}
      />

      <SkillHubModal
        open={hubOpen}
        scope="global"
        installedSlugs={installedSlugs}
        onClose={() => setHubOpen(false)}
        onInstalled={props.onRefresh}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("skills.uninstall_title")}
        message={t("global_skills.uninstall_warning").replace("{name}", deleteTarget?.name ?? "")}
        confirmLabel={t("skills.uninstall")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void props.onDeleteSkill(target.name);
        }}
      />
    </>
  );
}
