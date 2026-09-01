/** @jsxImportSource react */
import * as React from "react";

import type {
  DesktopRemoteControlAgentStatus,
  DesktopRemoteControlReregisterResult,
  DesktopRemoteControlPolicyScope,
  DesktopRemoteControlSettings,
} from "@jugglework/types/desktop-ipc";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { Switch } from "@/components/ui/switch";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  desktopRemoteControlReregisterAndEnable,
  desktopRemoteControlSettingsRead,
  desktopRemoteControlSettingsUpdate,
  desktopRemoteControlStatusRead,
  desktopRemoteControlStopAll,
} from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/lib/runtime-env";
import { useCloudSession } from "./cloud-session-provider";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";
import {
  RefreshButton,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStatusBadge,
} from "../settings-section";

const disabledSettings: DesktopRemoteControlSettings = {
  schemaVersion: 1,
  enabled: false,
  preventSleepWhileWaiting: false,
  backgroundMode: false,
  launchAtLogin: false,
  allowBusySessionSteer: false,
  allowBusySessionEnqueue: false,
};

const stoppedStatus: DesktopRemoteControlAgentStatus = {
  schemaVersion: 1,
  state: "stopped",
  started: false,
  connected: false,
  enrolled: false,
  revoked: false,
  locallyDisabled: true,
  localControlEnabled: false,
  activeControlSessionCount: 0,
  controllerDisplayNames: [],
  lifecycleGeneration: 0,
  connectionGeneration: null,
  lastErrorCode: null,
  enrollmentAuthorized: false,
  replacementPending: false,
  replacementStatus: "idle",
  replacementErrorCode: null,
};

export function shouldShowRemoteControlReregister(input: {
  signedIn: boolean;
  policyAllowsRemote: boolean;
  settings: DesktopRemoteControlSettings;
  status: DesktopRemoteControlAgentStatus;
}) {
  return input.signedIn && input.policyAllowsRemote && !input.settings.enabled && input.status.locallyDisabled &&
    input.status.enrollmentAuthorized && !input.status.replacementPending;
}

export async function requestRemoteControlReregistration(input: {
  refreshFresh: () => Promise<{ config: { desktopRemoteFeatureGates?: { schemaVersion: number; enrollment: boolean; readOnlyControl: boolean } }; scope: DesktopRemoteControlPolicyScope }>;
  currentScope: () => DesktopRemoteControlPolicyScope | null;
  createEnrollmentGrant: () => Promise<{ grant: string }>;
  reregisterAndEnable: (input: { grant: string; scope: DesktopRemoteControlPolicyScope }) => Promise<DesktopRemoteControlReregisterResult>;
}) {
  const fresh = await input.refreshFresh();
  const gates = fresh.config.desktopRemoteFeatureGates;
  if (gates?.schemaVersion !== 1 || !gates.enrollment || !gates.readOnlyControl) {
    throw new Error("当前组织尚未启用 Desktop 注册和只读远程控制。");
  }
  const matchesScope = () => {
    const current = input.currentScope();
    return current?.controlPlaneBaseUrl === fresh.scope.controlPlaneBaseUrl && current.userId === fresh.scope.userId &&
      current.organizationId === fresh.scope.organizationId;
  };
  if (!matchesScope()) throw new Error("Remote-control account or organization changed.");
  const enrollmentGrant = await input.createEnrollmentGrant();
  if (!matchesScope()) throw new Error("Remote-control account or organization changed.");
  return input.reregisterAndEnable({ grant: enrollmentGrant.grant, scope: fresh.scope });
}

function statusPresentation(status: DesktopRemoteControlAgentStatus) {
  if (status.connected) return { label: t("settings.remote_control.status_connected"), tone: "ready" as const };
  if (status.state === "connecting" || status.state === "awaiting_welcome" || status.state === "backoff") {
    return { label: t("settings.remote_control.status_connecting"), tone: "warning" as const };
  }
  if (status.revoked || status.state === "revoked") return { label: "已撤销", tone: "error" as const };
  if (status.enrolled) return { label: t("settings.remote_control.status_offline"), tone: "warning" as const };
  if (status.state === "error") return { label: "异常", tone: "error" as const };
  return { label: t("settings.remote_control.status_unenrolled"), tone: "neutral" as const };
}

type RemoteControlActivityIndicatorProps = {
  status: DesktopRemoteControlAgentStatus;
  busy: boolean;
  onStopAll: () => void;
};

export function RemoteControlActivityIndicator({
  status,
  busy,
  onStopAll,
}: RemoteControlActivityIndicatorProps) {
  if (status.activeControlSessionCount > 0) {
    const controllers = status.controllerDisplayNames.join("、");
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-xs"
        data-testid="remote-control-active-indicator"
        role="status"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
        <span className="font-medium text-green-700 dark:text-green-400">{t("settings.remote_control.active")}</span>
        <span className="text-muted-foreground">
          {status.activeControlSessionCount} 个控制会话
          {controllers ? ` · 控制者：${controllers}` : ""}
        </span>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onStopAll}
        >
          {t("settings.remote_control.stop_all")}
        </Button>
      </div>
    );
  }
  if (!status.connected) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-dls-border p-3 text-xs text-muted-foreground"
      data-testid="remote-control-transport-connected"
      role="status"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
      <span>{t("settings.remote_control.connected_idle")}</span>
    </div>
  );
}

export function DesktopRemoteControlSection() {
  const cloud = useCloudSession();
  const desktopConfig = useDesktopConfig();
  const [settings, setSettings] = React.useState<DesktopRemoteControlSettings>(disabledSettings);
  const [status, setStatus] = React.useState<DesktopRemoteControlAgentStatus>(stoppedStatus);
  const [busy, setBusy] = React.useState(false);
  const [reregisterPending, setReregisterPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const desktopRuntime = isDesktopRuntime();
  const gates = desktopConfig.config.desktopRemoteFeatureGates;
  const policyAllowsRemote = gates?.schemaVersion === 1 && gates.enrollment === true && gates.readOnlyControl === true;
  const presentation = statusPresentation(status);

  const refresh = React.useCallback(async () => {
    if (!desktopRuntime) return;
    const [nextSettings, nextStatus] = await Promise.all([
      desktopRemoteControlSettingsRead(),
      desktopRemoteControlStatusRead(),
    ]);
    setSettings(nextSettings);
    setStatus(nextStatus);
  }, [desktopRuntime]);

  React.useEffect(() => {
    void refresh().catch(() => undefined);
    if (!desktopRuntime) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [desktopRuntime, refresh]);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (!enabled) {
        await desktopRemoteControlStopAll();
      } else {
        await desktopRemoteControlSettingsUpdate({ enabled: true });
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新本机远程控制设置。");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const setSetting = async (key: "preventSleepWhileWaiting" | "backgroundMode" | "launchAtLogin" | "allowBusySessionSteer" | "allowBusySessionEnqueue", value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await desktopRemoteControlSettingsUpdate({ [key]: value });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新设置。");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const reregisterAndEnable = async () => {
    const organizationId = cloud.activeOrganization?.id;
    if (!cloud.user?.id || !organizationId) {
      setError("请先登录 Cloud 并选择一个组织。");
      return;
    }
    setBusy(true);
    setReregisterPending(true);
    setError(null);
    setSuccess(null);
    try {
      // refreshFresh resolves only after Main has accepted the same fresh
      // policy context, so the one-time grant cannot race context sync.
      const result = await requestRemoteControlReregistration({
        refreshFresh: desktopConfig.refreshFresh,
        currentScope: cloud.getCurrentScope,
        createEnrollmentGrant: () => cloud.client.createDesktopRemoteEnrollmentGrant(organizationId),
        reregisterAndEnable: desktopRemoteControlReregisterAndEnable,
      });
      setStatus(result.status);
      setSettings(await desktopRemoteControlSettingsRead());
      if (!result.ok) throw new Error(result.error.message);
      setSuccess(t("settings.remote_control.reregister_success"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.remote_control.reregister_failed"));
      await refresh().catch(() => undefined);
    } finally {
      setReregisterPending(false);
      setBusy(false);
    }
  };

  if (!desktopRuntime) return null;
  const showReregister = !reregisterPending && shouldShowRemoteControlReregister({
    signedIn: cloud.isSignedIn,
    policyAllowsRemote,
    settings,
    status,
  });

  return (
    <SettingsSection>
      <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              Desktop 远程控制
              <SettingsStatusBadge tone={presentation.tone} label={presentation.label} />
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              允许此 Desktop 通过出站加密连接向当前组织报告在线状态，并在未来接收已授权的远程操作。
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
          <RefreshButton busy={busy} onRefresh={refresh} disabled={busy}>刷新状态</RefreshButton>
      </SettingsSectionHeader>

      <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>允许本机远程控制</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              这是 Main 进程持久化的本机安全开关。关闭时会立即断开远程连接。
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
               <Switch
                 checked={settings.enabled}
                 disabled={busy || !settings.enabled}
                onCheckedChange={(checked) => void setEnabled(checked)}
                aria-label="允许本机远程控制"
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
      </LayoutSectionItem>

      {!policyAllowsRemote ? (
        <SettingsNotice tone="error">当前 Cloud 策略未同时启用设备注册和只读远程控制。</SettingsNotice>
      ) : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {success ? <SettingsNotice>{success}</SettingsNotice> : null}
      {reregisterPending || status.replacementPending ? (
        <SettingsNotice>{t("settings.remote_control.reregister_pending")}</SettingsNotice>
      ) : null}
      {status.lastErrorCode ? (
        <SettingsNotice tone="error">最近错误：{status.lastErrorCode}</SettingsNotice>
      ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {showReregister ? (
            <Button
              data-testid="remote-control-reregister"
              onClick={() => void reregisterAndEnable()}
              disabled={busy || !cloud.activeOrganization}
            >
              {t("settings.remote_control.reregister")}
            </Button>
          ) : null}
          {settings.enabled && status.enrolled && !status.connected ? (
            <Button variant="outline" onClick={() => void setEnabled(true)} disabled={busy || !policyAllowsRemote}>
              重新连接
            </Button>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-xl border border-dls-border p-3 text-xs text-muted-foreground md:grid-cols-4">
          <span>状态：{status.state}</span>
          <span>已注册：{status.enrolled ? "是" : "否"}</span>
          <span>连接：{status.connected ? "传输已连接" : "离线"}</span>
          <span>Generation：{status.connectionGeneration ?? "—"}</span>
        </div>

        <RemoteControlActivityIndicator
          status={status}
          busy={busy}
          onStopAll={() => void setEnabled(false)}
        />

        <div className="flex items-center gap-4 rounded-xl border border-dls-border p-3">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={settings.preventSleepWhileWaiting}
              disabled={busy || !settings.enabled}
              onCheckedChange={(checked) => void setSetting("preventSleepWhileWaiting", checked)}
              aria-label="等待远程任务时不休眠"
            />
            <span>等待远程任务时不休眠</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={settings.backgroundMode}
              disabled={busy || !settings.enabled}
              onCheckedChange={(checked) => void setSetting("backgroundMode", checked)}
              aria-label="关闭窗口时保持后台运行"
            />
            <span>关闭窗口时保持运行</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={settings.launchAtLogin}
              disabled={busy || !settings.enabled}
              onCheckedChange={(checked) => void setSetting("launchAtLogin", checked)}
              aria-label="开机自动启动"
            />
            <span>开机自动启动</span>
          </label>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-dls-border p-3">
          <p className="text-xs text-muted-foreground">运行中会话能力默认关闭，需要 Cloud 策略和本机授权同时允许。</p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={settings.allowBusySessionSteer}
                disabled={busy || !settings.enabled || gates?.busySessionSteer !== true}
                onCheckedChange={(checked) => void setSetting("allowBusySessionSteer", checked)}
                aria-label="允许远程 steer 运行中会话"
              />
              <span>允许远程 steer</span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={settings.allowBusySessionEnqueue}
                disabled={busy || !settings.enabled || gates?.busySessionEnqueue !== true}
                onCheckedChange={(checked) => void setSetting("allowBusySessionEnqueue", checked)}
                aria-label="允许远程持久排队"
              />
              <span>允许远程排队</span>
            </label>
          </div>
        </div>
    </SettingsSection>
  );
}
