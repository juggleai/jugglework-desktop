/** @jsxImportSource react */
import { AppNavigationRail } from "./app-navigation-rail";
import { SettingsRoute } from "./settings-route";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";

export type AppsPageProps = {
  workspaceId?: string | null;
  /** 应用页当前是否可见；隐藏时内嵌设置面的模型选择器不响应全局打开事件。 */
  active?: boolean;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  /** Opens the cross-workspace task search dialog owned by the session shell. */
  onOpenTaskSearch: () => void;
  /** Opens the requested workspace creation flow owned by the session shell. */
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

export function AppsPage(props: AppsPageProps) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <AppNavigationRail
        appsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={() => undefined}
        onOpenChat={props.onOpenChat}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SettingsRoute
          embedded
          contentOnly
          initialPath="extensions/mcp"
          workspaceId={props.workspaceId ?? undefined}
          active={props.active}
        />
      </main>
    </div>
  );
}
