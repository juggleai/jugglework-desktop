/** @jsxImportSource react */
import { create } from "zustand";

import { t } from "../../../../i18n";

export type SessionActivityStatus = "idle" | "thinking" | "responding" | "stalled" | "error" | "compacting" | "waiting" | "incomplete";

export const SESSION_STALLED_AFTER_MS = 5 * 60_000;

type SessionMessageRole = "assistant" | "system" | "user";

type SessionActivityRecord = {
  status: SessionActivityStatus;
  runActive: boolean;
  assistantOutput: boolean;
  errorActive: boolean;
  errorMessage: string | null;
  completionBlocked: boolean;
  finishReason: string | null;
  compacting: boolean;
  waitingPermissionIds: string[];
  waitingQuestionIds: string[];
  messageRoles: Record<string, SessionMessageRole>;
  lastMeaningfulProgressAt: number | null;
  stalledAt: number | null;
  updatedAt: number;
};

type SessionLike = {
  id: string;
  status?: unknown;
  state?: unknown;
  runStatus?: unknown;
};

type SessionActivityStore = {
  recordsByWorkspaceId: Record<string, Record<string, SessionActivityRecord>>;
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>;
  getStatus: (workspaceId: string, sessionId: string) => SessionActivityStatus;
  getSessionError: (workspaceId: string, sessionId: string) => string | null;
  getFinishReason: (workspaceId: string, sessionId: string) => string | null;
  seedWorkspaceSessions: (workspaceId: string, sessions: SessionLike[]) => void;
  seedSessionRun: (workspaceId: string, sessionId: string, status: unknown, assistantOutput: boolean) => void;
  setRunStatus: (workspaceId: string, sessionId: string, status: unknown) => void;
  markMessageRole: (workspaceId: string, sessionId: string, messageId: string, role: SessionMessageRole) => void;
  markAssistantOutput: (workspaceId: string, sessionId: string, messageId?: string, options?: { allowUnknownMessageRole?: boolean }) => void;
  markProgress: (workspaceId: string, sessionId: string, at?: number) => void;
  refreshStalledStatuses: (now?: number) => void;
  setWaitingRequest: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestId: string, waiting: boolean) => void;
  replaceWaitingRequests: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestIds: string[]) => void;
  setError: (workspaceId: string, sessionId: string, message?: string) => void;
  setCompletionDiagnostic: (workspaceId: string, sessionId: string, blocked: boolean, finishReason?: string | null) => void;
  markFinishReason: (workspaceId: string, sessionId: string, finishReason: string) => void;
  markProviderDisconnected: (workspaceId: string) => void;
  clearError: (workspaceId: string, sessionId: string) => void;
  setCompacting: (workspaceId: string, sessionId: string, compacting: boolean) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
};

const createRecord = (): SessionActivityRecord => ({
  status: "idle",
  runActive: false,
  assistantOutput: false,
  errorActive: false,
  errorMessage: null,
  completionBlocked: false,
  finishReason: null,
  compacting: false,
  waitingPermissionIds: [],
  waitingQuestionIds: [],
  messageRoles: {},
  lastMeaningfulProgressAt: null,
  stalledAt: null,
  updatedAt: 0,
});

function normalizeRunStatus(status: unknown): "idle" | "running" | "retry" {
  if (typeof status === "string") {
    if (["busy", "starting", "running", "waiting", "aborting"].includes(status)) return "running";
    if (status === "retry" || status === "retrying") return "retry";
    return "idle";
  }

  if (!status || typeof status !== "object") return "idle";
  const type = "type" in status ? status.type : undefined;
  if (type === "busy" || type === "starting" || type === "running" || type === "waiting" || type === "aborting") return "running";
  if (type === "retry" || type === "retrying") return "retry";
  return "idle";
}

function sessionRunStatus(session: SessionLike) {
  return session.status ?? session.state ?? session.runStatus;
}

function statusForRecord(record: SessionActivityRecord): SessionActivityStatus {
  if (record.errorActive) return "error";
  if (record.waitingPermissionIds.length > 0 || record.waitingQuestionIds.length > 0) return "waiting";
  if (record.compacting) return "compacting";
  if (record.completionBlocked) return "incomplete";
  if (!record.runActive) return "idle";
  if (record.stalledAt !== null) return "stalled";
  return record.assistantOutput ? "responding" : "thinking";
}

function updateWorkspaceStatus(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
  workspaceId: string,
  sessionId: string,
  status: SessionActivityStatus,
) {
  const current = statusesByWorkspaceId[workspaceId] ?? {};
  if (current[sessionId] === status) return statusesByWorkspaceId;
  return {
    ...statusesByWorkspaceId,
    [workspaceId]: {
      ...current,
      [sessionId]: status,
    },
  };
}

function updateRecord(
  state: Pick<SessionActivityStore, "recordsByWorkspaceId" | "statusesByWorkspaceId">,
  workspaceId: string,
  sessionId: string,
  updater: (record: SessionActivityRecord) => SessionActivityRecord,
) {
  const workspaceRecords = state.recordsByWorkspaceId[workspaceId] ?? {};
  const nextRecord = updater(workspaceRecords[sessionId] ?? createRecord());
  const status = statusForRecord(nextRecord);
  const recordWithStatus = { ...nextRecord, status, updatedAt: Date.now() };
  return {
    recordsByWorkspaceId: {
      ...state.recordsByWorkspaceId,
      [workspaceId]: {
        ...workspaceRecords,
        [sessionId]: recordWithStatus,
      },
    },
    statusesByWorkspaceId: updateWorkspaceStatus(state.statusesByWorkspaceId, workspaceId, sessionId, status),
  };
}

function removeValue(values: string[], value: string) {
  return values.filter((item) => item !== value);
}

function addValue(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

export const useSessionActivityStore = create<SessionActivityStore>((set, get) => ({
  recordsByWorkspaceId: {},
  statusesByWorkspaceId: {},
  getStatus: (workspaceId, sessionId) => (
    get().statusesByWorkspaceId[workspaceId]?.[sessionId] ?? "idle"
  ),
  getSessionError: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();

    if (!workspace || !session) {
      return null;
    }

    const record = get().recordsByWorkspaceId[workspace]?.[session];

    if (!record?.errorActive) {
      return null;
    }

    return record.errorMessage;
  },
  getFinishReason: (workspaceId, sessionId) => (
    get().recordsByWorkspaceId[workspaceId.trim()]?.[sessionId.trim()]?.finishReason ?? null
  ),
  seedWorkspaceSessions: (workspaceId, sessions) => {
    const id = workspaceId.trim();
    if (!id) return;
    set((state) => {
      let nextState = state;
      for (const session of sessions) {
        const sessionId = session.id.trim();
        if (!sessionId) continue;
        const status = sessionRunStatus(session);
        if (status === undefined || status === null) continue;
        nextState = {
          ...nextState,
          ...updateRecord(nextState, id, sessionId, (record) => {
            const normalized = normalizeRunStatus(status);
            const snapshotRunActive = normalized === "running" || normalized === "retry";
            // TIPS: 工作区会话列表可能在 session.idle 之后短暂重放旧 busy 快照。已经写入
            // completion diagnostic 的终态不能被这类列表快照复活；真正的新任务会先通过实时
            // setRunStatus(running) 清除 completionBlocked，再由快照继续维护。
            const runActive = snapshotRunActive && !record.completionBlocked;
            const starting = runActive && !record.runActive;
            return {
              ...record,
              runActive,
              assistantOutput: runActive && record.runActive ? record.assistantOutput : false,
              errorActive: runActive ? false : record.errorActive,
              errorMessage: runActive ? null : record.errorMessage,
              completionBlocked: runActive ? false : record.completionBlocked,
              finishReason: runActive ? null : record.finishReason,
              compacting: runActive ? record.compacting : false,
              waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
              waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
              lastMeaningfulProgressAt: runActive
                ? (starting ? Date.now() : record.lastMeaningfulProgressAt)
                : null,
              stalledAt: runActive ? record.stalledAt : null,
            };
          }),
        };
      }
      return nextState;
    });
  },
  seedSessionRun: (workspaceId, sessionId, status, assistantOutput) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const normalized = normalizeRunStatus(status);
      const snapshotRunActive = normalized === "running" || normalized === "retry";
      const runActive = snapshotRunActive && !record.completionBlocked;
      const starting = runActive && !record.runActive;
      return {
        ...record,
        runActive,
        assistantOutput: runActive && assistantOutput,
        errorActive: runActive ? false : record.errorActive,
        errorMessage: runActive ? null : record.errorMessage,
        completionBlocked: runActive ? false : record.completionBlocked,
        finishReason: runActive ? null : record.finishReason,
        compacting: runActive ? record.compacting : false,
        waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
        waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
        lastMeaningfulProgressAt: runActive
          ? (starting ? Date.now() : record.lastMeaningfulProgressAt)
          : null,
        stalledAt: runActive ? record.stalledAt : null,
      };
    }));
  },
  setRunStatus: (workspaceId, sessionId, status) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const normalized = normalizeRunStatus(status);
      const runActive = normalized === "running" || normalized === "retry";
      const starting = runActive && !record.runActive;
      return {
        ...record,
        runActive,
        assistantOutput: runActive && record.runActive ? record.assistantOutput : false,
        errorActive: runActive ? false : record.errorActive,
        errorMessage: runActive ? null : record.errorMessage,
        completionBlocked: runActive ? false : record.completionBlocked,
        finishReason: runActive ? null : record.finishReason,
        compacting: runActive ? record.compacting : false,
        waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
        waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
        // Replayed busy snapshots are not progress. Only the transition into a
        // run starts the clock; message/tool/token activity refreshes it.
        lastMeaningfulProgressAt: runActive
          ? (starting ? Date.now() : record.lastMeaningfulProgressAt)
          : null,
        stalledAt: runActive ? record.stalledAt : null,
      };
    }));
  },
  markMessageRole: (workspaceId, sessionId, messageId, role) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const message = messageId.trim();
    if (!workspace || !session || !message) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      messageRoles: {
        ...record.messageRoles,
        [message]: role,
      },
    })));
  },
  markAssistantOutput: (workspaceId, sessionId, messageId, options) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const message = messageId?.trim() ?? "";
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      if (!record.runActive) return record;
      if (message && record.messageRoles[message] && record.messageRoles[message] !== "assistant") return record;
      if (message && !record.messageRoles[message] && options?.allowUnknownMessageRole !== true) return record;
      return {
        ...record,
        assistantOutput: true,
        lastMeaningfulProgressAt: Date.now(),
        stalledAt: null,
      };
    }));
  },
  markProgress: (workspaceId, sessionId, at = Date.now()) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session || !Number.isFinite(at)) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      if (!record.runActive) return record;
      return {
        ...record,
        lastMeaningfulProgressAt: at,
        stalledAt: null,
      };
    }));
  },
  refreshStalledStatuses: (now = Date.now()) => {
    if (!Number.isFinite(now)) return;
    set((state) => {
      let nextState = state;
      for (const [workspaceId, records] of Object.entries(state.recordsByWorkspaceId)) {
        for (const [sessionId, record] of Object.entries(records)) {
          if (!record.runActive || record.errorActive || record.compacting || record.waitingPermissionIds.length > 0 || record.waitingQuestionIds.length > 0) continue;
          const baseline = record.lastMeaningfulProgressAt;
          if (baseline === null || now - baseline < SESSION_STALLED_AFTER_MS || record.stalledAt !== null) continue;
          nextState = {
            ...nextState,
            ...updateRecord(nextState, workspaceId, sessionId, (current) => ({
              ...current,
              stalledAt: now,
            })),
          };
        }
      }
      return nextState;
    });
  },
  setWaitingRequest: (workspaceId, sessionId, kind, requestId, waiting) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const request = requestId.trim();
    if (!workspace || !session || !request) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const key = kind === "permission" ? "waitingPermissionIds" : "waitingQuestionIds";
      return {
        ...record,
        [key]: waiting ? addValue(record[key], request) : removeValue(record[key], request),
      };
    }));
  },
  replaceWaitingRequests: (workspaceId, sessionId, kind, requestIds) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    const ids = Array.from(new Set(requestIds.map((requestId) => requestId.trim()).filter(Boolean)));
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      [kind === "permission" ? "waitingPermissionIds" : "waitingQuestionIds"]: ids,
    })));
  },
  setError: (workspaceId, sessionId, message) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      errorActive: true,
      errorMessage: message ? message : "Session failed",
      runActive: false,
      assistantOutput: false,
      compacting: false,
      lastMeaningfulProgressAt: null,
      stalledAt: null,
    })));
  },
  setCompletionDiagnostic: (workspaceId, sessionId, blocked, finishReason) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      completionBlocked: blocked,
      finishReason: finishReason?.trim() || record.finishReason,
      // Task incomplete 是终态而不是活动状态。即使 provider 断连或 idle 事件乱序，也必须立即
      // 清掉 loading 相关字段；否则切换会话后旧 busy/stalled 状态会再次出现在侧栏。
      runActive: blocked ? false : record.runActive,
      assistantOutput: blocked ? false : record.assistantOutput,
      compacting: blocked ? false : record.compacting,
      waitingPermissionIds: blocked ? [] : record.waitingPermissionIds,
      waitingQuestionIds: blocked ? [] : record.waitingQuestionIds,
      lastMeaningfulProgressAt: blocked ? null : record.lastMeaningfulProgressAt,
      stalledAt: blocked ? null : record.stalledAt,
    })));
  },
  markFinishReason: (workspaceId, sessionId, finishReason) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const reason = finishReason.trim();
    if (!workspace || !session || !reason) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({ ...record, finishReason: reason })));
  },
  markProviderDisconnected: (workspaceId) => {
    const workspace = workspaceId.trim();
    if (!workspace) return;
    set((state) => {
      let nextState = state;
      for (const [sessionId, record] of Object.entries(state.recordsByWorkspaceId[workspace] ?? {})) {
        if (!record.runActive) continue;
        nextState = {
          ...nextState,
          ...updateRecord(nextState, workspace, sessionId, (current) => ({
            ...current,
            finishReason: "provider_disconnected",
          })),
        };
      }
      return nextState;
    });
  },
  clearError: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      errorActive: false,
      errorMessage: null,
    })));
  },
  setCompacting: (workspaceId, sessionId, compacting) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      compacting,
      errorActive: compacting ? false : record.errorActive,
      errorMessage: compacting ? null : record.errorMessage,
    })));
  },
  removeSession: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => {
      const workspaceRecords = state.recordsByWorkspaceId[workspace];
      const workspaceStatuses = state.statusesByWorkspaceId[workspace];
      if (!workspaceRecords?.[session] && !workspaceStatuses?.[session]) return state;
      const nextRecords = { ...(workspaceRecords ?? {}) };
      const nextStatuses = { ...(workspaceStatuses ?? {}) };
      delete nextRecords[session];
      delete nextStatuses[session];
      return {
        ...state,
        recordsByWorkspaceId: {
          ...state.recordsByWorkspaceId,
          [workspace]: nextRecords,
        },
        statusesByWorkspaceId: {
          ...state.statusesByWorkspaceId,
          [workspace]: nextStatuses,
        },
      };
    });
  },
}));

export function getSessionActivityStatusLabel(status: SessionActivityStatus) {
  if (status === "thinking") return t("session.assistant_thinking");
  if (status === "responding") return t("session.assistant_responding");
  if (status === "stalled") return t("session.assistant_stalled");
  if (status === "waiting") return t("session.assistant_waiting");
  if (status === "compacting") return t("session.assistant_compacting");
  if (status === "error") return t("session.assistant_error");
  if (status === "incomplete") return "Task incomplete";
  return t("session.assistant_idle");
}
