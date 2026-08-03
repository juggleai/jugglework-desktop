/** @jsxImportSource react */
import { JuggleChatApp } from "@/react-app/domains/jugglechat/jugglechat-app";
import { AppNavigationRail } from "./app-navigation-rail";

export type ChatPageProps = {
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onToggleChat: () => void;
  onOpenSettings: () => void;
};

export function ChatPage(props: ChatPageProps) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <AppNavigationRail
        chatActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={props.onOpenApps}
        onOpenChat={props.onToggleChat}
        onOpenSettings={props.onOpenSettings}
      />
      <main className="relative min-h-0 min-w-0 flex-1 bg-white">
        <JuggleChatApp />
      </main>
    </div>
  );
}
