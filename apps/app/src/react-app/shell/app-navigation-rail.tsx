/** @jsxImportSource react */
import {
  BookUser,
  FolderKanban,
  MessageCircleMore,
  Orbit,
  Plus,
  Search,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { useBrandLogoUrl } from "@/react-app/domains/cloud/brand-theme";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useJuggleChatStore } from "@/react-app/domains/jugglechat/store";
import { setTaskScope, useTaskScope } from "@/react-app/domains/session/sidebar/task-scope-store";

export const APP_NAVIGATION_RAIL_WIDTH = 72;

type AppNavigationRailProps = {
  /** Home surface is the visible one — its rail button reflects the task scope. */
  homeActive?: boolean;
  appsActive?: boolean;
  settingsActive?: boolean;
  chatActive?: boolean;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog when the session shell owns it. */
  onOpenTaskSearch?: () => void;
  /** Opens the local/remote workspace chooser when the session shell owns it. */
  onOpenCreateWorkspace?: () => void;
};

type RailButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  testId?: string;
};

function RailButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
  testId,
}: RailButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex size-11 items-center justify-center rounded-2xl border border-transparent text-dls-secondary transition-colors mac:titlebar-no-drag",
        "hover:border-dls-border hover:bg-background hover:text-dls-text",
        active && "border-dls-border bg-background text-dls-text shadow-sm",
        disabled && "cursor-default opacity-45 hover:border-transparent hover:bg-transparent hover:text-dls-secondary",
      )}
    >
      {children}
    </button>
  );
}

export function AppNavigationRail(props: AppNavigationRailProps) {
  const { user } = useDenAuth();
  const brandLogoUrl = useBrandLogoUrl();
  const taskScope = useTaskScope();
  const chatView = useJuggleChatStore((state) => state.view);

  /** Home lists local tasks, the cloud button lists remote ones — same surface. */
  const openTaskScope = (scope: "local" | "remote") => {
    setTaskScope(scope);
    props.onOpenHome();
  };
  const openChatView = (view: "conversations" | "contacts") => {
    useJuggleChatStore.getState().setView(view);
    if (!props.chatActive) props.onOpenChat();
  };
  const identity = user?.name?.trim() || user?.email?.trim() || "JuggleWork";
  const initial = identity.slice(0, 1).toLocaleUpperCase();

  return (
    <aside
      aria-label={t("navigation.primary")}
      className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-dls-border bg-dls-sidebar/75 px-2 pb-3 pt-3 mac:titlebar-drag mac:pt-11"
    >
      <button
        type="button"
        className="mb-7 flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-dls-border bg-background text-sm font-semibold text-dls-text shadow-sm transition-colors hover:bg-dls-hover mac:titlebar-no-drag"
        title={t("settings.tab_cloud_account")}
        aria-label={t("settings.tab_cloud_account")}
        onClick={props.onOpenAccount}
        data-testid="app-rail-account"
      >
        {brandLogoUrl ? (
          <img src={brandLogoUrl} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden="true">{initial}</span>
        )}
      </button>

      <nav className="flex flex-col items-center gap-3">
        {props.onOpenTaskSearch ? (
          <RailButton
            label={t("workspace_list.search_sessions")}
            onClick={props.onOpenTaskSearch}
            testId="app-rail-task-search"
          >
            <Search className="size-5" strokeWidth={1.8} />
          </RailButton>
        ) : null}
        {props.onOpenCreateWorkspace ? (
          <RailButton
            label={t("workspace.create_workspace")}
            onClick={props.onOpenCreateWorkspace}
            testId="app-rail-create-workspace"
          >
            <Plus className="size-5" strokeWidth={1.8} />
          </RailButton>
        ) : null}
        <RailButton
          label={t("navigation.local_workspace")}
          active={props.homeActive && taskScope === "local"}
          onClick={() => openTaskScope("local")}
          testId="app-rail-home"
        >
          <FolderKanban className="size-5" strokeWidth={1.8} />
        </RailButton>
        {/* <RailButton
          label={t("mcp.apps_title")}
          active={props.appsActive}
          onClick={props.onOpenApps}
          testId="app-rail-apps"
        >
          <AppWindowMac className="size-5" strokeWidth={1.8} />
        </RailButton> */}
        <RailButton
          label={t("navigation.cloud_workspace")}
          active={props.homeActive && taskScope === "remote"}
          onClick={() => openTaskScope("remote")}
          testId="app-rail-cloud-tasks"
        >
          <Orbit className="size-5" strokeWidth={1.8} />
        </RailButton>
        <RailButton
          label={t("navigation.chat")}
          active={props.chatActive && chatView !== "contacts"}
          onClick={() => openChatView("conversations")}
          testId="app-rail-chat"
        >
          <MessageCircleMore className="size-5" strokeWidth={1.8} />
        </RailButton>
        <RailButton
          label={t("navigation.contacts")}
          active={props.chatActive && chatView === "contacts"}
          onClick={() => openChatView("contacts")}
          testId="app-rail-contacts"
        >
          <BookUser className="size-5" strokeWidth={1.8} />
        </RailButton>
      </nav>

      <div className="mt-auto">
        <RailButton
          label={t("navigation.settings")}
          active={props.settingsActive}
          onClick={props.onOpenSettings}
          testId="app-rail-settings"
        >
          <Settings className="size-5" strokeWidth={1.8} />
        </RailButton>
      </div>
    </aside>
  );
}
