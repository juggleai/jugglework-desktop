/** @jsxImportSource react */
import type { CSSProperties } from "react";

import { JuggleChatApp } from "@/react-app/domains/jugglechat/jugglechat-app";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { useUiStateStore } from "./ui-state-store";
import { APP_NAVIGATION_RAIL_WIDTH, AppNavigationRail } from "./app-navigation-rail";
import { useWorkspaceShellLayout } from "./workspace-shell-layout";

export type ChatPageProps = {
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onToggleChat: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog owned by the session shell. */
  onOpenTaskSearch: () => void;
  /** Opens the requested workspace creation flow owned by the session shell. */
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

export function ChatPage(props: ChatPageProps) {
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({
    expandedRightWidth: 520,
  });
  const chatSidebarOpen = sidebarOpen;
  const chatLayoutStyle = {
    "--jugglework-left-sidebar-width": `${leftSidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-background">
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear"
        style={{ width: chatSidebarOpen ? APP_NAVIGATION_RAIL_WIDTH : 0 }}
      >
        <AppNavigationRail
          chatActive
          onOpenAccount={props.onOpenAccount}
          onOpenHome={props.onOpenHome}
          onOpenApps={props.onOpenApps}
          onOpenChat={props.onToggleChat}
          onOpenSettings={props.onOpenSettings}
          onOpenTaskSearch={props.onOpenTaskSearch}
          onOpenCreateWorkspace={props.onOpenCreateWorkspace}
        />
      </div>
      <main className="relative min-h-0 min-w-0 flex-1 bg-background" style={chatLayoutStyle}>
        <JuggleChatApp
          sidebarOpen={chatSidebarOpen}
          sidebarResizing={leftSidebarResizing}
          onStartSidebarResize={startLeftSidebarResize}
          onToggleSidebar={toggleSidebar}
        />
      </main>
    </div>
  );
}
