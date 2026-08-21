/** @jsxImportSource react */
import type * as React from "react";
import { ChevronDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  SettingsPage,
  SettingsBetaBadge,
  SettingsSidebarTabLabel,
  SettingsSidebar,
  getCloudSettingsTabs,
  getGlobalSettingsTabs,
  getSettingsTabIcon,
  getSettingsTabLabel,
  getWorkspaceSettingsTabs,
  isSettingsTabBeta,
} from "./settings-page";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { useFeatureFlagsPreferences } from "../state/feature-flags-preferences";
import { APP_NAVIGATION_RAIL_WIDTH } from "../../../shell/app-navigation-rail";
import { useWorkspaceShellLayout } from "../../../shell/workspace-shell-layout";
import type { OpenCreateWorkspace } from "../../workspace/types";

type SettingsPageFrameProps = Omit<React.ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageFrameProps & {
  contentOnly?: boolean;
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  headerStatus?: string;
  busyHint?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenTaskSearch?: () => void;
  onOpenCreateWorkspace?: OpenCreateWorkspace;
  onClose: () => void;
  headerLeadingSlot?: React.ReactNode;
  children: React.ReactNode;
  modalSlot?: React.ReactNode;
  footer?: React.ReactNode;
  compact?: boolean;
  /** 设置后 compact 头部只显示该静态标题（替代分区菜单与工作区切换器），会话右侧分组扩展面板用。 */
  compactTitle?: string;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);
  const workspaceScoped = getWorkspaceSettingsTabs().includes(props.activeTab);
  const { leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({
    expandedRightWidth: 520,
  });

  if (props.contentOnly) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <div className="hidden h-10 shrink-0 border-b border-dls-border mac:block mac:titlebar-drag" />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          <div className="mx-auto flex w-full max-w-3xl flex-col">{props.children}</div>
        </div>
        {props.modalSlot}
        {props.footer}
      </div>
    );
  }

  if (props.compact) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <header className="session-panel-header flex shrink-0 items-center justify-between gap-2 border-b border-dls-border px-3 mac:titlebar-drag">
          <div className="flex min-w-0 items-center gap-2 mac:titlebar-no-drag">
            {props.compactTitle ? (
              <h1 className="truncate text-[15px] font-semibold text-dls-text">{props.compactTitle}</h1>
            ) : (
              <>
                <SettingsSectionMenu
                  activeTab={props.activeTab}
                  developerMode={props.developerMode}
                  onSelectTab={props.onSelectTab}
                />
                {workspaceScoped ? (
                  <span className="min-w-0 mac:titlebar-no-drag">
                    <WorkspaceMenu
                      selectedWorkspaceId={props.selectedWorkspaceId}
                      selectedWorkspaceName={props.selectedWorkspaceName}
                      workspaces={props.workspaces}
                      onSelectWorkspace={props.onSelectWorkspace}
                    />
                  </span>
                ) : null}
              </>
            )}
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <SettingsPage {...props}>{props.children}</SettingsPage>

            {props.modalSlot}
          </div>

          {props.footer}
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-screen w-full overflow-hidden">
      <SidebarProvider
        open={true}
        className="relative min-h-0 flex-1"
        style={{ "--sidebar-width": `${leftSidebarWidth + APP_NAVIGATION_RAIL_WIDTH}px` } as React.CSSProperties}
      >
        <SettingsSidebar
          activeTab={props.activeTab}
          onSelectTab={props.onSelectTab}
          developerMode={props.developerMode}
          onClose={props.onClose}
          selectedWorkspaceId={props.selectedWorkspaceId}
          selectedWorkspaceName={props.selectedWorkspaceName}
          selectedWorkspaceColor={props.selectedWorkspaceColor}
          workspaces={props.workspaces}
          onSelectWorkspace={props.onSelectWorkspace}
          onOpenAccount={props.onOpenAccount}
          onOpenHome={props.onOpenHome}
          onOpenApps={props.onOpenApps}
          onOpenChat={props.onOpenChat}
          onOpenTaskSearch={props.onOpenTaskSearch}
          onOpenCreateWorkspace={props.onOpenCreateWorkspace}
          onStartResize={startLeftSidebarResize}
        />
        <SidebarInset className="min-h-0 overflow-hidden bg-background mac:bg-background/80 mac:[&_header]:transition-[padding-left] mac:[&_header]:duration-200 mac:[&_header]:ease-linear mac:peer-data-[state=collapsed]:[&_header]:pl-16 [&_header]:pl-16 md:[&_header]:pl-6">
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex h-[var(--app-topbar-height)] shrink-0 items-center justify-between border-b border-dls-border bg-background px-4 md:px-6 mac:titlebar-drag">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger className="mac:titlebar-no-drag md:hidden" />
                {props.headerLeadingSlot}
                <h1 className="truncate text-[15px] font-semibold text-dls-text">{title}</h1>
                {workspaceScoped ? (
                  <span className="min-w-0 mac:titlebar-no-drag">
                    <WorkspaceMenu
                      selectedWorkspaceId={props.selectedWorkspaceId}
                      selectedWorkspaceName={props.selectedWorkspaceName}
                      workspaces={props.workspaces}
                      onSelectWorkspace={props.onSelectWorkspace}
                    />
                  </span>
                ) : null}
                {props.developerMode && props.headerStatus ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.headerStatus}
                  </span>
                ) : null}
                {props.busyHint ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.busyHint}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 text-gray-10 mac:titlebar-no-drag">
                <Button
                  variant="ghost"
                  type="button"
                  className="flex size-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text md:hidden"
                  onClick={props.onClose}
                  title={t("dashboard.close_settings")}
                  aria-label={t("dashboard.close_settings")}
                >
                  <X size={18} />
                </Button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col">
              <SettingsPage {...props}>{props.children}</SettingsPage>

              {props.modalSlot}
            </div>

            {props.footer}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function SettingsSectionMenu(props: Pick<SettingsPageFrameProps, "activeTab" | "developerMode" | "onSelectTab">) {
  const { memoryEnabled } = useFeatureFlagsPreferences();
  const sections: Array<{ label: string | null; tabs: SettingsTab[] }> = [
    { label: t("settings.group_workspace"), tabs: getWorkspaceSettingsTabs() },
    { label: t("settings.group_global"), tabs: getGlobalSettingsTabs(props.developerMode) },
    { label: t("settings.group_cloud"), tabs: getCloudSettingsTabs(memoryEnabled) },
  ];
  const ActiveIcon = getSettingsTabIcon(props.activeTab);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="outline" size="sm" className="min-w-0 max-w-46 justify-start gap-2">
            <ActiveIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{getSettingsTabLabel(props.activeTab)}</span>
            {isSettingsTabBeta(props.activeTab) ? <SettingsBetaBadge /> : null}
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-64">
        {sections.map((section, index) => (
          <DropdownMenuGroup key={section.label ?? "root"}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {section.label ? <DropdownMenuLabel>{section.label}</DropdownMenuLabel> : null}
            {section.tabs.map((tab) => {
              const Icon = getSettingsTabIcon(tab);
              return (
                <DropdownMenuItem
                  key={tab}
                  onClick={() => props.onSelectTab(tab)}
                  className={props.activeTab === tab ? "bg-foreground/10 text-accent-foreground" : undefined}
                >
                  <Icon />
                  <SettingsSidebarTabLabel tab={tab} />
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceMenu(props: Pick<SettingsShellProps, "selectedWorkspaceId" | "selectedWorkspaceName" | "workspaces" | "onSelectWorkspace">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="sm"
            className="min-w-48 max-w-[min(26rem,55vw)] justify-start gap-2 px-3 text-dls-secondary mac:titlebar-no-drag"
          >
            <WorkspaceIcon workspaceId={props.selectedWorkspaceId} sizeClass="size-4" />
            <span className="min-w-0 flex-1 truncate text-left">{props.selectedWorkspaceName}</span>
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-80 max-w-[calc(100vw-2rem)] mac:titlebar-no-drag">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("settings.select_workspace")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {props.workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              onClick={() => props.onSelectWorkspace(workspace.id)}
              disabled={workspace.id === props.selectedWorkspaceId}
            >
              <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
              <span className="min-w-0 whitespace-normal break-words leading-5">{workspace.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
