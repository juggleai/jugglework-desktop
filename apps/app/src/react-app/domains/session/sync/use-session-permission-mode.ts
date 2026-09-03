/**
 * Session permission mode state hook.
 *
 * Server-owned authority: reads the authoritative mode/grant state from the
 * workspace-owning server, provides optimistic-free updates with stale-
 * revision error surfacing, and never falls back to a local-only Full access
 * value (spec: session-permission-modes).
 */

import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  SessionPermissionGrantRecord,
  SessionPermissionModeChoice,
  SessionPermissionModeState,
} from "@jugglework/types/session-permission-modes";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { t } from "@/i18n";
import { describeRouteError } from "@/react-app/shell/route-workspaces";

export function sessionPermissionModeKey(workspaceId: string, sessionId: string) {
  return ["session-permission-mode", workspaceId, sessionId] as const;
}

export type SessionPermissionModeHookInput = {
  client: JuggleWorkServerClient | null;
  workspaceId: string;
  sessionId: string | null;
};

export type SessionPermissionModeHook = {
  state: SessionPermissionModeState | null;
  grants: SessionPermissionGrantRecord[];
  loading: boolean;
  updating: boolean;
  supported: boolean;
  profileVersion: number | null;
  /** Enable Full access with a current-profile acknowledgement. */
  enableFullAccess: () => Promise<boolean>;
  /** Return to request approval; clears grants unconditionally. */
  requestApproval: () => Promise<boolean>;
  clearGrants: () => Promise<boolean>;
};

export function useSessionPermissionMode(input: SessionPermissionModeHookInput): SessionPermissionModeHook {
  const { client, workspaceId, sessionId } = input;
  const queryClient = useQueryClient();
  const queryKey = sessionId ? sessionPermissionModeKey(workspaceId, sessionId) : null;

  const read = useQuery({
    queryKey: queryKey ?? ["session-permission-mode", workspaceId, "none"],
    queryFn: () => client!.getSessionPermissionMode(workspaceId, sessionId!),
    enabled: Boolean(client && sessionId),
    staleTime: 30_000,
    retry: 1,
  });

  const revisionRef = useRef<number | null>(null);
  const data = read.data ?? null;
  if (data?.state) revisionRef.current = data.state.authorityRevision;

  const invalidate = useCallback(() => {
    if (queryKey) void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const showError = useCallback((error: unknown, code: string) => {
    toast.error(t(code), { description: describeRouteError(error) });
  }, []);

  const updateMode = useMutation({
    mutationFn: async (payload: {
      requestedMode: SessionPermissionModeChoice;
      acknowledgementProfileVersion: number | null;
    }) => {
      const profileVersion = data?.profileVersion;
      if (!client || !sessionId) throw new Error("unavailable");
      return client.updateSessionPermissionMode(workspaceId, sessionId, {
        requestedMode: payload.requestedMode,
        expectedRevision: data?.state?.authorityRevision ?? 0,
        acknowledgement: payload.acknowledgementProfileVersion != null && profileVersion != null
          ? { profileVersion: payload.acknowledgementProfileVersion, acknowledgedAt: Date.now() }
          : null,
      });
    },
    onSuccess: () => invalidate(),
    onError: (error) => showError(error, "session.permission_mode_update_failed"),
  });

  const clearGrantsMutation = useMutation({
    mutationFn: () => client!.clearSessionPermissionGrants(workspaceId, sessionId!),
    onSuccess: () => invalidate(),
    onError: (error) => showError(error, "session.permission_mode_update_failed"),
  });

  const enableFullAccess = useCallback(async () => {
    const profileVersion = data?.profileVersion ?? null;
    const result = await updateMode.mutateAsync({
      requestedMode: "full-access",
      acknowledgementProfileVersion: profileVersion,
    });
    return result.state.effectiveMode === "full-access";
  }, [data?.profileVersion, updateMode]);

  const requestApproval = useCallback(async () => {
    const result = await updateMode.mutateAsync({
      requestedMode: "request-approval",
      acknowledgementProfileVersion: null,
    });
    return result.state.effectiveMode === "request-approval";
  }, [updateMode]);

  return useMemo(() => ({
    state: data?.state ?? null,
    grants: data?.grants ?? [],
    loading: read.isLoading,
    updating: updateMode.isPending || clearGrantsMutation.isPending,
    supported: data?.supported ?? true,
    profileVersion: data?.profileVersion ?? null,
    enableFullAccess,
    requestApproval,
    clearGrants: async () => {
      await clearGrantsMutation.mutateAsync();
      return true;
    },
  }), [data, read.isLoading, updateMode.isPending, clearGrantsMutation.isPending, enableFullAccess, requestApproval, clearGrantsMutation]);
}
