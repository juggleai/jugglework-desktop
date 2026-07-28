/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { JuggleWorkServerStore } from "./jugglework-server-store";

const JuggleWorkServerContext = createContext<JuggleWorkServerStore | null>(null);

export function JuggleWorkServerProvider(props: {
  store: JuggleWorkServerStore;
  children: ReactNode;
}) {
  return (
    <JuggleWorkServerContext.Provider value={props.store}>
      {props.children}
    </JuggleWorkServerContext.Provider>
  );
}

export function useJuggleWorkServer() {
  const store = use(JuggleWorkServerContext);
  if (!store) {
    throw new Error("useJuggleWorkServer must be used within an JuggleWorkServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
