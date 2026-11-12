import * as React from "react";
import type { FileWindowTab } from "@jugglework/types/file-window";
import { useCloudDocsBounds } from "./use-cloud-docs-bounds";
import { setActiveCloudDoc, setFileCloudView } from "@/app/lib/cloud-doc-turn";
import { t, currentLocale } from "@/i18n";

/** 已由 Main 交接的原生页；只管理可见区域和本文件窗口会话，不持有 Work 登录凭据。 */
export function FileCloudDocView({
  tab,
  sessionId,
  active,
  appearance,
}: {
  tab: FileWindowTab;
  sessionId: string;
  active: boolean;
  appearance?: { theme: "light" | "dark"; lang?: string };
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const bounds = useCloudDocsBounds(host);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error" | "unauthorized">(
    "loading",
  );
  const ready = status === "ready";
  const [liveDoc, setLiveDoc] = React.useState<{
    workspaceId: string;
    docId: string;
    title: string;
  } | null>(null);
  const doc = tab.cloudDoc!;
  const visible = React.useRef(active);
  visible.current = active;
  React.useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    if (!bridge) return;
    let observed = false,
      disposed = false;
    const locate = (state: { workspaceId?: string; docId?: string | null; title?: string }) =>
      setLiveDoc(
        state.workspaceId && state.docId
          ? { workspaceId: state.workspaceId, docId: state.docId, title: state.title || "" }
          : null,
      );
    const stop = bridge.onState((state) => {
      if (state.instanceId === doc.instanceId) {
        observed = true;
        setStatus(state.status);
        locate(state);
      }
    });
    // TIPS: 先监听再读取快照；迟到的 loading 快照不能覆盖已经收到的 ready。
    void bridge
      .status?.(doc.instanceId)
      .then((state) => {
        if (!disposed && !observed) {
          setStatus(state.status ?? (state.ready ? "ready" : "loading"));
          locate(state);
        }
      })
      .catch(() => {
        if (!disposed && !observed) setStatus("error");
      });
    const reference = bridge.onAiReference((value) => {
      if (visible.current && value.instanceId === doc.instanceId && value.tenantId === doc.tenantId)
        window.dispatchEvent(
          new CustomEvent("jugglework:cloud-doc-reference", {
            detail: { sessionId, reference: value },
          }),
        );
    });
    return () => {
      disposed = true;
      stop();
      reference();
    };
  }, [doc.instanceId, doc.tenantId, sessionId]);
  React.useLayoutEffect(() => {
    const sync = () => bounds.sync(doc.instanceId, ready, active);
    const observer = new ResizeObserver(sync);
    if (host.current) observer.observe(host.current);
    const overlays = new MutationObserver(sync);
    overlays.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    window.addEventListener("resize", sync);
    sync();
    return () => {
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", sync);
      window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.setBounds({
        instanceId: doc.instanceId,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    };
  }, [active, ready, doc.instanceId, bounds.sync]);
  React.useEffect(() => {
    if (!active) return;
    setFileCloudView(
      ready
        ? { tenantId: doc.tenantId, instanceId: doc.instanceId, docsOrigin: doc.docsOrigin }
        : null,
    );
    setActiveCloudDoc(sessionId, ready && liveDoc ? { tenantId: doc.tenantId, ...liveDoc } : null);
    return () => {
      setFileCloudView(null);
      setActiveCloudDoc(sessionId, null);
    };
  }, [active, ready, doc.instanceId, sessionId, liveDoc]);
  React.useEffect(() => {
    if (!ready || !host.current) return;
    const style = getComputedStyle(host.current);
    const dark = appearance?.theme === "dark";
    window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.setAppearance({
      instanceId: doc.instanceId,
      appearance: {
        theme: dark ? "dark" : "light",
        locale: appearance?.lang ?? currentLocale(),
        fontFamily: style.fontFamily,
        colors: {
          background: dark ? "#111113" : "#fff",
          foreground: dark ? "#eee" : "#1c2024",
          sidebar: dark ? "#18191b" : "#f7f7f7",
          border: dark ? "#303136" : "#e5e7eb",
          muted: "#888",
          accent: dark ? "#eee" : "#011627",
          accentForeground: dark ? "#111" : "#fff",
        },
      },
    });
  }, [ready, appearance?.theme, appearance?.lang, doc.instanceId]);
  return (
    <div
      ref={host}
      style={{ position: "absolute", inset: 0, visibility: active ? "visible" : "hidden" }}
    >
      {!ready && (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {status === "loading" ? t("cloud_docs.loading") : t("cloud_docs.connection_failed")}
        </div>
      )}
      {bounds.snapshot && (
        <img
          src={bounds.snapshot}
          onLoad={bounds.loaded}
          alt=""
          className="absolute inset-0 size-full object-fill"
        />
      )}
    </div>
  );
}
