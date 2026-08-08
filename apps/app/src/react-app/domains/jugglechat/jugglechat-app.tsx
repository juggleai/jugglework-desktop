/** @jsxImportSource react */
import { useEffect, type PointerEventHandler } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { t } from "@/i18n";

import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";

import {
  ConnectionBanner,
  CallOverlay,
  ContactsSurface,
  ConversationList,
  ConversationSurface,
  FavoritesSurface,
  SettingsSurface,
} from "./components";
import { ChatStyleScope } from "./chat-style-scope";
import { useJuggleChatStore } from "./store";

export function JuggleChatApp({
  sidebarOpen = true,
  sidebarResizing = false,
  onStartSidebarResize,
  onToggleSidebar,
}: {
  sidebarOpen?: boolean;
  sidebarResizing?: boolean;
  onStartSidebarResize?: PointerEventHandler<HTMLButtonElement>;
  onToggleSidebar?: () => void;
}) {
  const bootstrap = useJuggleChatStore((state) => state.bootstrap);
  const status = useJuggleChatStore((state) => state.status);
  const error = useJuggleChatStore((state) => state.error);
  const user = useJuggleChatStore((state) => state.user);
  const view = useJuggleChatStore((state) => state.view);
  const denAuth = useDenAuth();

  useEffect(() => {
    if (denAuth.status === "checking") return;
    void bootstrap(denAuth.user);
  }, [bootstrap, denAuth.status, denAuth.user]);

  let content;
  if (denAuth.status === "checking" || status === "idle" || status === "initializing") {
    content = <div className="jw-im-root tyn-root tyn-web-root jw-im-boot"><LoaderCircle className="is-spinning" /><span>{t("chat.initializing")}</span></div>;
  } else if (!user) {
    content = <div className="jw-im-root tyn-root tyn-web-root jw-im-boot"><CircleAlert /><span>{error || t("chat.sign_in_required")}</span></div>;
  } else {
    content = (
      <div className={`jw-im-root tyn-root tyn-web-root${sidebarOpen ? "" : " is-list-collapsed"}${sidebarResizing ? " is-list-resizing" : ""}`}>
        {sidebarOpen && onStartSidebarResize ? (
          <button
            type="button"
            className="jw-im-list-resize-handle"
            aria-label={t("chat.resize_list")}
            title={t("chat.resize_list_hint")}
            onClick={(event) => event.preventDefault()}
            onPointerDown={onStartSidebarResize}
          />
        ) : null}
        <ConnectionBanner />
        <CallOverlay />
        {view === "conversations" || view === "settings" || view === "favorites" ? <div className="jw-im-conversation-layout tyn-content show-content"><ConversationList sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} /><ConversationSurface sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} /></div> : null}
        {view === "contacts" ? <ContactsSurface sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} /> : null}
        {view === "favorites" ? <FavoritesSurface /> : null}
        {view === "settings" ? <SettingsSurface /> : null}
      </div>
    );
  }

  return <ChatStyleScope>{content}</ChatStyleScope>;
}
