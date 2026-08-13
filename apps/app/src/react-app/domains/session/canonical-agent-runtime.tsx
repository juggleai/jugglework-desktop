/** @jsxImportSource react */
import { useEffect } from "react";

import { createCanonicalAgentClient } from "@/app/lib/agent-client";
import { publishCanonicalAgentSnapshot } from "./canonical-agent-cache";
import { createCanonicalAgentSync } from "./canonical-agent-sync";
import { useSessionActivityStore } from "./status/session-activity-store";

type CanonicalAgentRuntimeProps = {
  enabled: boolean;
  baseUrl: string;
  workspaceId: string;
  token: string;
};

function publishSnapshot(workspaceId: string, snapshot: Parameters<typeof publishCanonicalAgentSnapshot>[0]): void {
  publishCanonicalAgentSnapshot(snapshot);
  const activity = useSessionActivityStore.getState();
  activity.setRunStatus(workspaceId, snapshot.session.id, snapshot.session.status);
  const pending = snapshot.interactions.filter((interaction) => interaction.state === "pending");
  activity.replaceWaitingRequests(workspaceId, snapshot.session.id, "permission", pending.flatMap((item) => item.kind === "permission" ? [item.id] : []));
  activity.replaceWaitingRequests(workspaceId, snapshot.session.id, "question", pending.flatMap((item) => item.kind === "question" ? [item.id] : []));
  if (snapshot.session.lastError) activity.setError(workspaceId, snapshot.session.id, snapshot.session.lastError.message);
  else activity.clearError(workspaceId, snapshot.session.id);
  const assistant = snapshot.messages.at(-1);
  if (assistant?.role === "assistant" && assistant.parts.length > 0) {
    activity.markAssistantOutput(workspaceId, snapshot.session.id, assistant.id, { allowUnknownMessageRole: true });
  }
}

export function CanonicalAgentRuntime(props: CanonicalAgentRuntimeProps) {
  useEffect(() => {
    if (!props.enabled || !props.baseUrl || !props.workspaceId || !props.token) return;
    const client = createCanonicalAgentClient({
      baseUrl: props.baseUrl,
      workspaceId: props.workspaceId,
      token: props.token,
    });
    let cancelled = false;
    let sync: ReturnType<typeof createCanonicalAgentSync> | null = null;
    void client.listWorkspaceSnapshots().then((snapshots) => {
      if (cancelled) return;
      for (const snapshot of snapshots) publishSnapshot(props.workspaceId, snapshot);
      sync = createCanonicalAgentSync({
        client,
        initialSnapshots: snapshots,
        onSnapshot: (snapshot) => publishSnapshot(props.workspaceId, snapshot),
      });
      sync.start();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      sync?.stop();
    };
  }, [props.baseUrl, props.enabled, props.token, props.workspaceId]);

  return null;
}
