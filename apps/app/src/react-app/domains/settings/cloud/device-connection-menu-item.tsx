import { useEffect, useRef, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import {
  desktopRemoteControlReregisterAndEnable,
  desktopRemoteControlSettingsRead,
  desktopRemoteControlSettingsUpdate,
  desktopRemoteControlStatusRead,
  desktopRemoteControlStopAll,
} from "@/app/lib/desktop";
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudSession } from "./cloud-session-provider";
import { requestRemoteControlReregistration } from "./desktop-remote-control-section";

const connectionSettings = {
  enabled: true,
  preventSleepWhileWaiting: true,
  backgroundMode: false,
  launchAtLogin: false,
  allowBusySessionSteer: false,
  allowBusySessionEnqueue: false,
} as const;

export async function enableDeviceConnection(input: {
  refreshFresh: ReturnType<typeof useDesktopConfig>["refreshFresh"];
  currentScope: ReturnType<typeof useCloudSession>["getCurrentScope"];
  readStatus: typeof desktopRemoteControlStatusRead;
  updateSettings: typeof desktopRemoteControlSettingsUpdate;
  createEnrollmentGrant: (organizationId: string) => Promise<{ grant: string }>;
  reregisterAndEnable: typeof desktopRemoteControlReregisterAndEnable;
}) {
  const fresh = await input.refreshFresh();
  const gates = fresh.config.desktopRemoteFeatureGates;
  if (gates?.schemaVersion !== 1 || !gates.enrollment || !gates.readOnlyControl) {
    throw new Error(t("account_menu.device_connection_policy"));
  }
  const status = await input.readStatus();
  const scope = input.currentScope();
  if (!scope || scope.userId !== fresh.scope.userId || scope.organizationId !== fresh.scope.organizationId ||
      scope.controlPlaneBaseUrl !== fresh.scope.controlPlaneBaseUrl) {
    throw new Error(t("account_menu.device_connection_failed"));
  }
  if (!status.enrollmentAuthorized || status.replacementPending) {
    throw new Error(t("account_menu.device_connection_failed"));
  }
  if (status.enrolled && !status.revoked && status.lastErrorCode !== "device_reregistration_required") {
    await input.updateSettings(connectionSettings);
    return;
  }
  // Replacement applies the same defaults in Main after clearing old settings.
  const result = await requestRemoteControlReregistration({
    refreshFresh: async () => fresh,
    currentScope: input.currentScope,
    createEnrollmentGrant: () => input.createEnrollmentGrant(fresh.scope.organizationId),
    reregisterAndEnable: input.reregisterAndEnable,
  });
  if (!result.ok) {
    const failure = result.status.replacementFailure;
    throw new Error(failure ? `${result.error.message} (${failure.stage} · ${failure.code})` : result.error.message);
  }
}

export function useDeviceConnection({ open, onSignIn }: { open: boolean; onSignIn: () => void }) {
  const cloud = useCloudSession();
  const config = useDesktopConfig();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!open || busy) return;
    let cancelled = false;
    const read = () => void desktopRemoteControlSettingsRead().then(
      (settings) => { if (!cancelled && !pending.current) setEnabled(settings.enabled); },
      () => { if (!cancelled && !pending.current) setEnabled(null); },
    );
    read();
    const timer = window.setInterval(read, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, busy]);

  async function toggle(next: boolean) {
    if (pending.current) return;
    if (next && !cloud.isSignedIn) { onSignIn(); return; }
    if (next && !cloud.activeOrganization) { toast.error(t("account_menu.device_connection_org")); return; }
    pending.current = true;
    setBusy(true);
    try {
      if (next) {
        await enableDeviceConnection({
          refreshFresh: config.refreshFresh,
          currentScope: cloud.getCurrentScope,
          readStatus: desktopRemoteControlStatusRead,
          updateSettings: desktopRemoteControlSettingsUpdate,
          createEnrollmentGrant: (id) => cloud.client.createDesktopRemoteEnrollmentGrant(id),
          reregisterAndEnable: desktopRemoteControlReregisterAndEnable,
        });
      } else {
        await desktopRemoteControlStopAll();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("account_menu.device_connection_failed"));
    } finally {
      setEnabled(await desktopRemoteControlSettingsRead().then((settings) => settings.enabled, () => null));
      pending.current = false;
      setBusy(false);
    }
  }

  return { enabled, busy, toggle };
}

export function DeviceConnectionMenuItem({ enabled, busy, toggle }: ReturnType<typeof useDeviceConnection>) {
  return (
    <DropdownMenuCheckboxItem
      checked={enabled === true}
      disabled={busy || enabled === null}
      aria-busy={busy}
      closeOnClick={false}
      onCheckedChange={(next) => void toggle(next)}
      data-testid="account-menu-device-connection"
      className="pe-3 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
    >
      <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden="true" />
      <span>{t("account_menu.device_connection")}</span>
      <span aria-hidden="true" className={cn("ms-auto flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors", enabled ? "bg-dls-accent" : "bg-foreground/20")}>
        <span className={cn("size-3 rounded-full bg-white shadow-sm transition-transform", enabled && "translate-x-3 rtl:-translate-x-3")} />
      </span>
    </DropdownMenuCheckboxItem>
  );
}
