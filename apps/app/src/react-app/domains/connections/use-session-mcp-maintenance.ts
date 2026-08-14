import { useCallback, useEffect, useRef, useState } from "react";

import {
  mintCloudControlMcpToken,
  readDenSettings,
  type DenMcpToken,
  type DenSettings,
} from "../../../app/lib/den";
import { recordInspectorEvent } from "../../../app/lib/app-inspector";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import type {
  JuggleWorkCloudMcpFailure,
  JuggleWorkCloudMcpHealth,
  JuggleWorkCloudMcpProviderModelContext,
  JuggleWorkServerClient,
} from "../../../app/lib/jugglework-server";
import { unwrap } from "../../../app/lib/opencode";
import type { Client, McpServerEntry, McpStatusMap } from "../../../app/types";
import { attemptSilentMcpReauth } from "./mcp-silent-reauth";
import { recordCloudMcpMaintenanceOutcome } from "./cloud-mcp-maintenance-outcome";
import {
  CLOUD_MCP_SERVER_NAME,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  runJuggleWorkCloudMcpReconciler,
  type CloudMcpClient,
} from "./cloud-mcp-reconciler";
import {
  createSessionMcpVisibilityResumeHandler,
  runSessionMcpMaintenanceSingleflight,
  trackSessionMcpResumeMaintenance,
  waitForSessionMcpResumeMaintenance,
  type SessionMcpMaintenanceRun,
  type SessionMcpResumeWaitResult,
} from "./session-mcp-maintenance-coordinator";

export const SESSION_MCP_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
export const SESSION_MCP_MAINTENANCE_TIMEOUT_MS = 2 * 60 * 1000;
export const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
export const CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS = [1_000, 3_000];
export const SESSION_MCP_RESUME_SEND_WAIT_TIMEOUT_MS = 5_000;

type CloudMcpMaintenanceClient = CloudMcpClient & Pick<JuggleWorkServerClient, "listMcp">;

const runtimeObjectIds = new WeakMap<object, number>();
let nextRuntimeObjectId = 0;

function runtimeObjectId(value: object): number {
  const existing = runtimeObjectIds.get(value);
  if (existing !== undefined) return existing;
  const id = ++nextRuntimeObjectId;
  runtimeObjectIds.set(value, id);
  return id;
}

export type CloudMcpMaintenanceIssue = Pick<
  JuggleWorkCloudMcpFailure,
  "code" | "stage" | "retryable" | "recommendedAction" | "message"
>;

export type CloudMcpBackgroundSyncResult =
  | {
      outcome: "ready";
      status: "synced" | "unchanged";
      health: JuggleWorkCloudMcpHealth;
    }
  | {
      outcome: "skipped";
      status: "skipped";
      reason: "signed_out" | "missing_org" | "missing_workspace" | "disabled";
      health: null;
    }
  | {
      outcome: "failed";
      status: "failed";
      issue: CloudMcpMaintenanceIssue;
      health: JuggleWorkCloudMcpHealth | null;
    };

export type SessionCloudMcpMaintenanceState = {
  status: "idle" | "checking" | "ready" | "skipped" | "retrying" | "failed";
  issue: CloudMcpMaintenanceIssue | null;
  attempt: number;
  maxAttempts: number;
};

export type SessionCloudMcpMaintenance = SessionCloudMcpMaintenanceState & {
  waitForResumeMaintenance: (timeoutMs?: number) => Promise<SessionMcpResumeWaitResult>;
};

const IDLE_CLOUD_MCP_MAINTENANCE_STATE: SessionCloudMcpMaintenanceState = {
  status: "idle",
  issue: null,
  attempt: 0,
  maxAttempts: 1 + CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS.length,
};

function genericCloudMcpMaintenanceIssue(input?: {
  code?: string;
  message?: string;
  retryable?: boolean;
}): CloudMcpMaintenanceIssue {
  return {
    code: input?.code ?? "cloud_mcp_maintenance_failed",
    stage: "engine_delivery",
    retryable: input?.retryable ?? true,
    recommendedAction: "Retry, then open Settings → Connect if the problem continues.",
    message: input?.message ?? "JuggleWork could not verify connected service tools for this workspace.",
  };
}

function failedCloudMcpBackgroundSync(input: {
  health: JuggleWorkCloudMcpHealth | null;
  issue?: CloudMcpMaintenanceIssue;
  code?: string;
  message?: string;
}): CloudMcpBackgroundSyncResult {
  return {
    outcome: "failed",
    status: "failed",
    health: input.health,
    issue: input.issue ?? genericCloudMcpMaintenanceIssue({ code: input.code, message: input.message }),
  };
}

export function getSessionMcpMaintenanceTargetKey(input: {
  client: Pick<JuggleWorkServerClient, "baseUrl">;
  cloudSignedIn: boolean;
  denBaseUrl?: string | null;
  orgId?: string | null;
  workspaceId: string;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
}): string {
  return JSON.stringify([
    input.denBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    input.client.baseUrl.trim().replace(/\/+$/, ""),
    input.workspaceId.trim(),
    input.cloudSignedIn ? input.orgId?.trim() ?? "" : "local-only",
    input.providerModel?.provider.trim() ?? "",
    input.providerModel?.model.trim() ?? "",
  ]);
}

export async function runSessionMcpMaintenanceTask(input: {
  targetKey: string;
  task: () => Promise<void>;
  timeoutMs?: number;
}): Promise<SessionMcpMaintenanceRun> {
  const run = await runSessionMcpMaintenanceSingleflight({
    targetKey: input.targetKey,
    task: input.task,
    timeoutMs: input.timeoutMs ?? SESSION_MCP_MAINTENANCE_TIMEOUT_MS,
  });
  if (run.started) {
    if (run.completion.status === "timed_out") {
      recordCloudMcpMaintenanceOutcome(input.targetKey, { status: "timed_out" });
    } else if (run.completion.status === "error") {
      recordCloudMcpMaintenanceOutcome(input.targetKey, { status: "error", detail: run.completion.detail });
    } else {
      recordCloudMcpMaintenanceOutcome(input.targetKey, { status: "ok" });
    }
  }
  return run;
}

export async function syncCloudControlMcpInBackground(input: {
  client: CloudMcpMaintenanceClient;
  workspaceId: string;
  force?: boolean;
  now?: number;
  settings?: DenSettings;
  mintToken?: () => Promise<DenMcpToken | null>;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
}): Promise<CloudMcpBackgroundSyncResult> {
  const workspaceId = input.workspaceId.trim();
  const settings = input.settings ?? readDenSettings();
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!workspaceId) {
    return { outcome: "skipped", status: "skipped", reason: "missing_workspace", health: null };
  }
  if (!settings.authToken?.trim()) {
    return { outcome: "skipped", status: "skipped", reason: "signed_out", health: null };
  }
  if (!orgId) {
    return { outcome: "skipped", status: "skipped", reason: "missing_org", health: null };
  }
  const scope = {
    denBaseUrl: settings.baseUrl,
    serverBaseUrl: input.client.baseUrl,
    orgId,
    workspaceId,
  };
  const listed = await input.client.listMcp(workspaceId);
  const configured = listed.items.find((entry) => entry.name === CLOUD_MCP_SERVER_NAME);
  if (configured?.config.enabled === false) {
    return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
  }
  // Recorded user intent (disabled/removed) gates provisioning only: when no
  // enabled entry exists we honor it, but an existing enabled entry must keep
  // its token fresh regardless. A stale "removed" intent once silently
  // disabled all maintenance until the 7-day token expired and the engine
  // dropped the MCP.
  const configuredEnabled = configured !== undefined && configured.config.enabled !== false;
  if (!configuredEnabled && readCloudMcpUserState(scope) !== null) {
    return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
  }
  const configuredUrl = typeof configured?.config.url === "string" ? configured.config.url : null;

  const result = await runJuggleWorkCloudMcpReconciler({
    mode: "repair",
    client: input.client,
    context: {
      ...scope,
      denAuthToken: settings.authToken,
      orgSlug: settings.activeOrgSlug,
      orgName: settings.activeOrgName,
      fallbackUrl: configured?.config.type === "remote" ? configuredUrl : null,
      providerModel: input.providerModel,
      trigger: input.force ? "desktop-background-forced" : "desktop-background",
    },
    mintToken: input.mintToken
      ? async () => input.mintToken?.() ?? null
      : mintCloudControlMcpToken,
    force: input.force,
    refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    now: input.now,
    configuredEnabled: configured === undefined ? null : configured.config.enabled !== false,
  });
  if (result.health?.usable) {
    return {
      outcome: "ready",
      status: result.status === "unchanged" || result.status === "ready" ? "unchanged" : "synced",
      health: result.health,
    };
  }
  if (result.status === "skipped") {
    if (result.skippedReason === "signed_out") {
      return { outcome: "skipped", status: "skipped", reason: "signed_out", health: null };
    }
    if (result.skippedReason === "missing_org") {
      return { outcome: "skipped", status: "skipped", reason: "missing_org", health: null };
    }
    if (result.skippedReason === "missing_workspace") {
      return { outcome: "skipped", status: "skipped", reason: "missing_workspace", health: null };
    }
    if (result.skippedReason === "disabled") {
      return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
    }
    if (result.skippedReason === "mint_failed") {
      return failedCloudMcpBackgroundSync({
        health: result.health,
        code: "cloud_mcp_token_mint_failed",
        message: "JuggleWork could not refresh Cloud authentication for connected service tools.",
      });
    }
  }
  return failedCloudMcpBackgroundSync({
    health: result.health,
    issue: result.health?.firstFailure ?? undefined,
  });
}

export async function runCloudMcpMaintenanceWithRetry(input: {
  attempt: () => Promise<CloudMcpBackgroundSyncResult>;
  retryDelaysMs?: number[];
  wait?: (delayMs: number) => Promise<void>;
  onAttempt?: (input: {
    result: CloudMcpBackgroundSyncResult;
    attempt: number;
    maxAttempts: number;
    willRetry: boolean;
  }) => void;
}): Promise<CloudMcpBackgroundSyncResult> {
  const retryDelaysMs = input.retryDelaysMs ?? CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS;
  const wait = input.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxAttempts = 1 + retryDelaysMs.length;
  let lastResult: CloudMcpBackgroundSyncResult | null = null;

  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) await wait(retryDelaysMs[index - 1] ?? 0);
    try {
      lastResult = await input.attempt();
    } catch {
      lastResult = failedCloudMcpBackgroundSync({ health: null });
    }
    const willRetry = lastResult.outcome === "failed"
      && lastResult.issue.retryable
      && index < maxAttempts - 1;
    input.onAttempt?.({ result: lastResult, attempt: index + 1, maxAttempts, willRetry });
    if (!willRetry) return lastResult;
  }

  return lastResult ?? failedCloudMcpBackgroundSync({ health: null });
}

export async function healWorkspaceMcpInBackground(input: {
  client: CloudMcpMaintenanceClient;
  workspaceId: string;
  opencodeClient: Client;
  directory: string;
}): Promise<boolean> {
  const workspaceId = input.workspaceId.trim();
  const directory = input.directory.trim();
  if (!workspaceId || !directory) return false;

  const listed = await input.client.listMcp(workspaceId);
  const servers = listed.items.map((entry) => ({
    name: entry.name,
    config: entry.config as McpServerEntry["config"],
  }));
  if (servers.length === 0) return false;

  const statuses = unwrap(await input.opencodeClient.mcp.status({ directory })) as McpStatusMap;
  return attemptSilentMcpReauth({
    client: input.opencodeClient,
    directory,
    servers,
    statuses,
  });
}

export function useSessionMcpMaintenance(input: {
  cloudSignedIn: boolean;
  client: JuggleWorkServerClient | null;
  workspaceId: string | null;
  opencodeClient: Client | null;
  directory: string;
  engineReloadBusy?: boolean;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
}): SessionCloudMcpMaintenance {
  const [cloudMcpState, setCloudMcpState] = useState<SessionCloudMcpMaintenanceState>(
    IDLE_CLOUD_MCP_MAINTENANCE_STATE,
  );
  const [settingsVersion, setSettingsVersion] = useState(0);
  const engineReloadEpochRef = useRef(0);
  const previousEngineReloadBusyRef = useRef(Boolean(input.engineReloadBusy));
  if (input.engineReloadBusy && !previousEngineReloadBusyRef.current) {
    engineReloadEpochRef.current += 1;
  }
  previousEngineReloadBusyRef.current = Boolean(input.engineReloadBusy);
  const targetKeyRef = useRef<string | null>(null);
  const waitForResumeMaintenance = useCallback((timeoutMs = SESSION_MCP_RESUME_SEND_WAIT_TIMEOUT_MS) => {
    const targetKey = targetKeyRef.current;
    if (!targetKey) return Promise.resolve<SessionMcpResumeWaitResult>({ outcome: "not_running" });
    return waitForSessionMcpResumeMaintenance(targetKey, timeoutMs);
  }, []);

  useEffect(() => {
    const handleSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  useEffect(() => {
    if (input.engineReloadBusy) {
      setCloudMcpState(input.cloudSignedIn
        ? { ...IDLE_CLOUD_MCP_MAINTENANCE_STATE, status: "checking" }
        : IDLE_CLOUD_MCP_MAINTENANCE_STATE);
      return;
    }
    const workspaceId = input.workspaceId?.trim() ?? "";
    const directory = input.directory.trim();
    const client = input.client;
    const opencodeClient = input.opencodeClient;
    if (!client || !opencodeClient || !workspaceId || !directory) {
      setCloudMcpState(IDLE_CLOUD_MCP_MAINTENANCE_STATE);
      return;
    }
    const settings = readDenSettings();
    const targetKey = JSON.stringify([
      getSessionMcpMaintenanceTargetKey({
      client,
      cloudSignedIn: input.cloudSignedIn,
      denBaseUrl: settings.baseUrl,
      orgId: settings.activeOrgId,
      workspaceId,
      // Resume repair is transport/workspace scoped. Model projection remains
      // part of normal health reporting, but must not couple split-pane sends.
      providerModel: undefined,
      }),
      directory,
      runtimeObjectId(opencodeClient),
      engineReloadEpochRef.current,
    ]);
    targetKeyRef.current = targetKey;

    let cancelled = false;
    setCloudMcpState(input.cloudSignedIn
      ? { ...IDLE_CLOUD_MCP_MAINTENANCE_STATE, status: "checking" }
      : IDLE_CLOUD_MCP_MAINTENANCE_STATE);

    const recordCloudAttempt = (attemptInput: {
      result: CloudMcpBackgroundSyncResult;
      attempt: number;
      maxAttempts: number;
      willRetry: boolean;
    }) => {
      const issue = attemptInput.result.outcome === "failed" ? attemptInput.result.issue : null;
      recordInspectorEvent("cloud_mcp.session_maintenance", {
        workspaceId,
        outcome: attemptInput.result.outcome,
        status: attemptInput.result.status,
        attempt: attemptInput.attempt,
        maxAttempts: attemptInput.maxAttempts,
        willRetry: attemptInput.willRetry,
        code: issue?.code ?? null,
        stage: issue?.stage ?? null,
        retryable: issue?.retryable ?? null,
      });
      if (cancelled) return;
      setCloudMcpState({
        status: attemptInput.result.outcome === "ready"
          ? "ready"
          : attemptInput.result.outcome === "skipped"
            ? "skipped"
            : attemptInput.willRetry
              ? "retrying"
              : "failed",
        issue,
        attempt: attemptInput.attempt,
        maxAttempts: attemptInput.maxAttempts,
      });
    };

    const tick = (reason: "background" | "resume" = "background"): Promise<SessionMcpMaintenanceRun> => {
      if (cancelled) {
        return Promise.resolve({ started: false, completion: { status: "ok" } });
      }
      return runSessionMcpMaintenanceTask({
        targetKey,
        task: async () => {
          let cloudFailure: CloudMcpMaintenanceIssue | null = null;
          if (input.cloudSignedIn) {
            const cloudResult = await runCloudMcpMaintenanceWithRetry({
              attempt: () => syncCloudControlMcpInBackground({
                client,
                workspaceId,
                providerModel: reason === "resume" ? undefined : input.providerModel,
              }),
              onAttempt: recordCloudAttempt,
            });
            if (cloudResult.outcome === "failed") {
              cloudFailure = cloudResult.issue;
            }
          }
          let healFailure: unknown = null;
          await healWorkspaceMcpInBackground({ client, workspaceId, opencodeClient, directory }).catch((error) => {
            healFailure = error;
            recordInspectorEvent("mcp.session_reauth_failed", { workspaceId });
            return false;
          });
          if (cloudFailure) throw new Error(cloudFailure.message);
          if (healFailure) {
            throw healFailure instanceof Error
              ? healFailure
              : new Error("JuggleWork could not restore workspace MCP connections.");
          }
        },
      }).then((run) => {
        if (!cancelled) {
          if (run.completion.status === "ok") {
            setCloudMcpState((current) => current.status === "failed"
              ? current
              : { ...IDLE_CLOUD_MCP_MAINTENANCE_STATE, status: "ready" });
          } else {
            setCloudMcpState((current) => ({
              ...current,
              status: "failed",
              issue: current.issue ?? genericCloudMcpMaintenanceIssue({
                code: run.completion.status === "timed_out"
                  ? "cloud_mcp_maintenance_timeout"
                  : "cloud_mcp_maintenance_failed",
                message: run.completion.status === "error" ? run.completion.detail : undefined,
              }),
            }));
          }
        }
        return run;
      });
    };

    void tick();
    const handleOnline = () => void tick();
    const handleFocus = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const handleVisibilityResume = createSessionMcpVisibilityResumeHandler({
      visibilityState: () => document.visibilityState,
      run: () => {
        const resumeTask = tick("resume");
        trackSessionMcpResumeMaintenance(targetKey, resumeTask);
      },
    });
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityResume);
    const interval = window.setInterval(() => void tick(), SESSION_MCP_MAINTENANCE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityResume);
      window.clearInterval(interval);
      if (targetKeyRef.current === targetKey) targetKeyRef.current = null;
    };
  }, [
    input.client,
    input.cloudSignedIn,
    input.directory,
    input.engineReloadBusy,
    input.opencodeClient,
    input.providerModel?.model,
    input.providerModel?.provider,
    settingsVersion,
    input.workspaceId,
  ]);

  return { ...cloudMcpState, waitForResumeMaintenance };
}
