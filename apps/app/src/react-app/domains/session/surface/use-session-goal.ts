import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  JuggleWorkGoalCriterionInput,
  JuggleWorkGoalRunOptions,
  JuggleWorkGoalStartResult,
  JuggleWorkServerClient,
  JuggleWorkSessionGoal,
} from "../../../../app/lib/jugglework-server";

export function sessionGoalQueryKey(workspaceId: string, sessionId: string) {
  return ["session-goal", workspaceId, sessionId] as const;
}

/** Model-facing goal tools served by the jugglework-goal OpenCode plugin. */
export function isGoalToolName(name: string | undefined): boolean {
  return typeof name === "string" && name.startsWith("jugglework_goal_");
}

/** A goal that still owns the session: shown on the goal card and blocks creating another. */
export function isGoalUnfinished(goal: JuggleWorkSessionGoal | null | undefined): goal is JuggleWorkSessionGoal {
  return Boolean(goal && goal.status !== "completed" && goal.status !== "cancelled");
}

/** Whether the user can start the next goal run from the card. */
export function canContinueGoal(goal: JuggleWorkSessionGoal | null | undefined, sessionRunning: boolean): boolean {
  if (!goal || goal.status !== "active" || sessionRunning) return false;
  return goal.execution === "idle" || goal.execution === "waiting_user" || goal.execution === "usage_limited";
}

/** Required criteria met or waived, out of all required criteria. */
export function goalCriteriaProgress(goal: JuggleWorkSessionGoal): { done: number; total: number } {
  const required = goal.criteria.filter((criterion) => criterion.required);
  return { done: required.filter((criterion) => criterion.status !== "pending").length, total: required.length };
}

/**
 * Current session goal plus its lifecycle mutations. `enabled` should be
 * false outside local workspaces, where goals are not offered.
 */
export function useSessionGoal(input: {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  enabled: boolean;
  /** Called after any mutation that may have started a run. */
  onRunStarted?: (result: JuggleWorkGoalStartResult) => void;
}) {
  const queryClient = useQueryClient();
  const key = sessionGoalQueryKey(input.workspaceId, input.sessionId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => input.client.getSessionGoal(input.workspaceId, input.sessionId, { signal }).then((result) => result.item),
    enabled: input.enabled,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    // Server-side run endings change execution without a renderer event;
    // poll only while a goal is unfinished.
    refetchInterval: (state) => isGoalUnfinished(state.state.data) ? 5_000 : false,
  });

  const setGoal = (goal: JuggleWorkSessionGoal | null) => queryClient.setQueryData(key, goal);
  const conflictRefresh = () => { void queryClient.invalidateQueries({ queryKey: key }); };

  const create = useMutation({
    mutationFn: (body: { objective: string; criteria: JuggleWorkGoalCriterionInput[]; run?: JuggleWorkGoalRunOptions }) =>
      input.client.createSessionGoal(input.workspaceId, input.sessionId, body),
    onSuccess: (result) => {
      setGoal(result.item);
      if (result.run) input.onRunStarted?.(result);
    },
    onError: conflictRefresh,
  });

  const edit = useMutation({
    mutationFn: (body: { objective?: string; criteria?: JuggleWorkGoalCriterionInput[] }) => {
      const goal = query.data;
      if (!goal) throw new Error("No goal to edit");
      return input.client.editSessionGoal(input.workspaceId, input.sessionId, goal.id, { expectedVersion: goal.version, ...body });
    },
    onSuccess: (result) => setGoal(result.item),
    onError: conflictRefresh,
  });

  const lifecycle = useMutation({
    mutationFn: (action: { type: "pause" | "resume" | "cancel" } | { type: "complete"; override: boolean }) => {
      const goal = query.data;
      if (!goal) throw new Error("No goal to update");
      return input.client.updateSessionGoalLifecycle(input.workspaceId, input.sessionId, goal.id, action.type, {
        expectedVersion: goal.version,
        ...(action.type === "complete" ? { override: action.override } : {}),
      });
    },
    onSuccess: (result) => setGoal(result.item),
    onError: conflictRefresh,
  });

  const continueGoal = useMutation({
    mutationFn: (run?: JuggleWorkGoalRunOptions) => {
      const goal = query.data;
      if (!goal) throw new Error("No goal to continue");
      return input.client.continueSessionGoal(input.workspaceId, input.sessionId, goal.id, { expectedVersion: goal.version, run });
    },
    onSuccess: (result) => {
      setGoal(result.item);
      input.onRunStarted?.(result);
    },
    onError: conflictRefresh,
  });

  return { query, goal: query.data ?? null, create, edit, lifecycle, continueGoal };
}
