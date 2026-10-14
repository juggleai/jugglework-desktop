import { useCallback, useEffect, useRef, useState } from "react";

import { type JuggleWorkServerClient } from "@/app/lib/jugglework-server";

/** Only runtime-managed OpenCode plugin specs are switchable. Marketplace packages are not. */
export function useWorkspacePluginPolicy(input: { client: JuggleWorkServerClient | null; workspaceId: string | null }) {
  const queueRef = useRef(Promise.resolve());
  const scopeRef = useRef({ ...input, active: true, ready: false, generation: 0,
    specs: [] as string[], controllable: [] as string[] });
  if (scopeRef.current.client !== input.client || scopeRef.current.workspaceId !== input.workspaceId) {
    scopeRef.current = { ...input, active: true, ready: false, generation: 0, specs: [], controllable: [] };
  }
  const scope = scopeRef.current;
  const [state, setState] = useState({
    scope,
    disabledPluginSpecs: [] as string[],
    controllablePluginSpecs: [] as string[],
    available: false,
    savingSpec: null as string | null,
    error: null as string | null,
  });
  const isCurrent = useCallback(() => scopeRef.current === scope && scope.active, [scope]);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const generation = ++scope.generation;
    scope.ready = false;
    setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
      available: false, savingSpec: null, error: null });
    if (!scope.client || !scope.workspaceId) return;
    try {
      // A full-list read must not race a previously queued full-list write.
      await queueRef.current;
      if (!isCurrent() || generation !== scope.generation) return;
      const policy = await scope.client.getPluginPolicy(scope.workspaceId);
      if (!isCurrent() || generation !== scope.generation) return;
      scope.specs = policy.disabledPluginSpecs;
      scope.controllable = policy.controllablePluginSpecs;
      scope.ready = policy.enforcementReady;
      setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
        available: scope.ready, savingSpec: null, error: null });
    } catch (reason) {
      if (!isCurrent() || generation !== scope.generation) return;
      setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
        available: false, savingSpec: null,
        error: reason instanceof Error ? reason.message : "Failed to load plugin policy" });
    }
  }, [isCurrent, scope]);

  useEffect(() => {
    scope.active = true;
    void refresh();
    return () => { scope.active = false; scope.generation++; };
  }, [refresh, scope]);

  const setPluginEnabled = useCallback(async (spec: string, enabled: boolean) => {
    const { client, workspaceId } = scope;
    if (!isCurrent() || !client || !workspaceId || !scope.ready) return;
    if (!scope.controllable.includes(spec)) return;
    const next = enabled
      ? scope.specs.filter((item) => item !== spec)
      : [...new Set([...scope.specs, spec])].sort((a, b) => a.localeCompare(b));
    scope.specs = next;
    setState({ scope, disabledPluginSpecs: next, controllablePluginSpecs: scope.controllable,
      available: true, savingSpec: spec, error: null });
    const generation = ++scope.generation;
    queueRef.current = queueRef.current.then(async () => {
      // Keep same-workspace writes ordered, but never dispatch an abandoned scope's writes.
      if (!isCurrent()) return;
      try {
        const policy = await client.setPluginPolicy(workspaceId, next);
        if (!isCurrent() || generation !== scope.generation) return;
        scope.specs = policy.disabledPluginSpecs;
        setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
          available: scope.ready, savingSpec: null, error: null });
      } catch (reason) {
        if (!isCurrent() || generation !== scope.generation) return;
        scope.ready = false;
        setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
          available: false, savingSpec: null, error: null });
        try {
          // Recover inside this queue entry; public refresh waits for the queue.
          const policy = await client.getPluginPolicy(workspaceId);
          if (!isCurrent() || generation !== scope.generation) return;
          scope.specs = policy.disabledPluginSpecs;
          scope.controllable = policy.controllablePluginSpecs;
          scope.ready = policy.enforcementReady;
        } catch {
          if (!isCurrent() || generation !== scope.generation) return;
        }
        setState({ scope, disabledPluginSpecs: scope.specs, controllablePluginSpecs: scope.controllable,
          available: scope.ready, savingSpec: null,
          error: reason instanceof Error ? reason.message : "Failed to update plugin policy" });
      }
    });
    await queueRef.current;
  }, [isCurrent, scope]);

  // Gate during render, before the new scope's effect can run.
  const current = state.scope === scope;
  return {
    available: current && state.available,
    controllablePluginSpecs: current ? state.controllablePluginSpecs : [],
    disabledPluginSpecs: current ? state.disabledPluginSpecs : [],
    savingSpec: current ? state.savingSpec : null,
    error: current ? state.error : null,
    refresh,
    setPluginEnabled,
  };
}
