/** @jsxImportSource react */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlarmClock,
  Cloud,
  ContactRound,
  FolderOpen,
  FolderPlus,
  Globe,
  MessageSquare,
  Plus,
  Search,
  Settings,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { useBrandLogoUrl } from "@/react-app/domains/cloud/brand-theme";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useJuggleChatStore } from "@/react-app/domains/jugglechat/store";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { setTaskScope, useTaskScope } from "@/react-app/domains/session/sidebar/task-scope-store";
import { useLocalWorkspaceIndicator } from "@/react-app/domains/session/sidebar/workspace-indicator-store";
import { SessionCircularProgress } from "@/react-app/domains/session/sidebar/session-circular-progress";
import type { WorkspaceSessionIndicator } from "@/react-app/domains/session/sidebar/utils";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { APP_PRIMARY_RAIL_ORDER } from "./app-navigation-order";
import { LOCAL_AUTOMATION_ENABLED } from "@/react-app/domains/automations/automation-feature-flags";
import { visibleLocalWorkspaceIndicator } from "./app-navigation-status";

export { APP_PRIMARY_RAIL_ORDER } from "./app-navigation-order";

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
  /** Opens the requested workspace creation flow when the session shell owns it. */
  onOpenCreateWorkspace?: OpenCreateWorkspace;
};

type RailButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  testId?: string;
  badge?: number;
  badgeLabel?: string;
  badgeVariant?: "count" | "dot";
  statusIndicator?: WorkspaceSessionIndicator;
};

function RailButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
  testId,
  badge = 0,
  badgeLabel,
  badgeVariant = "count",
  statusIndicator = null,
}: RailButtonProps) {
  const resolvedBadgeLabel = badgeLabel ?? t("chat.unread_count", { count: badge });
  return (
    <button
      type="button"
      aria-label={badge > 0 ? `${label}, ${resolvedBadgeLabel}` : label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-2xl border border-transparent text-dls-secondary transition-colors mac:titlebar-no-drag [&>svg]:size-5 [&>svg]:stroke-[1.8]",
        "hover:border-dls-border hover:bg-background hover:text-dls-text",
        active && "border-dls-border bg-background text-dls-text shadow-sm",
        disabled && "cursor-default opacity-45 hover:border-transparent hover:bg-transparent hover:text-dls-secondary",
      )}
    >
      {children}
      {statusIndicator ? (
        <span
          className={cn(
            "absolute flex items-center justify-center",
            statusIndicator === "running" ? "right-0 top-0 size-4" : "right-0.5 top-0.5 size-2.5",
          )}
          title={statusIndicator === "running" ? t("workspace_list.session_streaming") : t("workspace_list.session_unread")}
          aria-label={statusIndicator === "running" ? t("workspace_list.session_streaming") : t("workspace_list.session_unread")}
        >
          {statusIndicator === "running" ? (
            <SessionCircularProgress />
          ) : (
            <span className="relative size-2.5 rounded-full bg-green-9" />
          )}
        </span>
      ) : null}
      {badge > 0 ? badgeVariant === "dot" ? (
        <span
          className="absolute right-0.5 top-0.5 size-2.5 rounded-full border-2 border-dls-sidebar bg-red-9"
          aria-hidden="true"
          data-rail-unread-dot
        />
      ) : (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-dls-sidebar bg-red-9 px-1 text-[10px] font-semibold leading-none text-white" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

export function AppNavigationRail(props: AppNavigationRailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useDenAuth();
  const brandLogoUrl = useBrandLogoUrl();
  const taskScope = useTaskScope();
  const localWorkspaceIndicator = useLocalWorkspaceIndicator();
  const chatView = useJuggleChatStore((state) => state.view);
  const totalUnreadCount = useJuggleChatStore((state) => state.totalUnreadCount);
  const notificationUnreadCount = useNotificationStore((state) => (
    state.notifications.reduce(
      (count, notification) => count + (notification.readAt === null ? 1 : 0),
      0,
    )
  ));
  const bootstrapChat = useJuggleChatStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrapChat(user);
  }, [bootstrapChat, user]);

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
      className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-dls-border bg-dls-sidebar px-2 pb-3 pt-3 mac:titlebar-drag mac:pt-11"
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

      <nav className="flex flex-col items-center gap-3" data-rail-order={APP_PRIMARY_RAIL_ORDER.join(",")}>
        {props.onOpenTaskSearch ? (
          <RailButton
            label={t("workspace_list.search_sessions")}
            onClick={props.onOpenTaskSearch}
            testId="app-rail-task-search"
          >
            <Search />
          </RailButton>
        ) : null}
        {props.onOpenCreateWorkspace ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <button
                  type="button"
                  aria-label={t("workspace.create_workspace")}
                  title={t("workspace.create_workspace")}
                  data-testid="app-rail-create-workspace"
                  className={cn(
                    "relative flex size-11 items-center justify-center rounded-2xl border border-transparent text-dls-secondary transition-colors mac:titlebar-no-drag",
                    "hover:border-dls-border hover:bg-background hover:text-dls-text",
                    "data-popup-open:border-dls-border data-popup-open:bg-background data-popup-open:text-dls-text data-popup-open:shadow-sm",
                    "[&>svg]:size-5 [&>svg]:stroke-[1.8]",
                  )}
                >
                  <Plus />
                </button>
              )}
            />
            <DropdownMenuContent
              side="right"
              align="start"
              sideOffset={8}
              className="workspace-create-menu w-[184px] rounded-2xl bg-popover/95 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.16)] ring-1 ring-foreground/10 backdrop-blur-xl"
            >
              <DropdownMenuItem
                onClick={() => props.onOpenCreateWorkspace?.("local")}
                className="min-h-10 gap-2.5 rounded-[10px] px-2.5 py-2 text-[14px] font-normal leading-5"
                data-testid="app-rail-create-local-workspace"
              >
                <FolderPlus className="size-[18px] stroke-[1.7] text-dls-secondary" />
                {t("navigation.local_workspace")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => props.onOpenCreateWorkspace?.("remote")}
                className="min-h-10 gap-2.5 rounded-[10px] px-2.5 py-2 text-[14px] font-normal leading-5"
                data-testid="app-rail-create-cloud-workspace"
              >
                <Globe className="size-[18px] stroke-[1.7] text-dls-secondary" />
                {t("navigation.cloud_workspace")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <RailButton
          label={t("navigation.local_workspace")}
          active={props.homeActive && taskScope === "local"}
          onClick={() => openTaskScope("local")}
          testId="app-rail-home"
          statusIndicator={visibleLocalWorkspaceIndicator(localWorkspaceIndicator, props.homeActive, taskScope)}
        >
          <FolderOpen className="size-5" strokeWidth={1.8} />
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
          <Cloud className="size-5" strokeWidth={1.8} />
        </RailButton>
        {LOCAL_AUTOMATION_ENABLED ? <RailButton
          label={t("navigation.automations")}
          active={location.pathname.startsWith("/automations")}
          onClick={() => navigate("/automations")}
          testId="app-rail-automations"
        >
          <AlarmClock />
        </RailButton> : null}
        <RailButton
          label={t("navigation.chat")}
          active={props.chatActive && chatView !== "contacts"}
          onClick={() => openChatView("conversations")}
          testId="app-rail-chat"
          badge={totalUnreadCount}
        >
          <MessageSquare />
        </RailButton>
        <RailButton
          label={t("navigation.contacts")}
          active={props.chatActive && chatView === "contacts"}
          onClick={() => openChatView("contacts")}
          testId="app-rail-contacts"
        >
          <ContactRound />
        </RailButton>
      </nav>

      <div className="mt-auto">
        <RailButton
          label={t("navigation.settings")}
          active={props.settingsActive}
          onClick={props.onOpenSettings}
          testId="app-rail-settings"
          badge={notificationUnreadCount}
          badgeLabel={`${t("notifications.title")} (${notificationUnreadCount})`}
          badgeVariant="dot"
        >
          <Settings />
        </RailButton>
      </div>
    </aside>
  );
}
