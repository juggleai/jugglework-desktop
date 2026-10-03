/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlarmClock,
  ArrowUpRight,
  Check,
  Cloud,
  Coins,
  ContactRound,
  FolderOpen,
  FolderPlus,
  Globe,
  HelpCircle,
  LogOut,
  MessageSquare,
  Plus,
  GitPullRequestArrow,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { buildDenDashboardUrl, buildDenMembershipUpgradeUrl, readDenIMLoginBootstrap, readDenSettings } from "@/app/lib/den";
import { buildFeedbackUrl } from "@/app/lib/feedback";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useJuggleChatStore } from "@/react-app/domains/jugglechat/store";
import { useUpdateCheckRequestStore } from "@/react-app/domains/settings/state/update-check-request";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { setTaskScope, useTaskScope } from "@/react-app/domains/session/sidebar/task-scope-store";
import { useLocalWorkspaceIndicator } from "@/react-app/domains/session/sidebar/workspace-indicator-store";
import { SessionCircularProgress } from "@/react-app/domains/session/sidebar/session-circular-progress";
import type { WorkspaceSessionIndicator } from "@/react-app/domains/session/sidebar/utils";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { APP_PRIMARY_RAIL_ORDER } from "./app-navigation-order";
import { LOCAL_AUTOMATION_ENABLED } from "@/react-app/domains/automations/automation-feature-flags";
import { isIMNavigationVisible, visibleLocalWorkspaceIndicator } from "./app-navigation-status";
import { accountDisplayName, membershipTierLabel, membershipUpgradeContext, organizationMenuGroups } from "./account-menu-model";

export { APP_PRIMARY_RAIL_ORDER } from "./app-navigation-order";

export const APP_NAVIGATION_RAIL_WIDTH = 48;

type AppNavigationRailProps = {
  /** Home surface is the visible one — its rail button reflects the task scope. */
  homeActive?: boolean;
  appsActive?: boolean;
  settingsActive?: boolean;
  chatActive?: boolean;
  reviewsActive?: boolean;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
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
      data-app-rail-button
      className={cn(
        "relative flex size-9 items-center justify-center rounded-xl text-dls-secondary/80 transition-[background-color,color,transform] duration-150 mac:titlebar-no-drag [&>svg]:size-5 [&>svg]:stroke-[1.85]",
        "hover:bg-dls-hover hover:text-dls-text active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-dls-sidebar",
        active && "bg-dls-active text-dls-text",
        disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-dls-secondary active:scale-100",
      )}
    >
      {children}
      {statusIndicator ? (
        <span
          className={cn(
            "absolute flex items-center justify-center",
            statusIndicator === "running" ? "-right-0.5 -top-0.5 size-4" : "right-0 top-0 size-2.5",
          )}
          title={statusIndicator === "running" ? t("workspace_list.session_streaming") : t("workspace_list.session_completed_unseen")}
          aria-label={statusIndicator === "running" ? t("workspace_list.session_streaming") : t("workspace_list.session_completed_unseen")}
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
          className="absolute right-0 top-0 size-2.5 rounded-full border-2 border-dls-sidebar bg-red-9"
          aria-hidden="true"
          data-rail-unread-dot
        />
      ) : (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-dls-sidebar bg-red-9 px-1 text-[10px] font-semibold leading-none text-white" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

export function AppNavigationRail(props: AppNavigationRailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const platform = usePlatform();
  const {
    status: authStatus,
    user,
    organizations,
    activeOrganization,
    tenantAccount,
    accountBusy,
    accountError,
    refreshAccount,
    switchOrganization,
    signOut,
  } = useDenAuth();
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

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
  const identity = accountDisplayName(user);
  const initial = identity.slice(0, 1).toLocaleUpperCase();
  const tier = tenantAccount?.tier ?? activeOrganization?.tier ?? null;
  const tierLabel = membershipTierLabel(tier);
  const organizationLabel = activeOrganization?.name ?? readDenSettings().activeOrgName?.trim() ?? t("account_menu.no_organization");
  const organizationGroups = organizationMenuGroups(organizations);
  const upgradeContext = membershipUpgradeContext(tenantAccount, activeOrganization);
  const imNavigationVisible = isIMNavigationVisible({
    authStatus,
    activeOrganizationId: activeOrganization?.id,
    im: readDenIMLoginBootstrap(),
  });
  const balanceLabel = tenantAccount
    ? new Intl.NumberFormat(currentLocale()).format(tenantAccount.points.available)
    : accountBusy
      ? t("account_menu.loading")
      : "—";

  const openUpgrade = () => {
    if (!upgradeContext) return;
    setAccountMenuOpen(false);
    platform.openLink(buildDenMembershipUpgradeUrl(readDenSettings().baseUrl, upgradeContext));
  };
  const openBillingDashboard = () => platform.openLink(buildDenDashboardUrl(readDenSettings().baseUrl));
  const openManagementConsole = () => platform.openLink(buildDenDashboardUrl(readDenSettings().baseUrl));
  const checkForUpdates = () => {
    useUpdateCheckRequestStore.getState().requestUpdateCheck();
    navigate("/settings/updates");
  };
  const openHelpAndFeedback = () => platform.openLink(buildFeedbackUrl({ entrypoint: "account-menu" }));
  const changeOrganization = async (organizationId: string) => {
    try {
      await switchOrganization(organizationId);
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : t("account_menu.switch_failed"));
    }
  };
  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : t("den.error_signout_failed"));
    }
  };

  return (
    <aside
      aria-label={t("navigation.primary")}
      data-app-navigation-rail
      className="flex h-full w-12 shrink-0 flex-col items-center bg-dls-sidebar px-1 pb-2.5 pt-2 mac:titlebar-drag mac:pt-10"
    >
      <nav className="flex flex-col items-center gap-2" data-rail-order={APP_PRIMARY_RAIL_ORDER.join(",")}>
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
                  data-app-rail-button
                  className={cn(
                    "relative flex size-9 items-center justify-center rounded-xl text-dls-secondary/80 transition-[background-color,color,transform] duration-150 mac:titlebar-no-drag",
                    "hover:bg-dls-hover hover:text-dls-text active:scale-[0.96]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-dls-sidebar",
                    "data-popup-open:bg-dls-active data-popup-open:text-dls-text",
                    "[&>svg]:size-5 [&>svg]:stroke-[1.85]",
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
        <RailButton
          label={t("navigation.reviews")}
          active={props.reviewsActive}
          onClick={props.onOpenReviews}
          testId="app-rail-reviews"
        >
          <GitPullRequestArrow />
        </RailButton>
        {LOCAL_AUTOMATION_ENABLED ? <RailButton
          label={t("navigation.automations")}
          active={location.pathname.startsWith("/automations")}
          onClick={() => navigate("/automations")}
          testId="app-rail-automations"
        >
          <AlarmClock />
        </RailButton> : null}
        {imNavigationVisible ? (
          <>
            <RailButton
              label={t("navigation.chat")}
              active={props.chatActive && chatView !== "contacts"}
              onClick={() => openChatView("conversations")}
              testId="app-rail-chat"
              badge={totalUnreadCount}
              badgeVariant="dot"
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
          </>
        ) : null}
      </nav>

      <div className="relative mt-auto flex h-9 w-full items-center justify-center mac:titlebar-no-drag">
        <DropdownMenu open={accountMenuOpen} onOpenChange={(open) => { setAccountMenuOpen(open); if (open) void refreshAccount(); }}>
          <DropdownMenuTrigger
            render={(
              <button
                type="button"
                aria-label={t("account_menu.open")}
                title={identity}
                data-testid="app-rail-account-menu"
                data-app-rail-button
                className={cn(
                  "relative flex size-9 items-center justify-center rounded-xl transition-[background-color,transform] duration-150",
                  "hover:bg-dls-hover active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-dls-sidebar",
                  "data-popup-open:bg-dls-active",
                  props.settingsActive && "bg-dls-active",
                )}
              >
                <Avatar size="lg" className="size-7 bg-background ring-1 ring-dls-border/70">
                  {user?.avatar ? <AvatarImage src={user.avatar} alt={identity} /> : null}
                  <AvatarFallback className="bg-dls-hover font-semibold text-dls-text">{initial}</AvatarFallback>
                  {notificationUnreadCount > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-dls-sidebar bg-red-9" aria-hidden="true" data-rail-unread-dot />
                  ) : null}
                </Avatar>
              </button>
            )}
          />
          <DropdownMenuContent
            side="right"
            align="end"
            sideOffset={10}
            className="w-[328px] rounded-[22px] bg-popover/95 p-2 shadow-[0_20px_64px_rgba(0,0,0,0.22)] ring-1 ring-foreground/10 backdrop-blur-2xl"
            data-testid="account-menu"
          >
            <div className="flex items-center gap-3 px-3 py-2.5" role="presentation">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold leading-5 text-popover-foreground">{identity}</div>
                <div className="mt-0.5 truncate text-[12px] leading-4 text-muted-foreground">{tierLabel} · {organizationLabel}</div>
              </div>
              {upgradeContext ? (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); openUpgrade(); }}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-dls-accent px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 active:scale-[0.98]"
                  data-testid="account-menu-upgrade"
                >
                  <Sparkles className="size-3.5" />
                  {t("account_menu.upgrade")}
                </button>
              ) : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={props.onOpenSettings} data-testid="account-menu-settings">
              <Settings />
              {t("navigation.settings")}
              {notificationUnreadCount > 0 ? <span className="ms-auto size-2 rounded-full bg-red-9" aria-hidden="true" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openBillingDashboard} data-testid="account-menu-balance">
              <Coins />
              <span>{t("account_menu.balance")}</span>
              <span className="ms-auto tabular-nums text-xs text-muted-foreground">{balanceLabel}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={checkForUpdates} data-testid="account-menu-check-updates">
              <RefreshCw />
              {t("account_menu.check_updates")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openHelpAndFeedback} data-testid="account-menu-help-feedback">
              <HelpCircle />
              {t("account_menu.help_feedback")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="account-menu-switch-organization">
                <Globe />
                {t("account_menu.switch_organization")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent side="right" align="end" sideOffset={8} className="w-[248px]">
                {organizationGroups.personal.map((organization) => (
                  <DropdownMenuItem
                    key={organization.id}
                    disabled={accountBusy}
                    onClick={() => void changeOrganization(organization.id)}
                    className="items-start py-2.5"
                    data-testid={`account-menu-organization-${organization.id}`}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-xs font-semibold">
                      {organization.name.trim().slice(0, 1).toLocaleUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{organization.name}</span>
                      <span className="block truncate text-[11px] font-normal text-muted-foreground">{membershipTierLabel(organization.tier)}</span>
                    </span>
                    {organization.id === activeOrganization?.id ? <Check className="mt-1 size-4 text-dls-accent" /> : null}
                  </DropdownMenuItem>
                ))}
                {organizationGroups.personal.length > 0 && organizationGroups.others.length > 0 ? <DropdownMenuSeparator /> : null}
                {organizationGroups.others.map((organization) => (
                  <DropdownMenuItem
                    key={organization.id}
                    disabled={accountBusy}
                    onClick={() => void changeOrganization(organization.id)}
                    className="items-start py-2.5"
                    data-testid={`account-menu-organization-${organization.id}`}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-xs font-semibold">
                      {organization.name.trim().slice(0, 1).toLocaleUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{organization.name}</span>
                      <span className="block truncate text-[11px] font-normal text-muted-foreground">{membershipTierLabel(organization.tier)}</span>
                    </span>
                    {organization.id === activeOrganization?.id ? <Check className="mt-1 size-4 text-dls-accent" /> : null}
                  </DropdownMenuItem>
                ))}
                {organizations.length === 0 ? (
                  <DropdownMenuItem disabled>{accountBusy ? t("account_menu.loading") : t("account_menu.no_organization")}</DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={openManagementConsole} data-testid="account-menu-management-console">
              <ArrowUpRight />
              {t("account_menu.management_console")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => void handleSignOut()} disabled={!user || accountBusy} data-testid="account-menu-sign-out">
              <LogOut />
              {t("den.sign_out")}
            </DropdownMenuItem>
            {accountError ? <div className="px-3 pb-1 pt-2 text-[11px] leading-4 text-destructive">{accountError}</div> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
