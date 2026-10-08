/** @jsxImportSource react */
import type { ComponentType, SVGProps } from "react";
import { Box, PlugZap } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { PluginOrbitIcon } from "@/react-app/design-system/plugin-orbit-icon";

export type CustomizationCatalogSection = "plugins" | "skills" | "connectors";

export type CustomizationInstalledItem = {
  id: string;
  name: string;
  section: CustomizationCatalogSection;
};

const CATALOG_SECTIONS: Array<{
  id: CustomizationCatalogSection;
  label: () => string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { id: "plugins", label: () => t("project_extensions.group_plugin"), icon: PluginOrbitIcon },
  { id: "skills", label: () => t("settings.tab_skills"), icon: Box },
  { id: "connectors", label: () => t("settings.tab_connectors"), icon: PlugZap },
];

function InstalledItemIcon({ section }: { section: CustomizationCatalogSection }) {
  if (section === "plugins") return <PluginOrbitIcon />;
  if (section === "skills") return <Box />;
  return <PlugZap />;
}

export function CustomizationCatalogSidebar(props: {
  activeSection: CustomizationCatalogSection;
  installedItems: CustomizationInstalledItem[];
  onSelectSection: (section: CustomizationCatalogSection) => void;
  onSelectInstalledItem: (item: CustomizationInstalledItem) => void;
}) {
  return (
    <aside
      aria-label={t("customization.navigation_label")}
      className="flex h-full w-[216px] shrink-0 flex-col overflow-hidden border-r border-dls-border bg-dls-sidebar/55"
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
          {props.installedItems.length > 0 ? (
            <div className="space-y-0.5">
              {props.installedItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => props.onSelectInstalledItem(item)}
                  className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/30 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.8]"
                >
                  <InstalledItemIcon section={item.section} />
                  <span className="truncate">{item.name}</span>
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
