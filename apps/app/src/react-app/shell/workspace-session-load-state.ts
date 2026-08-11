import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { normalizeDirectoryPath } from "@/app/utils";

import type { RouteWorkspace } from "./route-workspaces";

export const WORKSPACE_SESSION_CACHE_TTL_MS = 30_000;

export type WorkspaceSessionLoadStatus = "idle" | "loading" | "loaded" | "error";

export type WorkspaceSessionLoadState = {
  status: WorkspaceSessionLoadStatus;
  loadedAt: number | null;
  endpointKey: string | null;
  error: string | null;
};

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createWorkspaceSessionEndpointKey(
  workspace: RouteWorkspace,
  endpoint: ResolvedWorkspaceEndpoint | null,
): string | null {
  if (!endpoint) return null;
  return [
    endpoint.baseUrl.trim().replace(/\/+$/, ""),
    endpoint.workspaceId.trim(),
    normalizeDirectoryPath(workspace.path ?? ""),
    fingerprint(endpoint.token),
  ].join("\u001f");
}

export function shouldReloadWorkspaceSessions(input: {
  state: WorkspaceSessionLoadState | undefined;
  endpointKey: string | null;
  selected?: boolean;
  force?: boolean;
  now?: number;
  ttlMs?: number;
}): boolean {
  if (input.force || input.selected) return true;
  if (!input.endpointKey) return false;

  const state = input.state;
  if (!state || state.status === "idle" || state.status === "error") return true;
  if (state.endpointKey !== input.endpointKey) return true;
  if (state.status === "loading") return false;
  if (typeof state.loadedAt !== "number") return true;

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? WORKSPACE_SESSION_CACHE_TTL_MS;
  return now - state.loadedAt >= ttlMs;
}

export function beginWorkspaceSessionLoad(
  previous: WorkspaceSessionLoadState | undefined,
  endpointKey: string,
): WorkspaceSessionLoadState {
  return {
    status: "loading",
    loadedAt: previous?.endpointKey === endpointKey ? previous.loadedAt : null,
    endpointKey,
    error: null,
  };
}

export function completeWorkspaceSessionLoad(
  endpointKey: string,
  loadedAt = Date.now(),
): WorkspaceSessionLoadState {
  return {
    status: "loaded",
    loadedAt,
    endpointKey,
    error: null,
  };
}

export function failWorkspaceSessionLoad(
  previous: WorkspaceSessionLoadState | undefined,
  endpointKey: string | null,
  error: string,
): WorkspaceSessionLoadState {
  return {
    status: "error",
    loadedAt: previous?.endpointKey === endpointKey ? previous.loadedAt : null,
    endpointKey,
    error,
  };
}
