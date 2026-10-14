/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionItem,
  LayoutStack,
} from "../settings-layout";
import { SkillAvatar } from "./project-extensions/skill-avatar";
import { SkillDetailModal } from "./project-extensions/skill-detail-modal";
import { SkillAddMenu } from "./project-extensions/skill-add-menu";
import { SkillHubModal } from "./project-extensions/skill-hub-modal";
import type { SkillItem } from "./mcp-view";
import { CatalogHeader, type CatalogSource } from "./catalog-source";

export type GlobalSkillsViewProps = {
  source?: CatalogSource;
  onSourceChange?: (source: CatalogSource) => void;
  organizationName?: string | null;
  organizationSkills?: SkillItem[];
  orgSkillsLoading?: boolean;
  orgSkillsError?: string | null;
  busy: boolean;
  /** 只包含 scope 为 global 的技能。 */
  skills: SkillItem[];
  status?: string | null;
  error?: string | null;
  /** 正在删除的技能名，用于按条目隔离忙碌状态。 */
  deletingSkillName?: string | null;
  onDeleteSkill: (name: string) => void | Promise<void>;
  canAddSkills: boolean;
  /** false means cancelled/failed; only explicit success navigates to Personal. */
  onUploadSkill: () => boolean | void | Promise<boolean | void>;
  onRefreshPersonal?: () => void | Promise<void>;
  onRefresh: () => void;
  /** 详情弹窗读取技能文件时使用的工作区根目录。 */
  projectDir: string;
};

export function GlobalSkillsView(props: GlobalSkillsViewProps) {
  const [detailSelection, setDetailSelection] = useState<{ skill: SkillItem; source?: CatalogSource } | null>(null);
  const detailSkill = detailSelection?.source === props.source ? detailSelection?.skill ?? null : null;
  const [deleteTarget, setDeleteTarget] = useState<SkillItem | null>(null);
  const [hubOpen, setHubOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const navigation = useRef({ source: props.source, generation: 0, mounted: true });
  const hubGeneration = useRef(0);
  if (navigation.current.source !== props.source) {
    navigation.current.source = props.source;
    navigation.current.generation += 1;
  }
  useEffect(() => {
    navigation.current.mounted = true;
    return () => { navigation.current.mounted = false; navigation.current.generation += 1; };
  }, []);
  const upload = async () => {
    if (!props.canAddSkills) return;
    const generation = navigation.current.generation;
    setUploadError(null);
    try {
      const added = await props.onUploadSkill();
      if (added === true && navigation.current.mounted && generation === navigation.current.generation) {
        setSearch("");
        props.onSourceChange?.("personal");
      }
    } catch (error) {
      if (navigation.current.mounted && generation === navigation.current.generation) {
        setUploadError(error instanceof Error ? error.message : String(error));
      }
    }
  };
  const personal = !props.source || props.source === "personal";
  const organization = props.source === "organization";
  const busy = organization ? Boolean(props.orgSkillsLoading) : personal && props.busy;
  const error = organization ? props.orgSkillsError : personal ? props.error : null;
  const skills = organization ? props.organizationSkills ?? [] : personal ? props.skills : [];
  const query = search.trim().toLowerCase();
  const visibleSkills = skills.filter((skill) =>
    [skill.name, skill.description, skill.path].some((text) => text?.toLowerCase().includes(query)),
  );
  useEffect(() => {
    setDetailSelection(null);
    setDeleteTarget(null);
    setHubOpen(false);
    setUploadError(null);
  }, [props.source]);
  useEffect(() => {
    if (!props.canAddSkills) setHubOpen(false);
  }, [props.canAddSkills]);
  const installedSlugs = useMemo(
    () => new Set(props.skills.map((skill) => skill.name.trim().toLowerCase())),
    [props.skills],
  );

  return (
    <>
      <LayoutStack>
        <LayoutSection>
          <CatalogHeader
            title={t("settings.tab_skills")}
            description={t(props.source ? `customization.${props.source}_description` : "global_skills.description")}
            busy={busy}
            onRefresh={props.onRefresh}
            source={props.source}
            onSourceChange={props.onSourceChange}
            organizationName={props.organizationName}
            search={{ value: search, onChange: setSearch, placeholder: t("mcp.search_extensions_placeholder") }}
            actions={(
              <SkillAddMenu
                disabled={props.busy || !props.canAddSkills}
                onUpload={upload}
                onOpenSkillHub={() => { if (props.canAddSkills) { hubGeneration.current = navigation.current.generation; setHubOpen(true); } }}
              />
            )}
          />

          <div className="min-h-[20rem] space-y-4">
          {props.source === "public" ? (
            <SettingsNotice>{t("customization.public_skills_empty")}</SettingsNotice>
          ) : organization && busy ? (
            <SettingsNotice><span role="status">{t("common.loading")}</span></SettingsNotice>
          ) : visibleSkills.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleSkills.map((skill) => {
                const rowDeleting = props.deletingSkillName === skill.name;
                return (
                  <LayoutSectionItem
                    key={skill.path || skill.name}
                    className="group relative flex-col items-stretch gap-3 rounded-2xl border border-dls-border px-4 py-3"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg pr-7 text-left hover:opacity-80"
                      onClick={() => setDetailSelection({ skill, source: props.source })}
                    >
                      <SkillAvatar name={skill.name} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-dls-text">{skill.name}</div>
                        {skill.description ? (
                          <div className="truncate text-xs text-muted-foreground">{skill.description}</div>
                        ) : null}
                        {personal ? <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.path}</div> : null}
                      </div>
                    </button>
                    {personal ? <button
                      type="button"
                      disabled={props.busy || rowDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(skill);
                      }}
                      className="absolute right-2 top-2 rounded-md bg-dls-surface p-1 text-dls-secondary opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
                      aria-label={t("skills.uninstall")}
                    >
                      {rowDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </button> : null}
                  </LayoutSectionItem>
                );
              })}
            </div>
          ) : (
            !error ? <SettingsNotice>{query ? t("chat.no_search_results") : (personal ? props.status : null) ?? t("skills.no_skills_found")}</SettingsNotice> : null
          )}

          {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
          {uploadError ? <SettingsNotice tone="error">{uploadError}</SettingsNotice> : null}
          </div>
        </LayoutSection>
      </LayoutStack>

      <SkillDetailModal
        open={personal && Boolean(detailSkill)}
        skill={personal ? detailSkill : null}
        projectDir={props.projectDir}
        onClose={() => setDetailSelection(null)}
      />

      <Dialog open={organization && Boolean(detailSkill)} onOpenChange={(open) => { if (!open) setDetailSelection(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{detailSkill?.name}</DialogTitle></DialogHeader>
          {detailSkill?.description ? <p className="text-sm text-dls-secondary">{detailSkill.description}</p> : null}
          {detailSkill?.content ? <div className="whitespace-pre-wrap break-words text-sm text-dls-text">{detailSkill.content}</div> : null}
          <div className="flex justify-end"><Button variant="outline" onClick={() => setDetailSelection(null)}>{t("common.close")}</Button></div>
        </DialogContent>
      </Dialog>

      <SkillHubModal
        open={props.canAddSkills && hubOpen}
        scope="global"
        installedSlugs={installedSlugs}
        onClose={() => setHubOpen(false)}
        onInstalled={async (result) => {
          const generation = hubGeneration.current;
          await (props.onRefreshPersonal ?? props.onRefresh)();
          if (result && result.installedCount > 0 && result.failedCount === 0 && navigation.current.mounted && generation === navigation.current.generation) {
            setSearch("");
            props.onSourceChange?.("personal");
          }
        }}
      />

      <ConfirmModal
        open={personal && Boolean(deleteTarget)}
        title={t("skills.uninstall_title")}
        message={t("global_skills.uninstall_warning").replace("{name}", deleteTarget?.name ?? "")}
        confirmLabel={t("skills.uninstall")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (personal && target) void props.onDeleteSkill(target.name);
        }}
      />
    </>
  );
}
