/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { PanelLeftIcon, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { APP_NAVIGATION_RAIL_WIDTH } from "./app-navigation-rail";
import { APP_INSET_SIDEBAR_OFFSET } from "./workspace-shell-layout";

const CONTROL_GROUP_WIDTH = 64;
// Match the collapsed local-workspace header: the work surface begins at 52px
// and its controls are inset another 24px into the header.
const COLLAPSED_CONTROL_LEFT = 76;

/**
 * Keeps the workspace search/collapse controls stable when moving between
 * workspace, Automation, Plugins, and Code Review surfaces.
 */
export function AppSecondarySidebarTopControls(props: {
  sidebarOpen: boolean;
  onOpenTaskSearch: () => void;
  onToggleSidebar: () => void;
}) {
  const expandedBoundary = `calc(${APP_NAVIGATION_RAIL_WIDTH + APP_INSET_SIDEBAR_OFFSET}px + var(--jugglework-left-sidebar-width))`;
  const controlStyle = {
    left: props.sidebarOpen
      ? `calc(${expandedBoundary} - ${CONTROL_GROUP_WIDTH}px)`
      : `${COLLAPSED_CONTROL_LEFT}px`,
    WebkitAppRegion: "no-drag",
  } as CSSProperties;

  return (
    <>
      <div
        className="pointer-events-auto absolute top-1.5 z-50 flex items-center gap-0 mac:titlebar-no-drag"
        style={controlStyle}
        data-app-secondary-sidebar-top-controls
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-events-auto rounded-xl text-dls-secondary hover:bg-dls-hover hover:text-dls-text mac:titlebar-no-drag"
          onClick={props.onOpenTaskSearch}
          title={t("workspace_list.search_sessions")}
          aria-label={t("workspace_list.search_sessions")}
          data-app-secondary-sidebar-search
        >
          <Search size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-events-auto border-none mac:titlebar-no-drag"
          onClick={props.onToggleSidebar}
          title={t(props.sidebarOpen ? "sidebar.collapse" : "sidebar.expand")}
          aria-label={t(props.sidebarOpen ? "sidebar.collapse" : "sidebar.expand")}
          aria-expanded={props.sidebarOpen}
          data-app-secondary-sidebar-toggle
        >
          <PanelLeftIcon className="size-3.5 rtl:rotate-180" />
        </Button>
      </div>
      {props.sidebarOpen ? <span
        aria-hidden="true"
        className="absolute top-2 z-40 block h-7 w-px bg-dls-border"
        style={{ left: expandedBoundary }}
        data-app-secondary-sidebar-top-divider
      /> : null}
    </>
  );
}
