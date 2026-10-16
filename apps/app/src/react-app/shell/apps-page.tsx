/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { AppNavigationRail } from "./app-navigation-rail";
import { AppInsetSurface } from "./app-inset-surface";
import { AppSecondarySidebarResizeHandle } from "./app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "./app-secondary-sidebar-top-controls";
import { SettingsRoute } from "./settings-route";
import { useUiStateStore } from "./ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "./workspace-shell-layout";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";

export type AppsPageProps = {
  workspaceId?: string | null;
  /** 应用页当前是否可见；隐藏时内嵌设置面的模型选择器不响应全局打开事件。 */
  active?: boolean;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenToonFactory: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog owned by the session shell. */
  onOpenTaskSearch: () => void;
  /** Opens the requested workspace creation flow owned by the session shell. */
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

export function AppsPage(props: AppsPageProps) {
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = {
    "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth),
  } as CSSProperties;
  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle}>
      <AppNavigationRail
        appsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={() => undefined}
        onOpenChat={props.onOpenChat}
        onOpenReviews={props.onOpenReviews}
        onOpenToonFactory={props.onOpenToonFactory}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <AppSecondarySidebarTopControls
        sidebarOpen={sidebarOpen}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onToggleSidebar={toggleSidebar}
      />
      <AppInsetSurface className="relative" testId="plugins-inset-surface">
        <SettingsRoute
          embedded
          contentOnly
          pluginCatalogOnly
          initialPath="extensions/plugins"
          workspaceId={props.workspaceId ?? undefined}
          active={props.active}
          secondarySidebarOpen={sidebarOpen}
        />
        {sidebarOpen ? (
          <AppSecondarySidebarResizeHandle
            resizing={leftSidebarResizing}
            onPointerDown={startLeftSidebarResize}
          />
        ) : null}
      </AppInsetSurface>
    </div>
  );
}
