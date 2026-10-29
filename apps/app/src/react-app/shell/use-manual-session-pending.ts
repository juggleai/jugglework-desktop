import { useSyncExternalStore } from "react";
import { manualSessionCreation } from "./manual-session-creation";

export function useManualSessionPending(key: string) {
  useSyncExternalStore(
    manualSessionCreation.subscribe,
    manualSessionCreation.revision,
    () => 0,
  );
  return manualSessionCreation.pending(key);
}
