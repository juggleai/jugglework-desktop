import { useCallback, useEffect, useMemo, useRef } from "react";

import type { JuggleWorkSessionGroupState } from "@/app/lib/jugglework-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import {
  applySessionGroupServerState,
  beginSessionGroupServerSync,
  setSessionGroupSyncHandler,
  useSessionManagementStore,
  type SessionGroupDefinition,
  type SessionGroupServerState,
  type WorkspaceGroupState,
} from "@/react-app/domains/session/sidebar/session-management-store";
import type { RouteWorkspace } from "./route-workspaces";
import { startWorkspaceEventPoll } from "./workspace-event-poll";

const MIGRATION_PREFIX = "jugglework.sessionGroups.migrated.v2";

type UseSessionGroupSyncInput = {
  workspaces: RouteWorkspace[];
  selectedWorkspaceId: string | null;
  endpointForWorkspace: (workspace: RouteWorkspace | null | undefined) => ResolvedWorkspaceEndpoint | null;
};

function hasGroupData(state: SessionGroupServerState | WorkspaceGroupState | undefined): boolean {
  return Boolean(state && (state.groups.length > 0 || Object.keys(state.assignments).length > 0));
}

function serverStateFromWorkspaceState(state: WorkspaceGroupState): JuggleWorkSessionGroupState {
  return {
    groups: state.groups.map((group) => ({ id: group.id, label: group.label })),
    assignments: { ...state.assignments },
  };
}

function localGroupStateForWorkspace(
  workspace: RouteWorkspace,
  endpoint: ResolvedWorkspaceEndpoint,
): WorkspaceGroupState | undefined {
  const byWorkspace = useSessionManagementStore.getState().groupsByWorkspace;
  const ids = [workspace.id, endpoint.workspaceId, `rem_${endpoint.workspaceId}`];
  for (const id of ids) {
    const state = byWorkspace[id];
    if (hasGroupData(state)) return state;
  }
  return undefined;
}

function migrationKey(endpoint: ResolvedWorkspaceEndpoint): string {
  return `${MIGRATION_PREFIX}:${endpoint.baseUrl}:${endpoint.workspaceId}`;
}

function workspaceEndpointSyncKey(
  workspaces: RouteWorkspace[],
  endpointForWorkspace: UseSessionGroupSyncInput["endpointForWorkspace"],
): string {
  return workspaces
    .map((workspace) => {
      const endpoint = endpointForWorkspace(workspace);
      return JSON.stringify([
        workspace.id.trim(),
        endpoint?.baseUrl.trim() ?? "",
        endpoint?.workspaceId.trim() ?? "",
        endpoint?.token.trim() ?? "",
      ]);
    })
    .sort()
    .join("|");
}

function readMigrationComplete(endpoint: ResolvedWorkspaceEndpoint): boolean {
  try {
    return window.localStorage.getItem(migrationKey(endpoint)) === "1";
  } catch {
    return false;
  }
}

function writeMigrationComplete(endpoint: ResolvedWorkspaceEndpoint): void {
  try {
    window.localStorage.setItem(migrationKey(endpoint), "1");
  } catch {
    // ignore storage failures; the next launch can retry safely.
  }
}

export function useSessionGroupSync(input: UseSessionGroupSyncInput) {
  const { workspaces, endpointForWorkspace } = input;
  const workspacesRef = useRef(workspaces);
  const endpointForWorkspaceRef = useRef(endpointForWorkspace);
  const eventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const selectedRef = useRef(input.selectedWorkspaceId);
  const polls = useRef(new Map<string, ReturnType<typeof startWorkspaceEventPoll>>());
  useEffect(() => {
    selectedRef.current = input.selectedWorkspaceId;
    if (input.selectedWorkspaceId) void polls.current.get(input.selectedWorkspaceId)?.refresh();
  }, [input.selectedWorkspaceId]);
  const groupSyncKey = useMemo(
    () => workspaceEndpointSyncKey(workspaces, endpointForWorkspace),
    [endpointForWorkspace, workspaces],
  );

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    endpointForWorkspaceRef.current = endpointForWorkspace;
  }, [endpointForWorkspace]);

  useEffect(() => {
    setSessionGroupSyncHandler({
      createGroup: async (workspaceId: string, group: SessionGroupDefinition) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.createSessionGroup(endpoint.workspaceId, group);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      assignGroup: async (workspaceId: string, sessionId: string, groupId: string | null) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.assignSessionGroup(endpoint.workspaceId, sessionId, groupId);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      reorderGroups: async (workspaceId: string, groupIds: string[]) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.reorderSessionGroups(endpoint.workspaceId, groupIds);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      renameGroup: async (workspaceId: string, groupId: string, label: string) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.renameSessionGroup(endpoint.workspaceId, groupId, label);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      removeGroup: async (workspaceId, groupId, destinationGroupId) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.removeSessionGroup(endpoint.workspaceId, groupId, destinationGroupId);
        writeMigrationComplete(endpoint);
        return response.state;
      },
    });
    return () => setSessionGroupSyncHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncWorkspace = async (workspace: RouteWorkspace, migrateLocal: boolean) => {
      const endpoint = endpointForWorkspaceRef.current(workspace);
      if (!endpoint) return;
      const version = beginSessionGroupServerSync(workspace.id);

      const response = await endpoint.client.getSessionGroups(endpoint.workspaceId);
      if (cancelled) return;

      let nextState = response.state;
      const localState = localGroupStateForWorkspace(workspace, endpoint);
      if (
        migrateLocal &&
        !readMigrationComplete(endpoint) &&
        !hasGroupData(response.state) &&
        localState !== undefined
      ) {
        const migrated = await endpoint.client.putSessionGroups(
          endpoint.workspaceId,
          serverStateFromWorkspaceState(localState),
        );
        if (cancelled) return;
        nextState = migrated.state;
      }

      writeMigrationComplete(endpoint);
      applySessionGroupServerState(workspace.id, nextState, version);
    };

    for (const workspace of workspacesRef.current) {
      const endpoint = endpointForWorkspaceRef.current(workspace);
      if (!endpoint) continue;
      const key = `${endpoint.baseUrl}:${endpoint.workspaceId}`;
      let initialSync = true;
      // Load the sidebar immediately even if the peer's event endpoint is slow.
      const initialRead = syncWorkspace(workspace, true).then(
        () => { initialSync = false; },
        () => { /* Retry via the poller. */ },
      );
      const poll = startWorkspaceEventPoll(async () => {
        const cursor = eventCursorByWorkspaceRef.current[key];
        try {
          const response = await endpoint.client.listSessionGroupEvents(
            endpoint.workspaceId, typeof cursor === "number" ? { since: cursor } : undefined,
          );
          await initialRead;
          if (cancelled) return;
          // A first cursor can include a change made after the initial snapshot.
          if (initialSync || (cursor == null && (response.cursor ?? 0) > 0) || response.items?.length) {
            await syncWorkspace(workspace, initialSync);
            if (cancelled) return;
            initialSync = false;
          }
          eventCursorByWorkspaceRef.current[key] = typeof response.cursor === "number"
            ? response.cursor : Math.max(cursor ?? 0, ...(response.items ?? []).map(item => Number(item.seq) || 0));
        } catch {
          await initialRead;
          if (!cancelled && initialSync) {
            try {
              await syncWorkspace(workspace, true);
              initialSync = false;
            } catch { /* Retry on the next poll. */ }
          }
        }
      }, () => selectedRef.current === workspace.id);
      polls.current.set(workspace.id, poll);
    }
    const refreshSelected = () => {
      if (document.visibilityState !== "hidden" && selectedRef.current) {
        void polls.current.get(selectedRef.current)?.refresh();
      }
    };
    window.addEventListener("focus", refreshSelected);
    document.addEventListener("visibilitychange", refreshSelected);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshSelected);
      document.removeEventListener("visibilitychange", refreshSelected);
      for (const poll of polls.current.values()) poll.stop();
      polls.current.clear();
    };
  }, [groupSyncKey]);

  return useCallback((workspaceId: string) => {
    void polls.current.get(workspaceId)?.refresh();
  }, []);
}
