import { readDevLogs, type DevLogRecord } from "./dev-log";
import {
  appBuildInfo,
  engineInfo,
  juggleworkServerInfo,
  type AppBuildInfo,
  type EngineInfo,
  type JuggleWorkServerInfo,
} from "./desktop";
import { readPerfLogs, type PerfLogRecord } from "./perf-log";
import { sanitizeCloudMcpHealthDiagnostic } from "./diagnostic-sanitizer";
import {
  readJuggleWorkServerSettings,
  type JuggleWorkServerSettings,
  type JuggleWorkServerStatus,
} from "./jugglework-server";
import { isDesktopRuntime } from "../utils";
import { captureAnalyticsEvent } from "./analytics";
import { createCanonicalAgentClient } from "./agent-client";
import type { AgentRuntimeSupportDiagnostics } from "@jugglework/types/agent-runtime";

export type DiagnosticsBundleContext = {
  anyActiveRuns?: boolean;
  canReloadWorkspace?: boolean;
  clientConnected?: boolean;
  developerMode?: boolean;
  hostConnectUrl?: string;
  hostConnectUrlUsesMdns?: boolean;
  hostInfo?: JuggleWorkServerInfo | null;
  juggleworkServerStatus?: JuggleWorkServerStatus;
  juggleworkServerUrl?: string;
  runtimeWorkspaceId?: string | null;
  cloudMcpHealth?: unknown;
  agentRuntimeEndpoint?: { baseUrl: string; workspaceId: string; token?: string } | null;
};

export type DiagnosticsBundleInputs = {
  capturedAt: string;
  desktopRuntime: boolean;
  appInfo: AppBuildInfo | null;
  engineInfo: EngineInfo | null;
  juggleworkServerSettings: JuggleWorkServerSettings;
  hostInfo: JuggleWorkServerInfo | null;
  developerLogs: DevLogRecord[];
  perfLogs: PerfLogRecord[];
  context?: DiagnosticsBundleContext;
  cloudMcpHealth?: unknown;
};

function pickAppInfo(info: AppBuildInfo | null) {
  if (!info) return null;
  return {
    version: info.version,
    gitSha: info.gitSha ?? null,
    buildEpoch: info.buildEpoch ?? null,
    juggleworkDevMode: info.juggleworkDevMode ?? null,
  };
}

function pickEngineInfo(info: EngineInfo | null) {
  if (!info) return null;
  return {
    running: info.running,
    runtime: info.runtime,
    managedByServer: info.managedByServer,
    hostname: info.hostname,
    port: info.port,
    pid: info.pid,
    opencodeBinSource: info.opencodeBinSource,
    executionConfigured: info.execution !== null,
  };
}

function pickHostInfo(info: JuggleWorkServerInfo | null) {
  if (!info) return null;
  return {
    running: Boolean(info.running),
    remoteAccessEnabled: info.remoteAccessEnabled,
    endpointConfigured: Boolean(info.baseUrl || info.connectUrl || info.mdnsUrl || info.lanUrl),
  };
}

function defaultHostConnectUrl(hostInfo: JuggleWorkServerInfo | null) {
  return hostInfo?.connectUrl ?? hostInfo?.mdnsUrl ?? hostInfo?.lanUrl ?? hostInfo?.baseUrl ?? "";
}

function addSecretValue(secrets: string[], value: string | null | undefined) {
  const secret = value?.trim() ?? "";
  if (secret.length < 4 || secrets.includes(secret)) return;
  secrets.push(secret);
}

function collectSecretValues(input: DiagnosticsBundleInputs) {
  const secrets: string[] = [];
  addSecretValue(secrets, input.juggleworkServerSettings.token);
  addSecretValue(secrets, input.juggleworkServerSettings.hostToken);
  addSecretValue(secrets, input.hostInfo?.clientToken);
  addSecretValue(secrets, input.hostInfo?.ownerToken);
  addSecretValue(secrets, input.hostInfo?.hostToken);
  addSecretValue(secrets, input.engineInfo?.opencodePassword);
  return secrets;
}

function scrubKnownSecretValues(value: string, secrets: string[]) {
  let output = value;
  for (const secret of secrets) {
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function composeDiagnosticsBundleJson(input: DiagnosticsBundleInputs & { agentRuntimeSupport?: AgentRuntimeSupportDiagnostics | null }): string {
  const context = input.context;
  const urlOverride = input.juggleworkServerSettings.urlOverride?.trim() ?? "";
  const token = input.juggleworkServerSettings.token?.trim() ?? "";
  const hostConnectUrl = context?.hostConnectUrl ?? defaultHostConnectUrl(input.hostInfo);
  const hostConnectUrlUsesMdns = context?.hostConnectUrlUsesMdns ?? hostConnectUrl.includes(".local");
  const clientConnected = context?.clientConnected === true;
  const bundle = {
    capturedAt: input.capturedAt,
    app: pickAppInfo(input.appInfo),
    opencodeEngine: pickEngineInfo(input.engineInfo),
    runtime: {
      tauri: input.desktopRuntime,
      developerMode: context?.developerMode === true,
    },
    workspace: {
      runtimeWorkspaceSelected: Boolean(context?.runtimeWorkspaceId?.trim()),
      clientConnected,
      anyActiveRuns: context?.anyActiveRuns === true,
    },
    juggleworkServer: {
      status: context?.juggleworkServerStatus ?? (clientConnected ? "connected" : "disconnected"),
      urlConfigured: Boolean(context?.juggleworkServerUrl?.trim()),
      settings: {
        urlOverridePresent: Boolean(urlOverride),
        tokenPresent: Boolean(token),
      },
      host: pickHostInfo(input.hostInfo),
    },
    cloudMcp: sanitizeCloudMcpHealthDiagnostic(input.cloudMcpHealth ?? context?.cloudMcpHealth ?? null),
    agentRuntimeSupport: input.agentRuntimeSupport ?? null,
    reload: {
      canReloadWorkspace: context?.canReloadWorkspace === true,
    },
    sharing: {
      hostConnectUrlPresent: Boolean(hostConnectUrl),
      hostConnectUrlUsesMdns,
    },
    performance: {
      retainedEntries: input.perfLogs.length,
    },
    developerLogs: {
      retainedEntries: input.developerLogs.length,
    },
  };
  return scrubKnownSecretValues(JSON.stringify(bundle, null, 2), collectSecretValues(input));
}

async function readAppInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await appBuildInfo();
  } catch {
    return null;
  }
}

async function readEngineInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await engineInfo();
  } catch {
    return null;
  }
}

async function readHostInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await juggleworkServerInfo();
  } catch {
    return null;
  }
}

export async function buildDiagnosticsBundleJson(context?: DiagnosticsBundleContext): Promise<string> {
  const desktopRuntime = isDesktopRuntime();
  const hasContextHostInfo = context !== undefined && "hostInfo" in context;
  const appInfo = await readAppInfo(desktopRuntime);
  const engine = await readEngineInfo(desktopRuntime);
  const fetchedHostInfo = hasContextHostInfo ? null : await readHostInfo(desktopRuntime);
  const hostInfo = hasContextHostInfo && context ? context.hostInfo ?? null : fetchedHostInfo;
  let agentRuntimeSupport: AgentRuntimeSupportDiagnostics | null = null;
  const endpoint = context?.agentRuntimeEndpoint;
  if (endpoint?.baseUrl.trim() && endpoint.workspaceId.trim()) {
    try {
      agentRuntimeSupport = await createCanonicalAgentClient(endpoint).getSupportDiagnostics();
      captureAnalyticsEvent("agent_runtime_support_export", { success: true });
    } catch {
      captureAnalyticsEvent("agent_runtime_support_export", { success: false });
    }
  }
  return composeDiagnosticsBundleJson({
    capturedAt: new Date().toISOString(),
    desktopRuntime,
    appInfo,
    engineInfo: engine,
    juggleworkServerSettings: readJuggleWorkServerSettings(),
    hostInfo,
    developerLogs: readDevLogs(80),
    perfLogs: readPerfLogs(80),
    context,
    agentRuntimeSupport,
  });
}
