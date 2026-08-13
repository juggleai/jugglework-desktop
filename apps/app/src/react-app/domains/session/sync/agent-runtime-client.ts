import {
  parseRuntimeEvent,
  type AgentRuntimeContract,
  type RuntimeEvent,
  type RuntimeKind,
} from "@jugglework/types/agent-runtime";

import {
  agentRuntimeArchiveThread,
  agentRuntimeCreateThread,
  agentRuntimeInterruptTurn,
  agentRuntimeRespondToApproval,
  agentRuntimeResumeThread,
  agentRuntimeSendTurn,
  agentRuntimeStartWorkspace,
  agentRuntimeSteerTurn,
  agentRuntimeStopWorkspace,
  agentRuntimeSubscribe,
} from "../../../../app/lib/desktop";

/** Renderer facade over the allowlisted Main runtime IPC surface. */
export function createAgentRuntimeClient(kind: RuntimeKind): AgentRuntimeContract {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let removeNativeListener: (() => void) | null = null;
  let subscribePromise: Promise<unknown> | null = null;

  function ensureSubscribed() {
    if (!subscribePromise) {
      subscribePromise = agentRuntimeSubscribe().catch((error) => {
        subscribePromise = null;
        throw error;
      });
      void subscribePromise.catch(() => undefined);
    }
    if (!removeNativeListener) {
      removeNativeListener = window.__JUGGLEWORK_ELECTRON__?.agentRuntime?.onEvent?.((raw) => {
        let event: RuntimeEvent;
        try { event = parseRuntimeEvent(raw); } catch { return; }
        if (event.runtimeKind !== kind) return;
        for (const listener of listeners) listener(event);
      }) ?? null;
    }
  }

  return {
    kind,
    startWorkspace: (input) => agentRuntimeStartWorkspace(kind, input),
    stopWorkspace: (input) => agentRuntimeStopWorkspace(kind, input),
    createThread: (input) => agentRuntimeCreateThread(kind, input),
    resumeThread: (input) => agentRuntimeResumeThread(kind, input),
    archiveThread: (input) => agentRuntimeArchiveThread(kind, input),
    sendTurn: (input) => agentRuntimeSendTurn(kind, input),
    steerTurn: (input) => agentRuntimeSteerTurn(kind, input),
    interruptTurn: (input) => agentRuntimeInterruptTurn(kind, input),
    respondToApproval: (input) => agentRuntimeRespondToApproval(kind, input),
    subscribe(listener) {
      ensureSubscribed();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          removeNativeListener?.();
          removeNativeListener = null;
        }
      };
    },
  };
}
