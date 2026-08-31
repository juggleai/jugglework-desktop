/** @jsxImportSource react */
import { useEffect } from "react";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionsSync } from "./session-sync";
import { seedWorkspaceSessionAncestry } from "./workspace-interactions";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  activeSessionIds?: string[];
  sessions?: Array<Pick<Session, "id" | "parentID">>;
  opencodeBaseUrl: string;
  juggleworkToken: string;
  interactionClient: JuggleWorkServerClient;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  useEffect(() => {
    seedWorkspaceSessionAncestry(props.workspaceId, props.sessions ?? []);
  }, [props.sessions, props.workspaceId]);

  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      juggleworkToken: props.juggleworkToken,
      interactionClient: props.interactionClient,
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
  }, [props.workspaceId, props.sessionId, props.activeSessionIds, props.opencodeBaseUrl, props.juggleworkToken, props.interactionClient, props.onSessionCreated, props.onSessionUpdated, props.onSessionDeleted, props.onSessionStatus]);

  return null;
}
