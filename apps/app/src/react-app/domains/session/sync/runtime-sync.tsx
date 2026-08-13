/** @jsxImportSource react */
import { useEffect } from "react";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";
import type { RuntimeKind } from "@jugglework/types/agent-runtime";

import { ensureWorkspaceSessionSync, trackWorkspaceSessionsSync } from "./session-sync";
import { createAgentRuntimeClient } from "./agent-runtime-client";
import { useRuntimeSelectionStore } from "./runtime-selection-store";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { permissionKey, snapshotKey } from "./session-sync";
import type { PendingPermission } from "@/app/types";

const runtimeClients = new Map<RuntimeKind, ReturnType<typeof createAgentRuntimeClient>>();
function runtimeClient(kind: RuntimeKind) {
  let client = runtimeClients.get(kind);
  if (!client) {
    client = createAgentRuntimeClient(kind);
    runtimeClients.set(kind, client);
  }
  return client;
}

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  activeSessionIds?: string[];
  opencodeBaseUrl: string;
  juggleworkToken: string;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
  runtimeKind?: RuntimeKind;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  useEffect(() => {
    if (props.runtimeKind !== "codex") return;
    return runtimeClient("codex").subscribe((event) => {
      useRuntimeSelectionStore.getState().applyEvent(event);
      if (!("sessionId" in event) || event.workspaceId !== props.workspaceId) return;
      if (event.type === "approval.requested") {
        const permission: PendingPermission = {
          id: event.request.id, sessionID: event.sessionId, permission: event.request.kind,
          patterns: [], metadata: { description: event.request.description }, always: [], receivedAt: event.occurredAt, protocol: "legacy",
        };
        getReactQueryClient().setQueryData<PendingPermission[]>(permissionKey(event.workspaceId, event.sessionId), [permission]);
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
        getReactQueryClient().setQueryData<PendingPermission[]>(permissionKey(event.workspaceId, event.sessionId), []);
      }
      void getReactQueryClient().invalidateQueries({ queryKey: snapshotKey(event.workspaceId, event.sessionId) });
    });
  }, [props.runtimeKind, props.workspaceId]);

  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      juggleworkToken: props.juggleworkToken,
      onSessionCreated: props.onSessionCreated,
      onSessionUpdated: props.onSessionUpdated,
      onSessionDeleted: props.onSessionDeleted,
      onSessionStatus: props.onSessionStatus,
    };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSessions = trackWorkspaceSessionsSync(input, [props.sessionId, ...(props.activeSessionIds ?? [])]);
    return () => {
      releaseSessions();
      releaseWorkspace();
    };
  }, [props.workspaceId, props.sessionId, props.activeSessionIds, props.opencodeBaseUrl, props.juggleworkToken, props.onSessionCreated, props.onSessionUpdated, props.onSessionDeleted, props.onSessionStatus]);

  return null;
}

export { runtimeClient as getAgentRuntimeClient };
