/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ConnectorPickerModal } from "./connector-picker-modal";
import { SkillsManagerModal } from "./skills-manager-modal";
import { PluginsModal } from "./plugins-modal";
import { InstructionsModal } from "./instructions-modal";
import type { ProjectExtensionsPanelProps } from "./types";

type ActiveModal = "instructions" | "connector" | "skill" | "plugin" | null;

/** 分组卡片外壳 */
function GroupCard({ title, description, count, disabled, onAdd, children }: {
  title: string;
  description?: string;
  count?: number;
  disabled?: boolean;
  onAdd?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-dls-border bg-dls-surface px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-dls-text">{title}</h3>
            {typeof count === "number" ? (
              <span className="text-sm text-dls-secondary tabular-nums">{count}</span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 text-sm text-dls-secondary">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onAdd}
          aria-label={t("project_extensions.add")}
          className={cn(
            "shrink-0 rounded-lg p-1.5 text-dls-secondary transition-colors",
            disabled ? "cursor-not-allowed opacity-40" : "hover:bg-dls-bg hover:text-dls-text",
          )}
        >
          <Plus className="size-5" />
        </button>
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

/**
 * 会话右侧设置分组卡片面板：只展示当前可配置的指令、连接器和技能。
 */
export function ProjectExtensionsPanel(props: ProjectExtensionsPanelProps) {
  const [modal, setModal] = useState<ActiveModal>(null);

  const connectedCount = useMemo(
    () => props.connectors.filter((row) => row.connected).length,
    [props.connectors],
  );
  const visibleSkillCount = props.installedSkills.length;
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto px-3 py-3">
      <GroupCard
        title={t("project_extensions.group_instruction")}
        description={t("project_extensions.instruction_card_desc")}
        onAdd={() => setModal("instructions")}
      />

      <GroupCard
        title={t("project_extensions.group_connector")}
        description={t("project_extensions.connector_card_desc")}
        count={connectedCount || undefined}
        onAdd={() => setModal("connector")}
      />

      <GroupCard
        title={t("project_extensions.group_skill")}
        description={t("project_extensions.skill_card_desc")}
        count={visibleSkillCount || undefined}
        onAdd={() => setModal("skill")}
      />

      <GroupCard
        title={t("project_extensions.group_plugin")}
        description={t("project_extensions.plugin_card_desc")}
        count={props.installedMarketplacePluginCount || undefined}
        onAdd={() => setModal("plugin")}
      />

      <InstructionsModal
        open={modal === "instructions"}
        projectDir={props.projectDir}
        onClose={() => setModal(null)}
      />
      <ConnectorPickerModal
        open={modal === "connector"}
        connectors={props.connectors}
        error={props.connectorError}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
        onAddCustomMcp={props.onAddCustomMcp}
        configSlotForEntry={props.configSlotForConnector}
        onClose={() => setModal(null)}
      />
      <SkillsManagerModal
        open={modal === "skill"}
        projectDir={props.projectDir}
        skills={props.installedSkills}
        onClose={() => setModal(null)}
        onUninstall={props.onUninstallSkill}
        onUpload={props.onUploadSkill}
        onRefresh={props.onRefreshSkills}
      />
      <PluginsModal
        open={modal === "plugin"}
        contentSlot={props.pluginsSlot}
        onClose={() => setModal(null)}
        onRefresh={props.onRefreshPlugins}
      />
    </div>
  );
}
