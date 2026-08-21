import { useMemo } from "react";

import type { TodoItem } from "@/app/types";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { todoKey } from "./session-sync";

const EMPTY_TODOS: TodoItem[] = [];

/** Subscribe to progress for the exact runtime workspace/session surface. */
export function useSessionTodos(workspaceId: string, sessionId: string): TodoItem[] {
  const queryKey = useMemo(
    () => workspaceId && sessionId ? todoKey(workspaceId, sessionId) : null,
    [sessionId, workspaceId],
  );
  return useQueryCacheState<TodoItem[]>(queryKey, EMPTY_TODOS);
}
