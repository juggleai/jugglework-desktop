import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readDenSettings } from "../../../app/lib/den";
import { recordInspectorEvent } from "../../../app/lib/app-inspector";
import type {
  JuggleWorkCloudMcpProviderModelContext,
  JuggleWorkServerClient,
} from "../../../app/lib/jugglework-server";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import type { DenAuthStatus } from "../cloud/den-auth-provider";
import {
  normalizeCloudMcpScope,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  createCloudMcpSubmissionCoordinator,
  decideCloudMcpSubmissionGate,
  ensureCloudMcpSubmissionReadiness,
  IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  resolveCloudMcpSubmissionAuth,
  type CloudMcpSubmissionGateDecision,
  type CloudMcpSubmissionGateState,
  type CloudMcpSubmissionIssue,
  type CloudMcpSubmissionPreparationResult,
  type CloudMcpSubmissionResult,
} from "./cloud-mcp-submit-readiness";
import {
  syncCloudControlMcpInBackground,
} from "./use-session-mcp-maintenance";

type CloudMcpSubmitReadinessClient = Pick<
  JuggleWorkServerClient,
  "baseUrl" | "getJuggleWorkCloudMcpHealth" | "reconcileJuggleWorkCloudMcp" | "listMcp"
>;

type UseCloudMcpSubmitReadinessInput = {
  cloudAuthStatus: DenAuthStatus;
  client: CloudMcpSubmitReadinessClient | null;
  workspaceId: string | null;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
};

type CloudMcpSubmitInput = {
  skipGate?: boolean;
  sessionId?: string;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
  send: () => Promise<void>;
};

export type CloudMcpSubmitReadiness = {
  state: CloudMcpSubmissionGateState;
  submit: (input: CloudMcpSubmitInput) => Promise<CloudMcpSubmissionResult>;
  reportFailure: (issue: CloudMcpSubmissionIssue) => CloudMcpSubmissionResult;
};

function missingContextIssue(input: {
  client: CloudMcpSubmitReadinessClient | null;
  workspaceId: string;
  providerModel?: JuggleWorkCloudMcpProviderModelContext;
}): CloudMcpSubmissionIssue {
  if (!input.client || !input.workspaceId) {
    return {
      code: "cloud_mcp_submission_context_missing",
      stage: "engine_delivery",
      retryable: true,
      message: "JuggleWork could not resolve the workspace server before checking connected service tools.",
      recommendedAction: "Retry after the workspace finishes loading.",
    };
  }
  if (!input.providerModel) {
    return {
      code: "cloud_mcp_submission_model_missing",
      stage: "provider_projection",
      retryable: false,
      message: "Select a provider and model before using connected service tools.",
      recommendedAction: "Choose a model, then Retry.",
    };
  }
  return {
    code: "cloud_mcp_submission_context_missing",
    stage: "provider_projection",
    retryable: false,
    message: "JuggleWork could not verify connected service tools for this submission.",
    recommendedAction: "Retry or open Settings → Connect for diagnostics.",
  };
}

/**
 * 跳过 Connect 门禁并独立提交普通任务
 * @param send 当前会话的发送函数
 * @returns 普通任务提交结果
 */
export async function submitWithoutCloudMcpGate(
  send: () => Promise<void>,
): Promise<CloudMcpSubmissionResult> {
  await send();
  return { outcome: "sent", bypassed: true };
}

export function useCloudMcpSubmitReadiness(
  input: UseCloudMcpSubmitReadinessInput,
): CloudMcpSubmitReadiness {
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [state, setState] = useState<CloudMcpSubmissionGateState>(
    IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  );
  const coordinatorsRef = useRef(new Map<string, ReturnType<typeof createCloudMcpSubmissionCoordinator>>());
  const authStatusRef = useRef(input.cloudAuthStatus);
  const authWaitersRef = useRef(new Set<() => void>());
  authStatusRef.current = input.cloudAuthStatus;
  const settings = useMemo(() => readDenSettings(), [input.cloudAuthStatus, settingsVersion]);
  const workspaceId = input.workspaceId?.trim() ?? "";
  const serverBaseUrl = input.client?.baseUrl.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  const scope = normalizeCloudMcpScope({
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId,
    workspaceId,
  });
  const userState = scope ? readCloudMcpUserState(scope) : null;
  const decision = useMemo(() => decideCloudMcpSubmissionGate({
    cloudAuthStatus: input.cloudAuthStatus,
    cloudHasSessionToken: Boolean(settings.authToken?.trim()),
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId: orgId || null,
    workspaceId,
    providerModel: input.providerModel,
    userState,
  }), [
    input.cloudAuthStatus,
    input.providerModel?.model,
    input.providerModel?.provider,
    orgId,
    serverBaseUrl,
    settings.authToken,
    settings.baseUrl,
    userState,
    workspaceId,
  ]);
  const currentScopeKeyRef = useRef(decision.scopeKey);
  currentScopeKeyRef.current = decision.scopeKey;
  const previousScopeKeyRef = useRef(decision.scopeKey);
  const gateSnapshot = {
    cloudAuthStatus: input.cloudAuthStatus,
    client: input.client,
    decision,
    providerModel: input.providerModel,
    settings,
    workspaceId,
  };
  const gateSnapshotRef = useRef(gateSnapshot);
  gateSnapshotRef.current = gateSnapshot;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  useEffect(() => {
    if (input.cloudAuthStatus === "checking") return;
    const waiters = [...authWaitersRef.current];
    authWaitersRef.current.clear();
    for (const resolve of waiters) resolve();
  }, [input.cloudAuthStatus]);

  useEffect(() => {
    if (previousScopeKeyRef.current === decision.scopeKey) return;
    previousScopeKeyRef.current = decision.scopeKey;
    let cancelled = false;
    for (const coordinator of coordinatorsRef.current.values()) cancelled = coordinator.cancel("context_changed") || cancelled;
    coordinatorsRef.current.clear();
    setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
    if (cancelled) {
      recordInspectorEvent("cloud_mcp.submission_cancelled", {
        workspaceId,
        reason: "context_changed",
      });
    }
  }, [decision.scopeKey, workspaceId]);

  useEffect(() => () => {
    for (const coordinator of coordinatorsRef.current.values()) coordinator.cancel("unmounted");
    coordinatorsRef.current.clear();
    const waiters = [...authWaitersRef.current];
    authWaitersRef.current.clear();
    for (const resolve of waiters) resolve();
  }, []);

  const waitForAuthResolution = useCallback((): Promise<void> => {
    if (authStatusRef.current !== "checking") return Promise.resolve();
    return new Promise<void>((resolve) => {
      authWaitersRef.current.add(resolve);
    });
  }, []);

  /**
   * 将发送前的外部恢复失败写入统一的 Connect 提交状态
   * @param issue 阻塞本次提交的问题
   * @returns 标准阻塞结果
   */
  const reportFailure = useCallback((issue: CloudMcpSubmissionIssue): CloudMcpSubmissionResult => {
    setState({
      ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
      status: "failed",
      issue,
    });
    recordInspectorEvent("cloud_mcp.submission_failure", {
      workspaceId: gateSnapshotRef.current.workspaceId,
      provider: gateSnapshotRef.current.providerModel?.provider ?? null,
      model: gateSnapshotRef.current.providerModel?.model ?? null,
      code: issue.code,
      stage: issue.stage,
      retryable: issue.retryable,
    });
    return { outcome: "blocked", issue };
  }, []);

  const submit = useCallback(async (submission: CloudMcpSubmitInput): Promise<CloudMcpSubmissionResult> => {
    // TIPS: 普通任务当前明确跳过 Connect readiness。此时不得再进入
    // workspace/model 级协调器，否则不同会话会共享发送状态或 Promise。
    if (submission.skipGate) {
      const result = await submitWithoutCloudMcpGate(submission.send);
      setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
      return result;
    }
    const initialSnapshot = gateSnapshotRef.current;
    const submittedProviderModel = submission.providerModel ?? initialSnapshot.providerModel;
    const baseScopeKey = initialSnapshot.decision.scopeKey;
    const capturedScopeKey = `${baseScopeKey}:${submission.sessionId?.trim() ?? ""}:${submittedProviderModel?.provider ?? ""}:${submittedProviderModel?.model ?? ""}`;
    const scopeIsCurrent = () => currentScopeKeyRef.current === baseScopeKey;
    const accountIsCurrent = () => {
      const current = readDenSettings();
      return scopeIsCurrent()
        && current.baseUrl === initialSnapshot.settings.baseUrl
        && current.authToken === initialSnapshot.settings.authToken
        && current.activeOrgId === initialSnapshot.settings.activeOrgId;
    };
    const gateRequired = initialSnapshot.decision.mode !== "bypass";
    let prepare: (() => Promise<CloudMcpSubmissionPreparationResult>) | undefined;

    if (gateRequired) {
      prepare = async () => {
        let activeSnapshot = initialSnapshot;
        let resolvedDecision: CloudMcpSubmissionGateDecision = initialSnapshot.decision;

        if (resolvedDecision.mode === "waiting_for_auth") {
          recordInspectorEvent("cloud_mcp.submission_auth_wait", {
            workspaceId: activeSnapshot.workspaceId,
            outcome: "started",
          });
          const authResolution = await resolveCloudMcpSubmissionAuth({
            decision: resolvedDecision,
            waitForResolution: async () => {
              await waitForAuthResolution();
              return gateSnapshotRef.current.decision;
            },
          });
          if (!accountIsCurrent()) {
            return { outcome: "cancelled", reason: "context_changed" };
          }
          if (authResolution.outcome === "failed") {
            recordInspectorEvent("cloud_mcp.submission_auth_wait", {
              workspaceId: activeSnapshot.workspaceId,
              outcome: "failed",
              code: authResolution.issue.code,
            });
            if (authResolution.issue.code === "cloud_mcp_auth_resolution_timeout") {
              recordInspectorEvent("cloud_mcp.submission_timeout", {
                workspaceId: activeSnapshot.workspaceId,
                stage: "auth_resolution",
              });
            }
            return { outcome: "failed", issue: authResolution.issue };
          }

          activeSnapshot = gateSnapshotRef.current;
          resolvedDecision = authResolution.decision;
          recordInspectorEvent("cloud_mcp.submission_auth_wait", {
            workspaceId: activeSnapshot.workspaceId,
            outcome: resolvedDecision.mode,
            authStatus: activeSnapshot.cloudAuthStatus,
          });
        }

        if (resolvedDecision.mode === "bypass") return { outcome: "bypass" };
        if (resolvedDecision.mode !== "required") {
          return { outcome: "cancelled", reason: "context_changed" };
        }

        const { client, settings, workspaceId: activeWorkspaceId } = activeSnapshot;
        const providerModel = submittedProviderModel;
        if (!client || !activeWorkspaceId || !providerModel) {
          return {
            outcome: "failed",
            issue: missingContextIssue({
              client,
              workspaceId: activeWorkspaceId,
              providerModel,
            }),
          };
        }
        const result = await ensureCloudMcpSubmissionReadiness({
          providerModel,
          // 发送前必须验证 Cloud endpoint，而不是仅信任 OpenCode 的历史 connected 状态。
          // 明确的 401 会进入下面唯一一次 repair/re-mint。
          check: () => client.getJuggleWorkCloudMcpHealth(activeWorkspaceId, providerModel, { probe: true }),
          repair: async () => {
            const repaired = await syncCloudControlMcpInBackground({
              client,
              workspaceId: activeWorkspaceId,
              providerModel,
              settings,
              isScopeCurrent: accountIsCurrent,
            });
            return repaired.health;
          },
          onAttempt: (attempt) => {
            if (!accountIsCurrent()) return;
            const issue = attempt.assessment.ready ? null : attempt.assessment.issue;
            setState({
              status: attempt.phase === "readiness" ? "checking" : "repairing",
              issue,
              attempt: attempt.attempt,
              maxAttempts: attempt.maxAttempts,
            });
            recordInspectorEvent(
              attempt.phase === "readiness"
                ? "cloud_mcp.submission_readiness"
                : "cloud_mcp.submission_repair",
              {
                workspaceId: activeWorkspaceId,
                provider: providerModel.provider,
                model: providerModel.model,
                attempt: attempt.attempt,
                maxAttempts: attempt.maxAttempts,
                outcome: attempt.assessment.ready ? "ready" : "failed",
                code: issue?.code ?? null,
                stage: issue?.stage ?? null,
                retryable: issue?.retryable ?? null,
              },
            );
            if (issue?.code === "cloud_mcp_submission_timeout") {
              recordInspectorEvent("cloud_mcp.submission_timeout", {
                workspaceId: activeWorkspaceId,
                provider: providerModel.provider,
                model: providerModel.model,
                attempt: attempt.attempt,
                maxAttempts: attempt.maxAttempts,
              });
            }
          },
        });
        if (!accountIsCurrent()) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        if (result.outcome === "ready") return { outcome: "ready" };
        if (result.outcome === "bypass") return { outcome: "bypass" };
        return { outcome: "failed", issue: result.issue };
      };
    }

    const coordinator = coordinatorsRef.current.get(capturedScopeKey) ?? createCloudMcpSubmissionCoordinator();
    coordinatorsRef.current.set(capturedScopeKey, coordinator);
    return coordinator.submit({
      scopeKey: capturedScopeKey,
      ...(prepare ? { prepare } : {}),
      send: submission.send,
      onState: (nextState) => {
        if (!scopeIsCurrent()) return;
        if (nextState.status === "checking") {
          setState({ ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE, status: "checking" });
          return;
        }
        if (nextState.status === "sending") {
          setState({ ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE, status: "sending" });
          return;
        }
        if (nextState.status === "failed") {
          setState({
            ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
            status: "failed",
            issue: nextState.issue,
          });
          recordInspectorEvent("cloud_mcp.submission_failure", {
            workspaceId: initialSnapshot.workspaceId,
            provider: initialSnapshot.providerModel?.provider ?? null,
            model: initialSnapshot.providerModel?.model ?? null,
            code: nextState.issue.code,
            stage: nextState.issue.stage,
            retryable: nextState.issue.retryable,
          });
          return;
        }
        setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
      },
    });
  }, [waitForAuthResolution]);

  return { state, submit, reportFailure };
}
