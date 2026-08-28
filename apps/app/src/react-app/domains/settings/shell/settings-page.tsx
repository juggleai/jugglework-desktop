/** @jsxImportSource react */
import type * as React from "react";
import {
  BrainCircuit,
  Bell,
  Bug,
  Cable,
  CloudCog,
  Cog,
  FolderLock,
  Layout,
  Paintbrush,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Terminal,
  UserCircle,
  Wrench,
  Zap,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { cn } from "@/lib/utils";
import {
  SettingsContent,
  SettingsPanel,
  SettingsPanelToolbar,
  SettingsPanelToolbarActions,
  SettingsPanelToolbarButton,
  SettingsPanelToolbarMessage,
  SettingsPanelToolbarStatus,
} from "./panel";
import { useFeatureFlagsPreferences } from "../state/feature-flags-preferences";
import { AppNavigationRail } from "../../../shell/app-navigation-rail";
import type { OpenCreateWorkspace } from "../../workspace/types";
import { useNotificationStore } from "../../../kernel/notification-store";

export function getSettingsTabIcon(tab: SettingsTab) {
  switch (tab) {
    case "notifications":
      return Bell;
    case "ai":
      return Zap;
    case "preferences":
      return SlidersHorizontal;
    case "shell":
      return Layout;
    case "permissions":
      return FolderLock;
    case "cloud-account":
      return UserCircle;
    case "connect":
      return Cable;
    case "cloud-marketplaces":
      return Store;
    case "cloud-providers":
      return CloudCog;
    case "skills":
      return Sparkles;
    case "connectors":
      return Cable;
    case "memory":
      return BrainCircuit;
    case "extensions":
      return Puzzle;
    case "environment":
      return Terminal;
    case "advanced":
      return Wrench;
    case "appearance":
      return Paintbrush;
    case "updates":
      return RefreshCcw;
    case "recovery":
      return ShieldCheck;
    case "debug":
      return Bug;
    default:
      return Cog;
  }
}

export function getSettingsTabLabel(tab: SettingsTab) {
  switch (tab) {
    case "notifications":
      return t("notifications.title");
    case "ai":
      return t("settings.tab_ai");
    case "preferences":
      return t("settings.tab_preferences");
    case "shell":
      return t("settings.tab_shell");
    case "permissions":
      return t("settings.tab_permissions");
    case "cloud-account":
      return t("settings.tab_cloud_account");
    case "connect":
      return t("settings.tab_connect");
    case "cloud-marketplaces":
      return t("settings.tab_cloud_marketplaces");
    case "cloud-providers":
      return t("settings.tab_cloud_providers");
    case "skills":
      return t("settings.tab_skills");
    case "connectors":
      return t("settings.tab_connectors");
    case "memory":
      return t("memory.tab_label");
    case "extensions":
      return t("settings.tab_extensions");
    case "environment":
      return t("settings.tab_environment");
    case "advanced":
      return t("settings.tab_advanced");
    case "appearance":
      return t("settings.tab_appearance");
    case "updates":
      return t("settings.tab_updates");
    case "recovery":
      return t("settings.tab_recovery");
    case "debug":
      return t("settings.tab_debug");
    case "general":
      return t("settings.tab_general");
    default:
      return t("settings.tab_general");
  }
}

export function getSettingsTabDescription(tab: SettingsTab) {
  switch (tab) {
    case "notifications":
      return t("notifications.empty_hint");
    case "ai":
      return t("settings.tab_description_ai");
    case "preferences":
      return t("settings.tab_description_preferences");
    case "shell":
      return t("settings.tab_description_shell");
    case "permissions":
      return t("settings.tab_description_permissions");
    case "cloud-account":
      return t("settings.tab_description_cloud_account");
    case "connect":
      return t("settings.tab_description_connect");
    case "cloud-marketplaces":
      return t("settings.tab_description_cloud_marketplaces");
    case "cloud-providers":
      return t("settings.tab_description_cloud_providers");
    case "skills":
      return t("settings.tab_description_skills");
    case "connectors":
      return t("settings.tab_description_connectors");
    case "memory":
      return t("memory.tab_description");
    case "extensions":
      return t("settings.tab_description_extensions");
    case "environment":
      return t("settings.tab_description_environment");
    case "advanced":
      return t("settings.tab_description_advanced");
    case "appearance":
      return t("settings.tab_description_appearance");
    case "updates":
      return t("settings.tab_description_updates");
    case "recovery":
      return t("settings.tab_description_recovery");
    case "debug":
      return t("settings.tab_description_debug");
    case "general":
      return t("settings.tab_description_overview");
    default:
      return t("settings.tab_description_general");
  }
}

/**
 * 个人设置不承载工作区配置。
 *
 * TIPS: 该列表同时决定设置页是否展示工作区分组与工作区切换器。当前工作区的
 * MCP、组织连接策略统一从会话右侧设置进入，不能在个人设置里再出现一份。
 */
export function getWorkspaceSettingsTabs(): SettingsTab[] {
  return [];
}

/** 全局分组：页内配置不随工作区切换而变化。「通用」为首项。 */
export function getGlobalSettingsTabs(developerMode: boolean): SettingsTab[] {
  const tabs: SettingsTab[] = [
    "preferences",
    "skills",
    "connectors",
    "notifications",
    "appearance",
    "updates",
    "ai",
  ];
  if (developerMode) tabs.push("debug");
  return tabs;
}

export const CLOUD_SETTINGS_TABS: SettingsTab[] = [
  "cloud-account",
];

export function isSettingsTabBeta(tab: SettingsTab) {
  return tab === "connect";
}

export function SettingsBetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-amber-6/40 bg-amber-3/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-11",
        className,
      )}
    >
      {t("common.beta")}
    </span>
  );
}

export function SettingsSidebarTabLabel({ tab }: { tab: SettingsTab }) {
  const unreadCount = useNotificationStore((state) => (
    tab === "notifications"
      ? state.notifications.filter((notification) => notification.readAt === null).length
      : 0
  ));
  return (
    <>
      <span>{getSettingsTabLabel(tab)}</span>
      {unreadCount > 0 ? (
        <span className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      ) : null}
      {isSettingsTabBeta(tab) ? <SettingsBetaBadge className="ml-auto" /> : null}
    </>
  );
}

/**
 * Cloud settings tabs, gated by client-only preview flags. The Memory tab is
 * surfaced only when `featureFlags.memory` is on (C-4). Both settings nav
 * surfaces (sidebar + compact section menu) must use this so they can't drift.
 *
 * TIPS: `connect` 保留深链与会话右侧复用能力，但不进入个人设置导航。
 */
export function getCloudSettingsTabs(memoryEnabled: boolean): SettingsTab[] {
  return memoryEnabled ? ["cloud-account", "memory"] : CLOUD_SETTINGS_TABS;
}

type SettingsPageProps = {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  showUpdateToolbar?: boolean;
  updateToolbarTone?: string;
  updateToolbarTitle?: string;
  updateToolbarSpinning?: boolean;
  updateToolbarLabel?: string;
  updateToolbarActionLabel?: string | null;
  updateToolbarDisabled?: boolean;
  updateRestartBlockedMessage?: string | null;
  onUpdateToolbarAction?: () => void;
  /** 隐藏页头标题与描述（会话右侧分组扩展面板用）。 */
  hideHeading?: boolean;
  children: React.ReactNode;
};

type SettingsSidebarProps = Pick<SettingsPageProps, "activeTab" | "onSelectTab" | "developerMode"> & {
  onClose: () => void;
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenTaskSearch?: () => void;
  onOpenCreateWorkspace?: OpenCreateWorkspace;
  onStartResize?: React.PointerEventHandler<HTMLButtonElement>;
};

export function SettingsSidebar(props: SettingsSidebarProps) {
  const { memoryEnabled } = useFeatureFlagsPreferences();
  const workspaceTabs = getWorkspaceSettingsTabs();
  const globalTabs = getGlobalSettingsTabs(props.developerMode);
  const cloudTabs = getCloudSettingsTabs(memoryEnabled);

  return (
    <Sidebar className="mac:**:data-[sidebar=sidebar]:bg-transparent">
      <div className="flex h-full min-h-0 w-full">
        <AppNavigationRail
          appsActive={props.activeTab === "extensions"}
          settingsActive={props.activeTab !== "extensions"}
          onOpenAccount={props.onOpenAccount}
          onOpenHome={props.onOpenHome}
          onOpenApps={props.onOpenApps}
          onOpenChat={props.onOpenChat}
          onOpenSettings={() => undefined}
          onOpenTaskSearch={props.onOpenTaskSearch}
          onOpenCreateWorkspace={props.onOpenCreateWorkspace}
        />
        <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
          <header className="box-border flex h-10 min-h-10 shrink-0 items-start px-3 pb-3 pt-[9px] mac:h-[50px] mac:min-h-[50px] mac:pb-[9px] mac:pt-[22px] mac:titlebar-drag">
            <div className="flex h-[18px] min-w-0 items-center">
              <h2 className="truncate text-[14px] font-semibold leading-[18px] text-sidebar-foreground">
                {t("settings.tab_general")}
              </h2>
            </div>
          </header>
          <SidebarContent className="overflow-y-auto px-2 pb-6 pt-2">
        {/* 分组为空时整组不渲染，避免留下一个空壳标题。 */}
        {workspaceTabs.length > 0 ? (
          <SidebarGroup className="rounded-xl border border-sidebar-border/70 bg-sidebar-accent/20 px-2 py-3">
            <SidebarGroupLabel className="mb-1 h-7 px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/70">
              {t("settings.group_workspace")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {workspaceTabs.map((tab) => {
                  const Icon = getSettingsTabIcon(tab);
                  return (
                    <SidebarMenuItem key={tab}>
                      <SidebarMenuButton
                        className="min-h-10 rounded-lg px-3"
                        type="button"
                        isActive={props.activeTab === tab}
                        onClick={() => props.onSelectTab(tab)}
                      >
                        <Icon />
                        <SettingsSidebarTabLabel tab={tab} />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SidebarGroup className={cn(
          "rounded-xl border border-sidebar-border/70 bg-sidebar-accent/20 px-2 py-3",
          workspaceTabs.length > 0 && "mt-3",
        )}>
          <SidebarGroupLabel className="mb-1 h-7 px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/70">
            {t("settings.group_global")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {globalTabs.map((tab) => {
                const Icon = getSettingsTabIcon(tab);
                return (
                  <SidebarMenuItem key={tab}>
                    <SidebarMenuButton
                      className="min-h-10 rounded-lg px-3"
                      type="button"
                      isActive={props.activeTab === tab}
                      onClick={() => props.onSelectTab(tab)}
                    >
                      <Icon />
                      <SettingsSidebarTabLabel tab={tab} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-3 rounded-xl border border-sidebar-border/70 bg-sidebar-accent/20 px-2 py-3">
          <SidebarGroupLabel className="mb-1 h-7 px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/70">
            {t("settings.group_cloud")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {cloudTabs.map((tab) => {
                const Icon = getSettingsTabIcon(tab);
                return (
                  <SidebarMenuItem key={tab}>
                    <SidebarMenuButton
                      className="min-h-10 rounded-lg px-3"
                      type="button"
                      isActive={props.activeTab === tab}
                      onClick={() => props.onSelectTab(tab)}
                    >
                      <Icon />
                      <SettingsSidebarTabLabel tab={tab} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
          </SidebarContent>
        </div>
      </div>
      <SidebarRail
        className="right-[-8px]! translate-x-0! bg-transparent! hover:bg-transparent!"
        style={{ cursor: "col-resize" }}
        aria-label={props.onStartResize ? t("session.resize_workspace_column") : undefined}
        title={props.onStartResize ? t("session.resize_workspace_column") : undefined}
        onClick={props.onStartResize ? (event) => event.preventDefault() : undefined}
        onPointerDown={props.onStartResize}
      />
    </Sidebar>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  // 会话右侧分组扩展面板隐藏页头标题/描述与策略横幅，仅保留分组内容。
  if (props.hideHeading) {
    return <SettingsContent compact>{props.children}</SettingsContent>;
  }
  return (
    <SettingsContent>
      {props.showUpdateToolbar && props.activeTab === "general" ? (
        <SettingsPanel>
          <SettingsPanelToolbar>
            <SettingsPanelToolbarActions>
              <SettingsPanelToolbarStatus
                tone={props.updateToolbarTone}
                title={props.updateToolbarTitle}
                spinning={props.updateToolbarSpinning}
              >
                {props.updateToolbarLabel}
              </SettingsPanelToolbarStatus>
              {props.updateToolbarActionLabel ? (
                <SettingsPanelToolbarButton
                  onClick={props.onUpdateToolbarAction}
                  disabled={props.updateToolbarDisabled}
                  title={props.updateRestartBlockedMessage ?? ""}
                >
                  {props.updateToolbarActionLabel}
                </SettingsPanelToolbarButton>
              ) : null}
            </SettingsPanelToolbarActions>
            {props.updateRestartBlockedMessage ? (
              <SettingsPanelToolbarMessage>{props.updateRestartBlockedMessage}</SettingsPanelToolbarMessage>
            ) : null}
          </SettingsPanelToolbar>
        </SettingsPanel>
      ) : null}

      {props.children}
    </SettingsContent>
  );
}
