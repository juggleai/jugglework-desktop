import { useEffect } from "react";

import { createDenClient, denCredentialFingerprint, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { useOptionalDenAuth } from "../cloud/den-auth-provider";
import { rememberCloudDocsOrigin } from "./product-view";

/** 主工作台可交互且身份已确定后，交给 Main 尝试唯一一次云文档预热。 */
export function useCloudDocsWarmup(eligible: boolean) {
  const auth = useOptionalDenAuth();
  const userId = auth?.user?.id;
  const tenantId = auth?.activeOrganization?.id;
  const isSignedIn = auth?.isSignedIn;
  useEffect(() => {
    if (typeof window === "undefined" || !eligible || !isSignedIn || !userId || !tenantId) return;
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const settings = readDenSettings();
    const token = settings.authToken;
    if (!token || settings.activeOrgId !== tenantId || !bridge?.warmupReserve || !bridge.warmupCancel) return;
    const authority = {
      sourceServerOrigin: settings.baseUrl,
      sourceUserId: userId,
      tenantId,
      authFingerprint: denCredentialFingerprint(token),
    };
    const controller = new AbortController();
    let instanceId: string | undefined;
    let cancelledId: string | undefined;
    let idle: number | undefined;
    const stillCurrent = () => {
      const current = readDenSettings();
      return !controller.signal.aborted && current.authToken === token &&
        current.baseUrl === settings.baseUrl && current.activeOrgId === tenantId;
    };
    const cancel = () => {
      controller.abort();
      if (instanceId) void bridge.warmupCancel?.({ instanceId }).catch(() => {});
    };
    const authorityChanged = () => { if (!stillCurrent()) cancel(); };
    const unsubscribe = bridge.onWarmupCancelled?.(id => {
      cancelledId = id;
      if (instanceId === id) controller.abort();
    });
    const start = async () => {
      if (document.hidden || !stillCurrent()) return;
      try {
        const ticket = await bridge.warmupReserve!(authority);
        if (!ticket) return;
        instanceId = ticket.instanceId;
        if (cancelledId === instanceId) { controller.abort(); return; }
        if (!stillCurrent()) { cancel(); return; }
        const launchStarted = performance.now();
        const grant = await createDenClient({ baseUrl: settings.baseUrl, token }).launchCloudDocs({
          tenantId,
          target: ticket.target,
          presentation: { instanceId, mode: "product" },
        }, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
        if (!stillCurrent() || grant.tenantId !== tenantId || grant.presentation.instanceId !== instanceId ||
          grant.docsOrigin !== ticket.docsOrigin) {
          cancel();
          return;
        }
        await bridge.open({
          ...grant, ...authority, instanceId, warmup: true, fullPage: true, retain: true,
          startupLaunchMs: performance.now() - launchStarted,
        });
        if (stillCurrent()) rememberCloudDocsOrigin(tenantId, grant.bootstrapUrl);
      } catch {
        cancel();
      }
    };
    const timer = window.setTimeout(() => {
      idle = window.requestIdleCallback(() => void start());
    }, 2000);
    window.addEventListener(denSettingsChangedEvent, authorityChanged);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      unsubscribe?.();
      window.removeEventListener(denSettingsChangedEvent, authorityChanged);
      cancel();
    };
  }, [eligible, isSignedIn, userId, tenantId]);
}
