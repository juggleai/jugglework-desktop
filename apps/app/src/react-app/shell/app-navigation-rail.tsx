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
  Ellipsis,
  Globe,
  HelpCircle,
  House,
  LogOut,
  MessageSquare,
  GitPullRequestArrow,
  Pin,
  RefreshCw,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { setTaskScope, useTaskScope, type TaskScope } from "@/react-app/domains/session/sidebar/task-scope-store";
import { useLocalWorkspaceIndicator } from "@/react-app/domains/session/sidebar/workspace-indicator-store";
import { SessionCircularProgress } from "@/react-app/domains/session/sidebar/session-circular-progress";
import type { WorkspaceSessionIndicator } from "@/react-app/domains/session/sidebar/utils";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { APP_PRIMARY_RAIL_ORDER } from "./app-navigation-order";
import {
  APP_NAVIGATION_PINS_STORAGE_KEY,
  appNavigationPinsChangedEvent,
  readPinnedAppNavigationItems,
  setAppNavigationItemPinned,
  type PinnableAppNavigationItem,
} from "./app-navigation-pins";
import { LOCAL_AUTOMATION_ENABLED } from "@/react-app/domains/automations/automation-feature-flags";
import { isIMNavigationVisible, visibleLocalWorkspaceIndicator } from "./app-navigation-status";
import { accountDisplayName, membershipTierLabel, membershipUpgradeContext, organizationMenuGroups } from "./account-menu-model";
import { PluginOrbitIcon } from "@/react-app/design-system/plugin-orbit-icon";

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
  onPreviewMenuChange?: (scope: TaskScope | null) => void;
  suppressPreviewMenuTooltips?: boolean;
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
  showTooltip?: boolean;
  tooltipLabel?: string;
  previewScope?: TaskScope;
  onPreviewMenuChange?: (scope: TaskScope | null) => void;
};

function LocalWorkspaceIcon({ active }: { active: boolean }) {
  if (!active) {
    return <House className="size-5 text-current" strokeWidth={1.85} data-local-workspace-icon="outline" />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5 text-current"
      data-local-workspace-icon="filled"
    >
      <path
        d="M3.35 10.05c0-.58.25-1.13.69-1.51l6.67-5.72a2 2 0 0 1 2.58 0l6.67 5.72c.44.38.69.93.69 1.51V19a2 2 0 0 1-2 2H5.35a2 2 0 0 1-2-2v-8.95Z"
        fill="currentColor"
      />
      <path
        d="M9.75 21v-5.8c0-.66.54-1.2 1.2-1.2h2.1c.66 0 1.2.54 1.2 1.2V21h-4.5Z"
        fill="var(--dls-active)"
        data-local-workspace-doorway
      />
    </svg>
  );
}

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
  showTooltip = true,
  tooltipLabel,
  previewScope,
  onPreviewMenuChange,
}: RailButtonProps) {
  const resolvedBadgeLabel = badgeLabel ?? t("chat.unread_count", { count: badge });
  const button = (
    <button
      type="button"
      aria-label={badge > 0 ? `${label}, ${resolvedBadgeLabel}` : label}
      title={showTooltip ? label : undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => onPreviewMenuChange?.(previewScope ?? null)}
      onMouseLeave={() => onPreviewMenuChange?.(null)}
      data-testid={testId}
      data-app-rail-button
      data-active={active ? "true" : undefined}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-xl text-dls-secondary/80 transition-[background-color,color,transform] duration-150 mac:titlebar-no-drag [&>svg]:size-5 [&>svg]:stroke-[1.85]",
        "hover:bg-dls-hover hover:text-dls-text active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-dls-sidebar",
        active && "bg-dls-active [&>svg]:fill-current",
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
  if (!showTooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent
        side="right"
        sideOffset={6}
        hideArrow
        className="rounded-xl border border-dls-border bg-dls-active px-2.5 py-1.5 text-xs font-normal text-dls-text shadow-[0_6px_18px_rgba(0,0,0,0.24)]"
        data-app-rail-tooltip
      >
        {tooltipLabel ?? label}
      </TooltipContent>
    </Tooltip>
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
  const [navigationMenuOpen, setNavigationMenuOpen] = useState(false);
  const [pinnedNavigationItems, setPinnedNavigationItems] = useState<PinnableAppNavigationItem[]>(
    readPinnedAppNavigationItems,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncPinnedItems = (event: Event) => {
      if (event.type === "storage") {
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== APP_NAVIGATION_PINS_STORAGE_KEY) return;
        setPinnedNavigationItems(readPinnedAppNavigationItems());
        return;
      }
      const detail = event instanceof CustomEvent
        ? event.detail as PinnableAppNavigationItem[] | undefined
        : undefined;
      setPinnedNavigationItems(detail ?? readPinnedAppNavigationItems());
    };
    window.addEventListener("storage", syncPinnedItems);
    window.addEventListener(appNavigationPinsChangedEvent, syncPinnedItems);
    return () => {
      window.removeEventListener("storage", syncPinnedItems);
      window.removeEventListener(appNavigationPinsChangedEvent, syncPinnedItems);
    };
  }, []);

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
  const reviewsPinned = pinnedNavigationItems.includes("reviews");
  const openReviews = () => {
    setNavigationMenuOpen(false);
    props.onOpenReviews();
  };
  const toggleReviewsPinned = () => {
    setPinnedNavigationItems(setAppNavigationItemPinned("reviews", !reviewsPinned));
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
      className="flex h-full w-12 shrink-0 flex-col items-center bg-dls-sidebar px-1 pb-2.5 pt-2 mac:titlebar-drag mac:pt-[52px]"
    >
      <nav className="flex flex-col items-center gap-2" data-rail-order={APP_PRIMARY_RAIL_ORDER.join(",")}>
        <RailButton
          label={t("navigation.local_workspace")}
          active={props.homeActive && taskScope === "local"}
          onClick={() => openTaskScope("local")}
          testId="app-rail-home"
          statusIndicator={visibleLocalWorkspaceIndicator(localWorkspaceIndicator, props.homeActive, taskScope)}
          previewScope="local"
          onPreviewMenuChange={props.onPreviewMenuChange}
          showTooltip={!props.suppressPreviewMenuTooltips}
        >
          <LocalWorkspaceIcon active={Boolean(props.homeActive && taskScope === "local")} />
        </RailButton>
        <RailButton
          label={t("navigation.cloud_workspace")}
          active={props.homeActive && taskScope === "remote"}
          onClick={() => openTaskScope("remote")}
          testId="app-rail-cloud-tasks"
          previewScope="remote"
          onPreviewMenuChange={props.onPreviewMenuChange}
          showTooltip={!props.suppressPreviewMenuTooltips}
        >
          <Cloud className="size-5" strokeWidth={1.8} />
        </RailButton>
        {LOCAL_AUTOMATION_ENABLED ? <RailButton
          label={t("navigation.automations")}
          tooltipLabel={t("automation.tabs.tasks")}
          active={location.pathname.startsWith("/automations")}
          onClick={() => navigate("/automations")}
          testId="app-rail-automations"
          onPreviewMenuChange={props.onPreviewMenuChange}
        >
          <AlarmClock />
        </RailButton> : null}
        <RailButton
          label={t("project_extensions.group_plugin")}
          active={props.appsActive}
          onClick={props.onOpenApps}
          testId="app-rail-plugins"
          onPreviewMenuChange={props.onPreviewMenuChange}
        >
          <PluginOrbitIcon />
        </RailButton>
        {imNavigationVisible ? (
          <>
            <RailButton
              label={t("navigation.chat")}
              active={props.chatActive && chatView !== "contacts"}
              onClick={() => openChatView("conversations")}
              testId="app-rail-chat"
              onPreviewMenuChange={props.onPreviewMenuChange}
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
              onPreviewMenuChange={props.onPreviewMenuChange}
            >
              <ContactRound />
            </RailButton>
          </>
        ) : null}
        <DropdownMenu open={navigationMenuOpen} onOpenChange={setNavigationMenuOpen}>
          <DropdownMenuTrigger
            render={(
              <button
                type="button"
                aria-label={t("navigation.more")}
                title={t("navigation.more")}
                data-testid="app-rail-more"
                data-app-rail-button
                data-active={(navigationMenuOpen || (props.reviewsActive && !reviewsPinned)) ? "true" : undefined}
                className={cn(
                  "relative flex size-9 items-center justify-center rounded-xl text-dls-secondary/80 transition-[background-color,color,transform] duration-150 mac:titlebar-no-drag",
                  "hover:bg-dls-hover hover:text-dls-text active:scale-[0.96]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-dls-sidebar",
                  "data-popup-open:bg-dls-active data-popup-open:text-dls-text",
                  (navigationMenuOpen || (props.reviewsActive && !reviewsPinned)) && "bg-dls-active text-dls-text",
                )}
              >
                <Ellipsis className="size-5" strokeWidth={2} />
              </button>
            )}
          />
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={10}
            className="w-[180px] rounded-2xl bg-popover/95 p-0.5 shadow-[0_18px_48px_rgba(0,0,0,0.20)] ring-1 ring-foreground/10 backdrop-blur-2xl"
            data-testid="app-navigation-more-menu"
          >
            <div
              className="group flex items-center gap-1 rounded-2xl transition-colors hover:bg-accent focus-within:bg-accent"
              data-testid="app-navigation-more-reviews-row"
            >
              <DropdownMenuItem
                onClick={openReviews}
                className="min-w-0 flex-1 bg-transparent py-[5px] focus:bg-transparent! data-highlighted:bg-transparent!"
                data-testid="app-navigation-more-reviews"
              >
                <GitPullRequestArrow />
                <span className="truncate">{t("navigation.reviews")}</span>
              </DropdownMenuItem>
              <button
                type="button"
                aria-label={reviewsPinned ? t("navigation.unpin_item") : t("navigation.pin_item")}
                title={reviewsPinned ? t("navigation.unpin_item") : t("navigation.pin_item")}
                tabIndex={reviewsPinned ? 0 : -1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleReviewsPinned();
                }}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-[background-color,color,opacity,transform] duration-150",
                  "hover:text-popover-foreground active:scale-[0.94]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35",
                  reviewsPinned
                    ? "text-popover-foreground opacity-100"
                    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                )}
                data-testid="app-navigation-pin-reviews"
                data-pinned={reviewsPinned ? "true" : undefined}
              >
                <Pin className={cn("size-4", reviewsPinned && "fill-current")} />
              </button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        {reviewsPinned ? (
          <div className="mt-0.5 flex flex-col items-center gap-2" data-app-navigation-pinned-items>
            <div
              className="h-px w-6 rounded-full bg-dls-secondary/20"
              aria-hidden="true"
              data-testid="app-navigation-pinned-separator"
            />
            <RailButton
              label={t("navigation.reviews")}
              active={props.reviewsActive}
              onClick={props.onOpenReviews}
              testId="app-rail-pinned-reviews"
              onPreviewMenuChange={props.onPreviewMenuChange}
            >
              <GitPullRequestArrow />
            </RailButton>
          </div>
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
