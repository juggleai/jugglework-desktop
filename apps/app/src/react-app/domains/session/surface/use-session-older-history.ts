import { useEffect, useMemo, useRef, useState } from "react";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";

import { recordInspectorEvent } from "@/app/lib/app-inspector";
import type {
  JuggleWorkServerClient,
  JuggleWorkSessionMessagePage,
} from "@/app/lib/jugglework-server";
import {
  appendSessionHistoryPage,
  reconcileSessionHistoryRoot,
  resolveOlderHistoryCursor,
  SESSION_HISTORY_PAGE_SIZE,
  sessionHistoryKey,
  type SessionHistoryData,
} from "../sync/session-history";

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export function useSessionOlderHistory(input: {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  initialPage: JuggleWorkSessionMessagePage | null | undefined;
}) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => sessionHistoryKey(input.workspaceId, input.sessionId),
    [input.sessionId, input.workspaceId],
  );
  const initialCursor = input.initialPage?.hasOlder === true ? input.initialPage.olderCursor : null;
  const query = useQuery<SessionHistoryData>({
    queryKey,
    queryFn: async () => ({ pages: [], pageParams: [], rootCursor: initialCursor, detached: [] }),
    initialData: { pages: [], pageParams: [], rootCursor: initialCursor, detached: [] },
    enabled: false,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
  const data = reconcileSessionHistoryRoot(query.data, initialCursor);
  const cursorState = resolveOlderHistoryCursor({
    initialPage: input.initialPage,
    pages: data.pages,
    pageParams: data.pageParams,
  });
  const scopeKey = `${input.workspaceId}:${input.sessionId}`;
  const generationKey = `${scopeKey}:${initialCursor ?? "end"}`;
  const reportedLoopRef = useRef<{ scopeKey: string; reported: boolean }>({ scopeKey, reported: false });
  const inFlightRef = useRef<{ scopeKey: string; promise: Promise<boolean> } | null>(null);
  const [loadingGeneration, setLoadingGeneration] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ generationKey: string; error: Error } | null>(null);

  if (reportedLoopRef.current.scopeKey !== scopeKey) {
    reportedLoopRef.current = { scopeKey, reported: false };
  }

  useEffect(() => () => {
    queueMicrotask(() => {
      const activeObservers = queryClient.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() ?? 0;
      if (activeObservers === 0) void queryClient.cancelQueries({ queryKey, exact: false });
    });
  }, [queryClient, queryKey]);

  useEffect(() => {
    queryClient.setQueryData<SessionHistoryData>(queryKey, (current) =>
      reconcileSessionHistoryRoot(current, initialCursor));
    void queryClient.cancelQueries({ queryKey: [...queryKey, "page"], exact: false });
    inFlightRef.current = null;
  }, [initialCursor, queryClient, queryKey]);

  useEffect(() => {
    setFailure(null);
    setLoadingGeneration(null);
  }, [scopeKey]);

  useEffect(() => {
    if (!cursorState.loopDetected || reportedLoopRef.current.reported) return;
    reportedLoopRef.current.reported = true;
    recordInspectorEvent("session.history_cursor_loop", {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
  }, [cursorState.loopDetected, input.sessionId, input.workspaceId]);

  const loadOlder = () => {
    if (!cursorState.cursor) return Promise.resolve(false);
    if (inFlightRef.current?.scopeKey === generationKey) return inFlightRef.current.promise;
    const cursor = cursorState.cursor;
    const requestKey = [...queryKey, "page", initialCursor, cursor] as const;
    queryClient.setQueryData<SessionHistoryData>(queryKey, (current) =>
      reconcileSessionHistoryRoot(current, initialCursor));
    setLoadingGeneration(generationKey);
    setFailure(null);
    const promise = queryClient.fetchQuery({
      queryKey: requestKey,
      queryFn: ({ signal }) => input.client.getSessionMessages(input.workspaceId, input.sessionId, {
        limit: SESSION_HISTORY_PAGE_SIZE,
        before: cursor,
        signal,
      }),
      retry: false,
      staleTime: 0,
      gcTime: 0,
    })
      .then((page) => {
        queryClient.setQueryData<SessionHistoryData>(queryKey, (current) => {
          if (current?.rootCursor !== initialCursor) return current;
          return appendSessionHistoryPage({ data: current, cursor, page });
        });
        return true;
      })
      .catch((thrown: unknown) => {
        if (!isAbortError(thrown) && !isCancelledError(thrown)) {
          setFailure({ generationKey, error: thrown instanceof Error ? thrown : new Error(String(thrown)) });
        }
        return false;
      })
      .finally(() => {
        if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
        setLoadingGeneration((current) => current === generationKey ? null : current);
      });
    inFlightRef.current = { scopeKey: generationKey, promise };
    return promise;
  };

  return {
    pages: data.pages,
    hasOlder: cursorState.cursor !== null,
    isLoadingOlder: loadingGeneration === generationKey,
    error: failure?.generationKey === generationKey ? failure.error : null,
    generationKey,
    loadOlder,
  };
}
