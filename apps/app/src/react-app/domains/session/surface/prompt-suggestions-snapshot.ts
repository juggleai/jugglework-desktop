import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { readPromptSuggestionIdentity } from "./prompt-suggestions";

/** Renderer-only cache metadata, never part of the server snapshot protocol. */
export type ClientHistorySnapshot = JuggleWorkSessionSnapshot & { clientHistoryIdentity?: string | null };

export async function readPromptSuggestionSnapshot(
  read: (signal: AbortSignal) => Promise<JuggleWorkSessionSnapshot>, signal: AbortSignal,
): Promise<ClientHistorySnapshot> {
  const identity = readPromptSuggestionIdentity();
  const snapshot = await read(signal);
  // A plain enumerable field survives session.updated spreads and React Query's
  // replaceEqualDeep. Keep the original object for unrelated revision metadata.
  return Object.assign(snapshot, { clientHistoryIdentity:
    !signal.aborted && identity === readPromptSuggestionIdentity() ? identity : null });
}

export function usePromptSuggestionSnapshotRefresh(queryClient: QueryClient, queryKey: readonly unknown[], identity: string) {
  const previous = useRef(identity);
  useEffect(() => {
    const changed = previous.current !== identity;
    previous.current = identity;
    let active = true;
    const refresh = async () => {
      // Cancel even an initial no-data fetch: refetch alone would deduplicate
      // against the old account's in-flight request instead of reading anew.
      if (changed) await queryClient.cancelQueries({ queryKey, exact: true });
      if (active) await queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
    };
    void refresh();
    return () => { active = false; };
  }, [queryClient, queryKey, identity]);
}
