/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import { Cpu, RefreshCw, Sparkles, Upload } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins";

type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: Array<{
    title: string;
    description: string;
    command?: string;
    url?: string;
    path?: string;
    note?: string;
  }>;
};

export type ExtensionsViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canManageLocalSkills: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore & {
    importLocalSkill: () => void | Promise<void>;
    saveSkill: (input: { name: string; content: string; description?: string }) => void | Promise<void>;
  };
  mcpConnectedAppsCount: number;
  /** The MCP view (quick-connect grid + configured servers). Skills are injected into it. */
  mcpView: ReactNode;
  /** Organization Marketplace packages, including workspace install and sync controls. */
  marketplaceView?: ReactNode;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "skills" | "plugins") => void;
  showHeader?: boolean;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillContent, setSkillContent] = useState("# When to use\n\nDescribe when this workspace-local Skill should be used.\n");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const pluginCount = useMemo(
    () => props.extensions.pluginList().length,
    [props.extensions],
  );

  const createLocalSkill = async () => {
    const name = skillName.trim();
    if (!name) {
      toast.error("A Skill name is required.");
      return;
    }
    setCreatingSkill(true);
    try {
      await props.extensions.saveSkill({
        name,
        description: skillDescription.trim() || undefined,
        content: skillContent,
      });
      toast.success("Local Skill created for this workspace.");
      setNewSkillOpen(false);
      setSkillName("");
      setSkillDescription("");
      setSkillContent("# When to use\n\nDescribe when this workspace-local Skill should be used.\n");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create the local Skill.");
    } finally {
      setCreatingSkill(false);
    }
  };

  return (
    <section className="w-full max-w-5xl space-y-5 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-dls-border bg-dls-surface px-4 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm text-dls-secondary">
            {t("extensions.inventory_description")}
          </p>
          {props.mcpConnectedAppsCount > 0 ? (
            <div className="mt-1 inline-flex w-fit items-center gap-2 rounded-full bg-green-3 px-3 py-1">
              <div className="size-2 rounded-full bg-green-9" />
              <span className="text-xs font-medium text-green-11">
                {t("extensions.app_count", { count: props.mcpConnectedAppsCount })}
              </span>
            </div>
          ) : null}
        </div>
        <Button variant="outline" disabled={props.busy} onClick={props.onRefresh}>
          <RefreshCw size={14} className={props.busy ? "animate-spin" : undefined} />
          {t("common.refresh")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-dls-text">{t("settings.tab_skills")}</div>
          <div className="mt-0.5 text-xs text-dls-secondary">
            {t("extensions_view.skill_workspace_only")}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={props.busy || !props.canManageLocalSkills}
            onClick={() => void props.extensions.importLocalSkill()}
          >
            <Upload size={14} />
            {t("skills.import_local_skill")}
          </Button>
          <Button
            variant="outline"
            disabled={props.busy || !props.canManageLocalSkills}
            onClick={() => setNewSkillOpen(true)}
          >
            <Sparkles size={14} />
            {t("skills.create_local_skill")}
          </Button>
        </div>
      </div>

      {/* Runtime extensions and organization-assigned capabilities share one inventory. */}
      <div className="min-w-0">{props.mcpView}</div>

      {props.marketplaceView ? <div className="min-w-0">{props.marketplaceView}</div> : null}

      {/* OpenCode plugins -- advanced, collapsed */}
      {pluginCount > 0 ? (
        <details className="group rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-dls-secondary transition-colors hover:text-dls-text">
            <Cpu size={14} />
            <span>{t("extensions_view.opencode_plugins")}</span>
            <span className="text-[11px] text-dls-secondary">({pluginCount})</span>
          </summary>
          <div className="mt-3">
            <PluginsView
              extensions={props.extensions}
              busy={props.busy}
              selectedWorkspaceRoot={props.selectedWorkspaceRoot}
              canEditPlugins={props.canEditPlugins}
              canUseGlobalScope={props.canUseGlobalScope}
              accessHint={props.accessHint}
              suggestedPlugins={props.suggestedPlugins}
            />
          </div>
        </details>
      ) : null}

      <Dialog open={newSkillOpen} onOpenChange={setNewSkillOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("skills.create_local_skill")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-dls-secondary">{t("extensions_view.skill_workspace_only")}</p>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              Name
              <input
                value={skillName}
                onChange={(event) => setSkillName(event.currentTarget.value)}
                placeholder="my-workspace-skill"
                className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              Description
              <input
                value={skillDescription}
                onChange={(event) => setSkillDescription(event.currentTarget.value)}
                placeholder={t("extensions_view.description_placeholder")}
                className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              Instructions
              <textarea
                value={skillContent}
                onChange={(event) => setSkillContent(event.currentTarget.value)}
                rows={9}
                className="resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={creatingSkill} onClick={() => setNewSkillOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={creatingSkill || !skillName.trim() || !skillContent.trim()} onClick={() => void createLocalSkill()}>
                {creatingSkill ? t("common.saving") : t("common.create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
