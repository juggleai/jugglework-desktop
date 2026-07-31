/** @jsxImportSource react */
import { AppNavigationRail } from "./app-navigation-rail";
import { SettingsRoute } from "./settings-route";

export type AppsPageProps = {
  workspaceId?: string | null;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onCreateLocalWorkspace: () => void;
  onConnectRemoteWorkspace: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
};

export function AppsPage(props: AppsPageProps) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <AppNavigationRail
        appsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={() => undefined}
        onCreateLocalWorkspace={props.onCreateLocalWorkspace}
        onConnectRemoteWorkspace={props.onConnectRemoteWorkspace}
        onOpenChat={props.onOpenChat}
        onOpenSettings={props.onOpenSettings}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SettingsRoute
          embedded
          contentOnly
          initialPath="extensions/mcp"
          workspaceId={props.workspaceId ?? undefined}
        />
      </main>
    </div>
  );
}
