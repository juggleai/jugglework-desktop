/** @jsxImportSource react */
import { useEffect } from "react";
import { LoaderCircle, PanelLeftIcon } from "lucide-react";

import {
  ConnectionBanner,
  CallOverlay,
  ContactsSurface,
  ConversationList,
  ConversationSurface,
  FavoritesSurface,
  LoginScreen,
  SettingsSurface,
} from "./components";
import { ChatStyleScope } from "./chat-style-scope";
import { useJuggleChatStore } from "./store";

export function JuggleChatApp({ sidebarOpen = true, onToggleSidebar }: { sidebarOpen?: boolean; onToggleSidebar?: () => void }) {
  const bootstrap = useJuggleChatStore((state) => state.bootstrap);
  const status = useJuggleChatStore((state) => state.status);
  const user = useJuggleChatStore((state) => state.user);
  const view = useJuggleChatStore((state) => state.view);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  let content;
  if (!user && (status === "signed-out" || status === "idle")) {
    content = <div className="jw-im-root tyn-root tyn-web-root"><LoginScreen /></div>;
  } else if (status === "idle" || status === "initializing") {
    content = <div className="jw-im-root tyn-root tyn-web-root jw-im-boot"><LoaderCircle className="is-spinning" /><span>正在初始化 JuggleChat…</span></div>;
  } else if (!user) {
    content = <div className="jw-im-root tyn-root tyn-web-root"><LoginScreen /></div>;
  } else {
    content = (
      <div className={`jw-im-root tyn-root tyn-web-root${sidebarOpen ? "" : " is-list-collapsed"}`}>
        {onToggleSidebar ? (
          <button
            type="button"
            className="jw-im-sidebar-toggle"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? "折叠左侧区域" : "展开左侧区域"}
            title={sidebarOpen ? "折叠左侧区域" : "展开左侧区域"}
            aria-expanded={sidebarOpen}
            data-testid="chat-sidebar-trigger"
          >
            <PanelLeftIcon />
          </button>
        ) : null}
        <ConnectionBanner />
        <CallOverlay />
        {view === "conversations" || view === "settings" || view === "favorites" ? <div className="jw-im-conversation-layout tyn-content show-content"><ConversationList /><ConversationSurface /></div> : null}
        {view === "contacts" ? <ContactsSurface /> : null}
        {view === "favorites" ? <FavoritesSurface /> : null}
        {view === "settings" ? <SettingsSurface /> : null}
      </div>
    );
  }

  return <ChatStyleScope>{content}</ChatStyleScope>;
}
