/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { PanelLeftIcon } from "lucide-react";

import { JuggleChatApp } from "@/react-app/domains/jugglechat/jugglechat-app";
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
  /** Opens the local/remote workspace chooser owned by the session shell. */
  onOpenCreateWorkspace: () => void;
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
      <button
        type="button"
        data-sidebar="trigger"
        data-slot="sidebar-trigger"
        className={`pointer-events-auto absolute top-[3px] z-[2000] inline-flex size-8 items-center justify-center rounded-full border-0 bg-transparent text-foreground hover:bg-black/5 dark:hover:bg-white/10 titlebar-no-drag ${chatSidebarOpen ? "left-[80px]" : "left-4 mac:left-[80px]"}`}
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleSidebar();
        }}
        aria-label={chatSidebarOpen ? "折叠左侧区域" : "展开左侧区域"}
        title={chatSidebarOpen ? "折叠左侧区域" : "展开左侧区域"}
        aria-expanded={chatSidebarOpen}
        data-testid="chat-sidebar-trigger"
      >
        <PanelLeftIcon className="pointer-events-none size-3.5" />
        <span className="sr-only">{chatSidebarOpen ? "折叠左侧区域" : "展开左侧区域"}</span>
      </button>
      <main className="relative min-h-0 min-w-0 flex-1 bg-background" style={chatLayoutStyle}>
        <JuggleChatApp
          sidebarOpen={chatSidebarOpen}
          sidebarResizing={leftSidebarResizing}
          onStartSidebarResize={startLeftSidebarResize}
        />
      </main>
    </div>
  );
}
