/** @jsxImportSource react */
import { useState } from "react";

import { AppNavigationRail } from "./app-navigation-rail";

const CHAT_ENTRY_URL = typeof window !== "undefined" && window.location.protocol === "file:"
  ? "./chat/index.html"
  : "/chat/index.html";

export type ChatPageProps = {
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onCreateLocalWorkspace: () => void;
  onConnectRemoteWorkspace: () => void;
  onToggleChat: () => void;
  onOpenSettings: () => void;
};

export function ChatPage(props: ChatPageProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <AppNavigationRail
        chatActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={props.onOpenApps}
        onCreateLocalWorkspace={props.onCreateLocalWorkspace}
        onConnectRemoteWorkspace={props.onConnectRemoteWorkspace}
        onOpenChat={props.onToggleChat}
        onOpenSettings={props.onOpenSettings}
      />
      <main className="relative min-h-0 min-w-0 flex-1 bg-white">
        {!loaded ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background text-sm text-dls-secondary">
            Loading Chat…
          </div>
        ) : null}
        <iframe
          src={CHAT_ENTRY_URL}
          title="Chat"
          loading="eager"
          className="h-full w-full border-0 bg-white"
          allow="autoplay; camera; microphone; clipboard-read; clipboard-write"
          onLoad={() => setLoaded(true)}
          data-testid="chat-web-app"
        />
      </main>
    </div>
  );
}
