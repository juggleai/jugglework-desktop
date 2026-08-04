/** @jsxImportSource react */
import type { CSSProperties } from "react";

import { JuggleChatApp } from "@/react-app/domains/jugglechat/jugglechat-app";
import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  useUiStateStore,
} from "./ui-state-store";
import { APP_NAVIGATION_RAIL_WIDTH, AppNavigationRail } from "./app-navigation-rail";

export type ChatPageProps = {
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onToggleChat: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog owned by the session shell. */
  onOpenTaskSearch: () => void;
  /** Opens the local/remote workspace chooser owned by the session shell. */
  onOpenCreateWorkspace: () => void;
};

export function ChatPage(props: ChatPageProps) {
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const storedSidebarWidth = useUiStateStore((state) => state.workspaceLeftSidebarWidth);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const leftSidebarWidth = Math.min(
    MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    Math.max(
      MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
      storedSidebarWidth || DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    ),
  );
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
      <main className="relative min-h-0 min-w-0 flex-1 bg-white" style={chatLayoutStyle}>
        <JuggleChatApp sidebarOpen={chatSidebarOpen} onToggleSidebar={toggleSidebar} />
      </main>
    </div>
  );
}
