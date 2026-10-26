/** @jsxImportSource react */
import { createContext, use, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AutomationRun } from "@jugglework/types/automation";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { useJuggleWorkServer } from "../connections/jugglework-server-provider";
import { LOCAL_AUTOMATION_ENABLED } from "./automation-feature-flags";

export type AutomationActivity = {
  activeRuns: AutomationRun[];
  hasActiveRuns: boolean;
  refresh: () => Promise<void>;
};

const emptyActivity: AutomationActivity = {
  activeRuns: [],
  hasActiveRuns: false,
  refresh: async () => {},
};
const AutomationActivityContext = createContext<AutomationActivity>(emptyActivity);

/** Fetch every active run, not just the first page or runs for the visible workspace. */
export async function fetchActiveAutomationRuns(
  client: Pick<JuggleWorkServerClient, "listAutomationRuns">,
  signal?: AbortSignal,
): Promise<AutomationRun[]> {
  const runs = new Map<string, AutomationRun>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await client.listAutomationRuns({ status: "queued,running", limit: 100, cursor });
    signal?.throwIfAborted();
    for (const run of page.items) {
      if (run.state === "queued" || run.state === "running") runs.set(run.id, run);
      else runs.delete(run.id);
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Repeated automation activity cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...runs.values()];
}

/** Mounted once under the root server provider, outside all routes and workspace stores. */
export function AutomationActivityProvider({ children }: { children: ReactNode }) {
  const store = useJuggleWorkServer();
  const { juggleworkServerClient: client, juggleworkServerReady: ready } = store.getSnapshot();
  const enabled = LOCAL_AUTOMATION_ENABLED && ready && client !== null;
  const query = useQuery({
    queryKey: ["automation-activity", client?.baseUrl, enabled],
    queryFn: ({ signal }) => client ? fetchActiveAutomationRuns(client, signal) : Promise.resolve([]),
    enabled,
    refetchInterval: enabled ? 2_000 : false,
    refetchIntervalInBackground: true,
    retry: false,
    gcTime: 0,
  });
  // A new connection must fetch successfully before cached runs can light up the rail.
  const activeRuns = enabled && query.isFetchedAfterMount && !query.isError ? query.data ?? emptyActivity.activeRuns : emptyActivity.activeRuns;
  return (
    <AutomationActivityContext.Provider value={{
      activeRuns,
      hasActiveRuns: activeRuns.length > 0,
      refresh: async () => { if (enabled) await query.refetch({ cancelRefetch: false }); },
    }}>
      {children}
    </AutomationActivityContext.Provider>
  );
}

/** Subscribe without creating a query observer or another polling timer. */
export function useAutomationActivity(): AutomationActivity {
  return use(AutomationActivityContext);
}
