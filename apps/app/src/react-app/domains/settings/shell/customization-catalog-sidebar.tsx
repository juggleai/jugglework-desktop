/** @jsxImportSource react */
import type { ComponentType, SVGProps } from "react";
import { Box, PlugZap } from "lucide-react";

import type { DenOrgPlugin } from "@/app/lib/den";
import type { JuggleWorkHostMarketplaceInstallation } from "@/app/lib/jugglework-server";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { PluginOrbitIcon } from "@/react-app/design-system/plugin-orbit-icon";
import { SkillAvatar } from "../pages/project-extensions/skill-avatar";
import type { CatalogSource } from "../pages/catalog-source";

export type CustomizationCatalogSection = "plugins" | "skills" | "connectors";

export type CustomizationInstalledItem = {
  id: string;
  name: string;
  section: CustomizationCatalogSection;
  source?: CatalogSource;
  sourceLabel?: string;
  detailId?: string;
  iconSrc?: string;
  iconSlug?: string;
  url?: string;
};

export function globalCustomizationInstalledItems(input: {
  plugins: DenOrgPlugin[];
  skills: Array<{ name: string; path: string; ownerPluginId?: string; sourceKind?: "standalone" | "plugin" | "public" }>;
  connectors: Array<{ name: string; source?: CatalogSource; iconSrc?: string; iconSlug?: string; url?: string }>;
  localPlugins?: Array<{ id: string; name: string; source?: CatalogSource; iconSrc?: string; iconSlug?: string; url?: string }>;
  installedPluginIds?: string[];
  hostInstallations?: JuggleWorkHostMarketplaceInstallation[];
  organization?: { id: string; name: string; skills: Array<{ id?: string; name: string }>; connectors: Array<{ id: string; name: string; url?: string }> };
  includeOrganization?: boolean;
}): CustomizationInstalledItem[] {
  const installedPluginIds = new Set(input.installedPluginIds ?? []);
  const plugins = input.includeOrganization === false ? [] : input.hostInstallations ? input.hostInstallations.map((installation) => {
    const plugin = input.plugins.find((candidate) => candidate.id === installation.pluginId);
    const icon = plugin?.extension?.manifest?.icon;
    return {
      id: `cloud-plugin:${installation.pluginId}`,
      name: installation.name,
      section: "plugins" as const,
      source: "organization" as const,
      sourceLabel: input.organization?.name,
      ...(icon?.src ? { iconSrc: icon.src } : {}),
      ...(icon?.simpleIconSlug ? { iconSlug: icon.simpleIconSlug } : {}),
    };
  }) : input.plugins.flatMap((plugin) => {
    const installed = plugin.extension?.sourceFormat === "jugglework-builtin"
      || installedPluginIds.has(plugin.id);
    const icon = plugin.extension?.manifest?.icon;
    return installed ? [{
      id: `cloud-plugin:${plugin.id}`,
      name: plugin.name,
      section: "plugins" as const,
      source: "organization" as const,
      sourceLabel: input.organization?.name,
      ...(icon?.src ? { iconSrc: icon.src } : {}),
      ...(icon?.simpleIconSlug ? { iconSlug: icon.simpleIconSlug } : {}),
    }] : [];
  });
  return [
    ...plugins,
    ...(input.localPlugins ?? []).map((plugin) => ({ ...plugin, source: plugin.source ?? "personal" as const, section: "plugins" as const })),
    ...input.skills.filter((skill) => !skill.ownerPluginId).map((skill) => ({
      id: `global-skill:${skill.path || skill.name}`,
      name: skill.name,
      section: "skills" as const,
      source: skill.sourceKind === "public" ? "public" as const : "personal" as const,
    })),
    ...input.connectors.map((connector) => ({ id: `global-connector:${connector.name}`, ...connector, section: "connectors" as const, source: connector.source ?? "personal" as const })),
    ...(input.includeOrganization === false ? [] : (input.organization?.skills ?? []).map((skill) => ({ id: `org-skill:${input.organization!.id}:${skill.id ?? skill.name}`, detailId: skill.id ?? skill.name, name: skill.name, section: "skills" as const, source: "organization" as const, sourceLabel: input.organization!.name }))),
    ...(input.includeOrganization === false ? [] : (input.organization?.connectors ?? []).map((connector) => ({ id: `org-connector:${input.organization!.id}:${connector.id}`, detailId: connector.id, name: connector.name, section: "connectors" as const, source: "organization" as const, sourceLabel: input.organization!.name, ...(connector.url ? { url: connector.url } : {}) }))),
  ].filter((item) => item.name.trim()).sort((left, right) => left.name.localeCompare(right.name));
}

const CATALOG_SECTIONS: Array<{
  id: CustomizationCatalogSection;
  label: () => string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { id: "plugins", label: () => t("project_extensions.group_plugin"), icon: PluginOrbitIcon },
  { id: "skills", label: () => t("settings.tab_skills"), icon: Box },
  { id: "connectors", label: () => t("settings.tab_connectors"), icon: PlugZap },
];

function InstalledItemIcon({ item }: { item: CustomizationInstalledItem }) {
  if (item.section === "skills") return <SkillAvatar name={item.name} sizeClass="size-4" className="rounded" />;
  const iconUrl = resolveExtensionIconUrl({ iconSrc: item.iconSrc, iconSlug: item.iconSlug, serviceUrl: item.url });
  if (iconUrl) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-white">
        <img src={iconUrl} alt="" width={14} height={14} loading="lazy" className="block" />
      </span>
    );
  }
  if (item.section === "plugins") return <PluginOrbitIcon />;
  return <PlugZap />;
}

export function CustomizationCatalogSidebar(props: {
  activeSection: CustomizationCatalogSection;
  installedItems: CustomizationInstalledItem[];
  onSelectSection: (section: CustomizationCatalogSection) => void;
  onSelectInstalledItem: (item: CustomizationInstalledItem) => void;
}) {
  const visibleInstalledItems = props.installedItems.filter((item) => item.section === props.activeSection);
  return (
    <aside
      aria-label={t("customization.navigation_label")}
      className="flex h-full w-[var(--jugglework-left-sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-dls-border bg-dls-sidebar/55"
      data-testid="customization-catalog-sidebar"
    >
      <div className="shrink-0 px-4 pb-3 pt-5">
        <h1 className="text-[17px] font-semibold tracking-[-0.015em] text-dls-text">
          {t("customization.title")}
        </h1>
      </div>

      <nav className="space-y-0.5 px-2.5" aria-label={t("customization.catalog_label")}>
        {CATALOG_SECTIONS.map((entry) => {
          const Icon = entry.icon;
          const active = props.activeSection === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              data-testid={`customization-nav-${entry.id}`}
              data-active={active ? "true" : undefined}
              onClick={() => props.onSelectSection(entry.id)}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] font-medium text-dls-secondary transition-colors",
                "hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/30",
                active && "bg-dls-active text-dls-text",
              )}
            >
              <Icon className="size-[17px] shrink-0" strokeWidth={1.8} />
              <span className="truncate">{entry.label()}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-hidden">
        <div className="px-4 pb-2 text-[12px] font-medium text-dls-secondary/75">
          {t("customization.installed")}
        </div>
        <div className="h-full overflow-y-auto px-2.5 pb-5">
          {visibleInstalledItems.length > 0 ? (
            <div className="space-y-0.5">
              {visibleInstalledItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`customization-installed-${item.id}`}
                  onClick={() => props.onSelectInstalledItem(item)}
                  className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/30 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.8]"
                >
                  <InstalledItemIcon item={item} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.source ? <span title={item.sourceLabel || t(`customization.source_${item.source}`)} className="max-w-[5rem] shrink-0 truncate text-[10px] text-dls-secondary/70">{item.sourceLabel || t(`customization.source_${item.source}`)}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-2.5 py-1 text-[11px] leading-5 text-dls-secondary/65">
              {t("customization.installed_empty")}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
