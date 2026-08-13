import { create } from "zustand";
import type { RuntimeEvent, RuntimeKind, RuntimeThread } from "@jugglework/types/agent-runtime";
import type { RuntimeApprovalRequest } from "@jugglework/types/agent-runtime";
import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";

export type RuntimeSessionBinding = {
  runtimeKind: RuntimeKind;
  threadId: string;
  backendThreadId: string;
  activeTurnId: string | null;
  pendingApproval: RuntimeApprovalRequest | null;
  ready: boolean;
  modelProviderId: string;
  modelId: string;
  reasoningEffort: string | null;
  cwd: string;
  locked: true;
};

type RuntimeSelectionState = {
  workspaceDraftRuntime: Record<string, RuntimeKind>;
  sessionBindings: Record<string, RuntimeSessionBinding>;
  setWorkspaceDraftRuntime: (workspaceId: string, kind: RuntimeKind, workspaceType: "local" | "remote") => RuntimeKind;
  bindThread: (thread: RuntimeThread) => void;
  hydrateRecord: (record: RuntimeSessionRecord) => void;
  applyEvent: (event: RuntimeEvent) => void;
  removeSession: (sessionId: string) => void;
};

export const useRuntimeSelectionStore = create<RuntimeSelectionState>((set) => ({
  workspaceDraftRuntime: {},
  sessionBindings: {},
  setWorkspaceDraftRuntime: (workspaceId, requested, workspaceType) => {
    const kind = workspaceType === "remote" ? "opencode" : requested;
    set((state) => ({ workspaceDraftRuntime: { ...state.workspaceDraftRuntime, [workspaceId]: kind } }));
    return kind;
  },
  bindThread: (thread) => set((state) => ({
    sessionBindings: {
      ...state.sessionBindings,
      [thread.sessionId]: {
        runtimeKind: thread.runtimeKind, threadId: thread.id, backendThreadId: thread.backendThreadId,
        activeTurnId: null, pendingApproval: null, ready: true,
        modelProviderId: thread.modelProviderId, modelId: thread.modelId, reasoningEffort: null, cwd: "",
        locked: true,
      },
    },
  })),
  hydrateRecord: (record) => set((state) => {
    if (!record.backendThreadId || state.sessionBindings[record.id]?.ready) return state;
    return { sessionBindings: { ...state.sessionBindings, [record.id]: {
      runtimeKind: record.runtimeKind, threadId: record.backendThreadId, backendThreadId: record.backendThreadId,
      activeTurnId: null, pendingApproval: null, ready: false, modelProviderId: record.modelProviderId, modelId: record.modelId,
      reasoningEffort: record.reasoningEffort, cwd: record.cwd, locked: true,
    } } };
  }),
  applyEvent: (event) => set((state) => {
    if (!("sessionId" in event) || !("turnId" in event)) return state;
    const binding = state.sessionBindings[event.sessionId];
    if (!binding || binding.runtimeKind !== event.runtimeKind || binding.threadId !== event.threadId) return state;
    const terminal = event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted";
    if (event.type === "approval.requested") return { sessionBindings: { ...state.sessionBindings, [event.sessionId]: { ...binding, pendingApproval: event.request } } };
    if (event.type !== "turn.started" && !terminal) return state;
    return { sessionBindings: { ...state.sessionBindings, [event.sessionId]: {
      ...binding, activeTurnId: terminal ? null : event.turnId, pendingApproval: terminal ? null : binding.pendingApproval,
    } } };
  }),
  removeSession: (sessionId) => set((state) => {
    if (!state.sessionBindings[sessionId]) return state;
    const sessionBindings = { ...state.sessionBindings };
    delete sessionBindings[sessionId];
    return { sessionBindings };
  }),
}));

export function selectedRuntimeFor(input: {
  workspaceId: string;
  workspaceType: "local" | "remote";
  sessionId: string | null;
  state: Pick<RuntimeSelectionState, "workspaceDraftRuntime" | "sessionBindings">;
}): RuntimeKind {
  const bound = input.sessionId ? input.state.sessionBindings[input.sessionId]?.runtimeKind : null;
  if (bound) return bound;
  // Legacy/native OpenCode sessions do not have a separate runtime ledger
  // binding. Once a session id exists they are nevertheless runtime-locked;
  // the workspace draft choice applies only to the next session.
  if (input.sessionId) return "opencode";
  if (input.workspaceType === "remote") return "opencode";
  return input.state.workspaceDraftRuntime[input.workspaceId] ?? "opencode";
}

export function newRuntimeSessionId(randomUUID = crypto.randomUUID.bind(crypto)): string {
  return `jws_${randomUUID().replaceAll("-", "")}`;
}
