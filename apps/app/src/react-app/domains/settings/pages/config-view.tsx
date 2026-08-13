/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { buildDiagnosticsBundleJson } from "../../../../app/lib/diagnostics-bundle";
import {
  buildJuggleWorkWorkspaceBaseUrl,
  parseJuggleWorkWorkspaceIdFromUrl,
  type JuggleWorkServerSettings,
  type JuggleWorkServerStatus,
} from "../../../../app/lib/jugglework-server";
import type { JuggleWorkServerInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import {
  ConfigDiagnosticsSection,
  ConfigEngineReloadSection,
  ConfigServerConnectionSection,
  ConfigServerSharingSection,
  ConfigWorkspaceSummary,
} from "./config-view-sections";
import { configLocalReducer, initialConfigLocalState } from "./config-view-state";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  juggleworkServerStatus: JuggleWorkServerStatus;
  juggleworkServerUrl: string;
  juggleworkServerSettings: JuggleWorkServerSettings;
  juggleworkServerHostInfo: JuggleWorkServerInfo | null;
  runtimeWorkspaceId: string | null;

  updateJuggleWorkServerSettings: (next: JuggleWorkServerSettings) => void;
  resetJuggleWorkServerSettings: () => void;
  testJuggleWorkServerConnection: (
    next: JuggleWorkServerSettings,
  ) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;

  developerMode: boolean;
};

export function ConfigView(props: ConfigViewProps) {
  const [localState, dispatchLocal] = useReducer(
    configLocalReducer,
    initialConfigLocalState,
  );
  const { juggleworkConnection, tokenVisible, copyingField } = localState;
  const juggleworkUrl = juggleworkConnection.url;
  const juggleworkToken = juggleworkConnection.token;
  const juggleworkTestState = juggleworkConnection.testState;
  const juggleworkTestMessage = juggleworkConnection.testMessage;
  const copyTimeoutRef = useRef<number | undefined>(undefined);
  const [diagnosticsBundleJson, setDiagnosticsBundleJson] = useState("");

  useEffect(() => {
    dispatchLocal({
      type: "serverSettings",
      connection: {
        url: props.juggleworkServerSettings.urlOverride ?? "",
        token: props.juggleworkServerSettings.token ?? "",
        testState: "idle",
        testMessage: null,
      },
    });
  }, [props.juggleworkServerSettings]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const juggleworkStatusLabel = (() => {
    switch (props.juggleworkServerStatus) {
      case "connected":
        return t("config.status_connected");
      case "limited":
        return t("config.status_limited");
      default:
        return t("config.status_not_connected");
    }
  })();

  const juggleworkStatusStyle = (() => {
    switch (props.juggleworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  })();

  const reloadAvailabilityReason = (() => {
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) return t("config.reload_availability_hint");
    return null;
  })();

  const reloadButtonLabel = props.reloadBusy
    ? t("config.reloading")
    : t("config.reload_engine");
  const reloadButtonTone: "destructive" | "secondary" = props.anyActiveRuns
    ? "destructive"
    : "secondary";
  const reloadButtonDisabled =
    props.reloadBusy || Boolean(reloadAvailabilityReason);

  const buildJuggleWorkSettings = (): JuggleWorkServerSettings => ({
    ...props.juggleworkServerSettings,
    urlOverride: juggleworkUrl.trim() || undefined,
    token: juggleworkToken.trim() || undefined,
  });

  const hasJuggleWorkChanges = (() => {
    const currentUrl = props.juggleworkServerSettings.urlOverride ?? "";
    const currentToken = props.juggleworkServerSettings.token ?? "";
    return (
      juggleworkUrl.trim() !== currentUrl || juggleworkToken.trim() !== currentToken
    );
  })();

  const resolvedWorkspaceId = (() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseJuggleWorkWorkspaceIdFromUrl(juggleworkUrl) ?? "";
  })();

  const resolvedWorkspaceUrl = (() => {
    const baseUrl = juggleworkUrl.trim();
    if (!baseUrl) return "";
    return buildJuggleWorkWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId) ?? baseUrl;
  })();

  const hostInfo = props.juggleworkServerHostInfo;
  const hostRemoteAccessEnabled = hostInfo?.remoteAccessEnabled === true;
  const hostStatusLabel = !hostInfo?.running
    ? t("config.host_offline")
    : hostRemoteAccessEnabled
      ? t("config.host_remote_enabled")
      : t("config.host_local_only");
  const hostStatusStyle = !hostInfo?.running
    ? "bg-gray-4/60 text-gray-11 border-gray-7/50"
    : "bg-green-7/10 text-green-11 border-green-7/20";
  const hostConnectUrl =
    hostInfo?.connectUrl ??
    hostInfo?.mdnsUrl ??
    hostInfo?.lanUrl ??
    hostInfo?.baseUrl ??
    "";
  const hostConnectUrlUsesMdns = hostConnectUrl.includes(".local");

  const buildCurrentDiagnosticsBundle = useCallback(() => {
    return buildDiagnosticsBundleJson({
      anyActiveRuns: props.anyActiveRuns,
      canReloadWorkspace: props.canReloadWorkspace,
      clientConnected: props.clientConnected,
      developerMode: props.developerMode,
      hostConnectUrl,
      hostConnectUrlUsesMdns,
      hostInfo,
      juggleworkServerStatus: props.juggleworkServerStatus,
      juggleworkServerUrl: props.juggleworkServerUrl,
      runtimeWorkspaceId: props.runtimeWorkspaceId,
      agentRuntimeEndpoint: props.juggleworkServerUrl.trim() && resolvedWorkspaceId ? {
        baseUrl: props.juggleworkServerUrl,
        workspaceId: resolvedWorkspaceId,
        token: props.juggleworkServerSettings.token?.trim() || undefined,
      } : null,
    });
  }, [
    hostConnectUrl,
    hostConnectUrlUsesMdns,
    hostInfo,
    props.anyActiveRuns,
    props.canReloadWorkspace,
    props.clientConnected,
    props.developerMode,
    props.juggleworkServerSettings.hostToken,
    props.juggleworkServerSettings.token,
    props.juggleworkServerSettings.urlOverride,
    props.juggleworkServerStatus,
    props.juggleworkServerUrl,
    props.runtimeWorkspaceId,
    resolvedWorkspaceId,
  ]);

  useEffect(() => {
    let cancelled = false;
    void buildCurrentDiagnosticsBundle().then((json) => {
      if (!cancelled) {
        setDiagnosticsBundleJson(json);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [buildCurrentDiagnosticsBundle]);

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      dispatchLocal({ type: "copyingField", field });
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        dispatchLocal({ type: "copyingField", field: null });
        copyTimeoutRef.current = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyDiagnostics = async (_value: string, field: string) => {
    const json = await buildCurrentDiagnosticsBundle();
    setDiagnosticsBundleJson(json);
    await handleCopy(json, field);
  };

  const handleTestConnection = async () => {
    if (juggleworkTestState === "testing") return;
    const next = buildJuggleWorkSettings();
    props.updateJuggleWorkServerSettings(next);
    dispatchLocal({
      type: "testState",
      testState: "testing",
      testMessage: null,
    });
    try {
      const ok = await props.testJuggleWorkServerConnection(next);
      dispatchLocal({
        type: "testState",
        testState: ok ? "success" : "error",
        testMessage: ok
          ? t("config.connection_successful")
          : t("config.connection_failed"),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("config.connection_failed_check");
      dispatchLocal({
        type: "testState",
        testState: "error",
        testMessage: message,
      });
    }
  };

  return (
    <section className="space-y-6 max-w-3xl w-full">
      <ConfigWorkspaceSummary runtimeWorkspaceId={props.runtimeWorkspaceId} />
      <ConfigEngineReloadSection
        anyActiveRuns={props.anyActiveRuns}
        reloadBusy={props.reloadBusy}
        reloadAvailabilityReason={reloadAvailabilityReason}
        reloadButtonTone={reloadButtonTone}
        reloadButtonDisabled={reloadButtonDisabled}
        reloadButtonLabel={reloadButtonLabel}
        onReload={props.reloadWorkspaceEngine}
      />
      {props.developerMode ? (
        <ConfigDiagnosticsSection
          busy={props.busy}
          diagnosticsBundleJson={diagnosticsBundleJson}
          copyingField={copyingField}
          onCopy={handleCopyDiagnostics}
        />
      ) : null}
      {hostInfo ? (
        <ConfigServerSharingSection
          hostInfo={hostInfo}
          hostConnectUrl={hostConnectUrl}
          hostRemoteAccessEnabled={hostRemoteAccessEnabled}
          hostConnectUrlUsesMdns={hostConnectUrlUsesMdns}
          hostStatusLabel={hostStatusLabel}
          hostStatusStyle={hostStatusStyle}
          tokenVisible={tokenVisible}
          copyingField={copyingField}
          onCopy={handleCopy}
          onToggleToken={(key) => dispatchLocal({ type: "toggleToken", key })}
        />
      ) : null}
      <ConfigServerConnectionSection
        busy={props.busy}
        juggleworkUrl={juggleworkUrl}
        juggleworkToken={juggleworkToken}
        tokenVisible={tokenVisible.jugglework}
        juggleworkStatusLabel={juggleworkStatusLabel}
        juggleworkStatusStyle={juggleworkStatusStyle}
        resolvedWorkspaceUrl={resolvedWorkspaceUrl}
        resolvedWorkspaceId={resolvedWorkspaceId}
        juggleworkTestState={juggleworkTestState}
        juggleworkTestMessage={juggleworkTestMessage}
        hasJuggleWorkChanges={hasJuggleWorkChanges}
        onUrlChange={(url) => dispatchLocal({ type: "url", url })}
        onTokenChange={(token) => dispatchLocal({ type: "token", token })}
        onToggleToken={() => dispatchLocal({ type: "toggleToken", key: "jugglework" })}
        onTestConnection={handleTestConnection}
        onSave={() => props.updateJuggleWorkServerSettings(buildJuggleWorkSettings())}
        onReset={props.resetJuggleWorkServerSettings}
      />
      {!isDesktopRuntime() ? <div className="text-xs text-gray-9">{t("config.desktop_only_hint")}</div> : null}
    </section>
  );
}
