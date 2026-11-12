import { rememberCloudDocsOrigin } from "./product-view";
import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { t, currentLocale } from "@/i18n";
import { getResolvedThemeMode } from "@/app/theme";
import { createDenClient, readDenSettings, readDenUserId, denCredentialFingerprint, isCurrentDenSessionRevocation } from "@/app/lib/den";
import {
  cloudDocTabKey, cloudDocTabsSnapshot, registerCloudDocTabCloser, subscribeCloudDocTabs, type CloudDocTab, type CloudDocHighlight,
} from "@/app/lib/cloud-doc-tabs";
import { useCloudDocsBounds } from "./use-cloud-docs-bounds";
import { setActiveCloudDoc } from "@/app/lib/cloud-doc-turn";
import { useFilesPanelSession } from "../session/files/files-panel-store";
import { denSettingsChangedEvent, denSessionUpdatedEvent, denSessionRevokedEvent } from "@/app/lib/den-session-events";

/** 已访问标签保留原生 product 视图；切换只改变可见区域，关闭标签或授权边界改变才释放。 */
function CloudDocView({ tab, highlight, sessionId, active }: { tab: CloudDocTab; highlight?: CloudDocHighlight; sessionId: string; active: boolean }) {
  const host = React.useRef<HTMLDivElement>(null);
  const nativeBounds = useCloudDocsBounds(host);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const updateLayout = React.useRef<() => void>(() => {});
  React.useLayoutEffect(() => { updateLayout.current(); }, [active]);
  const highlightRef = React.useRef(highlight);
  highlightRef.current = highlight;
  const instanceRef = React.useRef<{ id: string; ready: boolean } | null>(null);
  const documentRef = React.useRef<{workspaceId: string; docId: string} | null>(null);
  const applyHighlight = React.useCallback(() => {
    const current = instanceRef.current;
    const target = highlightRef.current;
    if (activeRef.current && current?.ready && target && documentRef.current && target.workspaceId === documentRef.current.workspaceId && target.docId === documentRef.current.docId)
      window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.highlightBlocks({ instanceId: current.id, docId: target.docId, blockIds: target.blockIds });
  }, [tab.workspaceId, tab.docId]);
  React.useEffect(applyHighlight, [highlight?.requestId, applyHighlight]);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = React.useState("");
  const [liveDoc, setLiveDoc] = React.useState<{ tenantId: string; workspaceId: string; docId: string; title: string } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    setActiveCloudDoc(sessionId, state === 'ready' ? liveDoc : null);
    return () => setActiveCloudDoc(sessionId, null);
  }, [active, state, liveDoc, sessionId]);
  React.useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const settings = readDenSettings();
    const sourceUserId = readDenUserId();
    const instanceId = crypto.randomUUID();
    instanceRef.current = { id: instanceId, ready: false };
    let disposed = false;
    let ready = false;
    let released = false;
    setState("loading");
    if (!bridge || !settings.authToken || !sourceUserId) { setState("error"); setMessage(t("cloud_docs.desktop_required")); return; }
    if (settings.activeOrgId !== tab.tenantId) { setState("error"); setMessage(t("cloud_docs.other_organization")); return; }
    const unregisterCloser = registerCloudDocTabCloser(sessionId, cloudDocTabKey(tab), async () => {
      const result = await bridge.close(instanceId);
      released = result.closed;
      return released;
    });
    const bounds = () => {
      nativeBounds.sync(instanceId, ready, activeRef.current);
    };
    const appearance = () => {
      if (!ready || !host.current) return;
      const styles = getComputedStyle(host.current);
      const color = (token: string, fallback: string) => { const v = styles.getPropertyValue(token).trim(); return CSS.supports("color", v) ? v : fallback; };
      const dark = getResolvedThemeMode() === "dark";
      bridge.setAppearance({ instanceId, appearance: { theme: dark ? "dark" : "light", locale: currentLocale(), fontFamily: styles.fontFamily, colors: {
        background: color("--background", dark ? "#111113" : "#ffffff"), foreground: color("--foreground", dark ? "#edeef0" : "#1c2024"),
        sidebar: color("--dls-sidebar", dark ? "#18191b" : "#f7f7f7"), border: color("--dls-border", dark ? "#303136" : "#e5e7eb"),
        muted: color("--muted-foreground", dark ? "#a0a0a0" : "#6b7280"), accent: color("--dls-accent", dark ? "#e5e7eb" : "#011627"),
        accentForeground: color("--dls-accent-fg", dark ? "#111113" : "#ffffff") } } });
    };
    updateLayout.current = () => {
      bounds();
      if (ready && activeRef.current) {
        appearance();
        applyHighlight();
        bridge.layoutCommand({ instanceId, action: "request-state" });
      }
    };
    const unsubscribe = bridge.onState(value => {
      if (disposed || value.instanceId !== instanceId) return;
      ready = value.status === "ready";
      documentRef.current = !ready || value.docId === null ? null : value.docId && value.workspaceId ? {workspaceId:value.workspaceId,docId:value.docId} : {workspaceId:tab.workspaceId,docId:tab.docId};
      setLiveDoc(!ready || value.docId === null ? null : value.docId && value.workspaceId
        ? {tenantId: tab.tenantId, workspaceId: value.workspaceId, docId: value.docId, title: value.title || ''}
        : {tenantId: tab.tenantId, workspaceId: tab.workspaceId, docId: tab.docId, title: tab.title});
      instanceRef.current = { id: instanceId, ready };
      applyHighlight();
      setState(value.status === "ready" ? "ready" : value.status === "loading" ? "loading" : "error");
      if (value.status !== "ready" && value.status !== "loading") setMessage(t(value.status === "unauthorized" ? "cloud_docs.no_access" : "cloud_docs.connection_failed"));
      bounds(); appearance();
      if (ready && activeRef.current) bridge.layoutCommand({ instanceId, action: "request-state" });
    });
    let collapsing = false;
    const stopLayout = bridge.onLayout(value => {
      if (disposed || !activeRef.current || value.instanceId !== instanceId) return;
      // TIPS: 就绪事件可以重复，必须按真实状态收起，不能每次直接切换。
      if (!value.layout.leftOpen) collapsing = false;
      else if (!collapsing && (host.current?.clientWidth ?? 1000) < 720) {
        collapsing = true;
        bridge.layoutCommand({ instanceId, action: "toggle-left" });
      }
    });
    const stopReference = bridge.onAiReference(reference => {
      if (activeRef.current && reference.instanceId === instanceId && reference.tenantId === tab.tenantId)
        window.dispatchEvent(new CustomEvent("jugglework:cloud-doc-reference", { detail: { sessionId, reference } }));
    });
    const resize = new ResizeObserver(() => {
      bounds();
      if (ready && activeRef.current) bridge.layoutCommand({ instanceId, action: "request-state" });
    });
    if (host.current) resize.observe(host.current);
    window.addEventListener("resize", bounds);
    document.addEventListener("visibilitychange", bounds);
    // TIPS: 授权完成时菜单可能尚未关闭，关闭后必须重新显示原生页。
    const overlays = new MutationObserver(bounds);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "hidden", "style"] });
    void (async () => {
      try {
        const launch = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken! }).launchCloudDocs({
          tenantId: tab.tenantId, target: { kind: "page", pageId: tab.docId, workspaceId: tab.workspaceId }, presentation: { instanceId, mode: "product" },
        });
        if (disposed) return;
        rememberCloudDocsOrigin(tab.tenantId, launch.bootstrapUrl);
        await bridge.open({ ...launch, instanceId, sourceServerOrigin: settings.baseUrl, sourceUserId, retain: true });
        bounds();
      } catch (error) {
        if (!disposed) { setState("error"); setMessage(error instanceof Error ? error.message : t("cloud_docs.connection_failed")); }
      }
    })();
    return () => {
      disposed = true;
      unregisterCloser();
      nativeBounds.sync(instanceId, false, false);
      updateLayout.current = () => {};
      instanceRef.current = null;
      resize.disconnect();
      overlays.disconnect();
      unsubscribe();
      stopLayout();
      stopReference();
      window.removeEventListener("resize", bounds);
      document.removeEventListener("visibilitychange", bounds);
      if (!released) void bridge.close(instanceId);
    };
  }, [sessionId, tab.tenantId, tab.workspaceId, tab.docId, applyHighlight]);
  return (
    <div className={active ? "absolute inset-0" : "hidden"} aria-hidden={!active || undefined}>
      <div ref={host} className="absolute inset-0" />
      {nativeBounds.snapshot && <img src={nativeBounds.snapshot} onLoad={nativeBounds.loaded} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-dls-secondary">
          {state === "loading" ? <><LoaderCircle className="size-4 animate-spin" />{t("cloud_docs.loading")}</> : message}
        </div>
      )}
    </div>
  );
}

/** 当前授权边界只用于实例生命周期，令牌以摘要参与比较，不持久化。 */
function readCredential() {
  const settings = readDenSettings();
  const userId = readDenUserId();
  return settings.authToken && userId && settings.activeOrgId
    ? { tenantId: settings.activeOrgId, key: JSON.stringify([settings.baseUrl, userId, settings.activeOrgId, denCredentialFingerprint(settings.authToken)]) }
    : null;
}

/** 未访问的标签不预加载；首次访问后保留，关闭标签时随宿主卸载释放。 */
function CloudDocSlot(props: React.ComponentProps<typeof CloudDocView>) {
  const [visited, setVisited] = React.useState(props.active);
  React.useEffect(() => { if (props.active) setVisited(true); }, [props.active]);
  return visited || props.active ? <CloudDocView {...props} /> : null;
}

/** 统一文件标签栏下的云文档内容区；仅当前标签可见，已访问的同组织标签保持在线实例。 */
export function CloudDocPanel({ sessionId }: { sessionId: string }) {
  const state = React.useSyncExternalStore(subscribeCloudDocTabs, () => cloudDocTabsSnapshot(sessionId));
  const files = useFilesPanelSession(sessionId);
  const [credential, setCredential] = React.useState(readCredential);
  React.useEffect(() => {
    const changed = () => setCredential(readCredential());
    const revoked = (event: Event) => { if (isCurrentDenSessionRevocation(event)) setCredential(null); };
    window.addEventListener(denSettingsChangedEvent, changed);
    window.addEventListener(denSessionUpdatedEvent, changed);
    window.addEventListener(denSessionRevokedEvent, revoked);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, changed);
      window.removeEventListener(denSessionUpdatedEvent, changed);
      window.removeEventListener(denSessionRevokedEvent, revoked);
    };
  }, []);
  const active = files.activeKey === "cloud" ? state.tabs.find(tab => cloudDocTabKey(tab) === state.active) ?? null : null;
  const allowed = active?.tenantId === credential?.tenantId;
  return <>
    {credential && state.tabs.filter(tab => tab.tenantId === credential.tenantId).map(tab =>
      <CloudDocSlot key={`${credential.key}/${cloudDocTabKey(tab)}`} tab={tab} highlight={state.highlight} sessionId={sessionId} active={tab === active} />)}
    {active && !allowed && <div className="absolute inset-0 flex items-center justify-center bg-background p-4 text-sm text-dls-secondary">{t("cloud_docs.other_organization")}</div>}
  </>;
}
