import { useCallback, useEffect, useRef, useState } from "react";

import { type JuggleWorkServerClient } from "@/app/lib/jugglework-server";

/** Workspace-scoped skill availability. The server enforces calls independently of this hook. */
export function useWorkspaceSkillPolicy(input: { client: JuggleWorkServerClient | null; workspaceId: string | null }) {
  const queueRef = useRef(Promise.resolve());
  const scopeRef = useRef({ ...input, active: true, ready: false, generation: 0, names: [] as string[] });
  if (scopeRef.current.client !== input.client || scopeRef.current.workspaceId !== input.workspaceId) {
    scopeRef.current = { ...input, active: true, ready: false, generation: 0, names: [] };
  }
  const scope = scopeRef.current;
  const [state, setState] = useState({
    scope,
    disabledSkillNames: [] as string[],
    available: false,
    savingName: null as string | null,
    error: null as string | null,
  });
  const isCurrent = useCallback(() => scopeRef.current === scope && scope.active, [scope]);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const generation = ++scope.generation;
    scope.ready = false;
    setState({ scope, disabledSkillNames: scope.names, available: false, savingName: null, error: null });
    if (!scope.client || !scope.workspaceId) return;
    try {
      // A full-list read must not race a previously queued full-list write.
      await queueRef.current;
      if (!isCurrent() || generation !== scope.generation) return;
      const policy = await scope.client.getSkillPolicy(scope.workspaceId);
      if (!isCurrent() || generation !== scope.generation) return;
      scope.names = policy.disabledSkillNames;
      scope.ready = policy.enforcementReady;
      setState({ scope, disabledSkillNames: scope.names, available: scope.ready, savingName: null, error: null });
    } catch (reason) {
      if (!isCurrent() || generation !== scope.generation) return;
      setState({ scope, disabledSkillNames: scope.names, available: false, savingName: null,
        error: reason instanceof Error ? reason.message : "Failed to load skill policy" });
    }
  }, [isCurrent, scope]);

  useEffect(() => {
    scope.active = true;
    void refresh();
    return () => { scope.active = false; scope.generation++; };
  }, [refresh, scope]);

  const setSkillEnabled = useCallback(async (name: string, enabled: boolean) => {
    const { client, workspaceId } = scope;
    if (!isCurrent() || !client || !workspaceId || !scope.ready) return;
    const next = enabled
      ? scope.names.filter((item) => item !== name)
      : [...new Set([...scope.names, name])].sort((a, b) => a.localeCompare(b));
    scope.names = next;
    setState({ scope, disabledSkillNames: next, available: true, savingName: name, error: null });
    const generation = ++scope.generation;
    queueRef.current = queueRef.current.then(async () => {
      // Keep same-workspace writes ordered, but never dispatch an abandoned scope's writes.
      if (!isCurrent()) return;
      try {
        const policy = await client.setSkillPolicy(workspaceId, next);
        if (!isCurrent() || generation !== scope.generation) return;
        scope.names = policy.disabledSkillNames;
        setState({ scope, disabledSkillNames: scope.names, available: scope.ready, savingName: null, error: null });
      } catch (reason) {
        if (!isCurrent() || generation !== scope.generation) return;
        scope.ready = false;
        setState({ scope, disabledSkillNames: scope.names, available: false, savingName: null, error: null });
        try {
          // Recover inside this queue entry; public refresh waits for the queue.
          const policy = await client.getSkillPolicy(workspaceId);
          if (!isCurrent() || generation !== scope.generation) return;
          scope.names = policy.disabledSkillNames;
          scope.ready = policy.enforcementReady;
        } catch {
          if (!isCurrent() || generation !== scope.generation) return;
        }
        setState({ scope, disabledSkillNames: scope.names, available: scope.ready, savingName: null,
          error: reason instanceof Error ? reason.message : "Failed to update skill policy" });
      }
    });
    await queueRef.current;
  }, [isCurrent, scope]);

  // Gate during render, before the new scope's effect can run.
  const current = state.scope === scope;
  return {
    available: current && state.available,
    disabledSkillNames: current ? state.disabledSkillNames : [],
    savingName: current ? state.savingName : null,
    error: current ? state.error : null,
    refresh,
    setSkillEnabled,
  };
}
