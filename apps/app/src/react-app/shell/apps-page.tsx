/** @jsxImportSource react */
import { AppNavigationRail } from "./app-navigation-rail";
import { AppInsetSurface } from "./app-inset-surface";
import { SettingsRoute } from "./settings-route";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";

export type AppsPageProps = {
  workspaceId?: string | null;
  /** 应用页当前是否可见；隐藏时内嵌设置面的模型选择器不响应全局打开事件。 */
  active?: boolean;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog owned by the session shell. */
  onOpenTaskSearch: () => void;
  /** Opens the requested workspace creation flow owned by the session shell. */
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

export function AppsPage(props: AppsPageProps) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag">
      <AppNavigationRail
        appsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={() => undefined}
        onOpenChat={props.onOpenChat}
        onOpenReviews={props.onOpenReviews}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <AppInsetSurface testId="plugins-inset-surface">
        <SettingsRoute
          embedded
          contentOnly
          pluginCatalogOnly
          initialPath="extensions/plugins"
          workspaceId={props.workspaceId ?? undefined}
          active={props.active}
        />
      </AppInsetSurface>
    </div>
  );
}
