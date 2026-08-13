import type { CanonicalAgentSession } from "@jugglework/types/agent-runtime";

import { createCanonicalAgentClient } from "@/app/lib/agent-client";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { SidebarSessionItem } from "@/app/types";
import { getReactQueryClient } from "@/react-app/infra/query-client";

import { canonicalAgentCacheKeys } from "./canonical-agent-cache";

export function canonicalSessionToSidebarSession(session: CanonicalAgentSession): SidebarSessionItem {
  const configuration = session.configuration as {
    agentProfile?: unknown;
    model?: { providerId?: unknown; modelId?: unknown };
    execution?: SidebarSessionItem["runtimeExecution"];
  };
  const runtimeModel = configuration.model
    && typeof configuration.model.providerId === "string"
    && typeof configuration.model.modelId === "string"
    ? { providerId: configuration.model.providerId, modelId: configuration.model.modelId }
    : null;
  return {
    id: session.id,
    title: session.title,
    directory: session.canonicalCwd,
    status: session.status,
    time: { created: session.createdAt, updated: session.updatedAt },
    runtimeId: session.runtimeId,
    backendSessionId: session.backendSessionId,
    agentProfile: typeof configuration.agentProfile === "string" ? configuration.agentProfile : null,
    runtimeModel,
    runtimeExecution: configuration.execution ?? null,
    canonical: true,
  };
}

export async function readCanonicalSessions(input: {
  endpoint: ResolvedWorkspaceEndpoint;
  options?: { start?: number; search?: string; limit?: number };
}): Promise<SidebarSessionItem[]> {
  const client = createCanonicalAgentClient(input.endpoint);
  const sessions = await client.listSessions(input.options);
  const queryClient = getReactQueryClient();
  queryClient.setQueryData(canonicalAgentCacheKeys.sessions(input.endpoint.workspaceId), sessions);
  for (const session of sessions) {
    queryClient.setQueryData(canonicalAgentCacheKeys.session(input.endpoint.workspaceId, session.id), session);
    queryClient.setQueryData(canonicalAgentCacheKeys.status(input.endpoint.workspaceId, session.id), session.status);
  }
  return sessions.map(canonicalSessionToSidebarSession);
}

export async function readCanonicalSession(input: {
  endpoint: ResolvedWorkspaceEndpoint;
  sessionId: string;
}): Promise<SidebarSessionItem> {
  const client = createCanonicalAgentClient(input.endpoint);
  const session = await client.getSession(input.sessionId);
  const queryClient = getReactQueryClient();
  queryClient.setQueryData(canonicalAgentCacheKeys.session(input.endpoint.workspaceId, session.id), session);
  queryClient.setQueryData(canonicalAgentCacheKeys.status(input.endpoint.workspaceId, session.id), session.status);
  return canonicalSessionToSidebarSession(session);
}
