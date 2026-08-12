/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { JuggleWorkServerStore, JuggleWorkServerStoreSnapshot } from "./jugglework-server-store";

const JuggleWorkServerContext = createContext<JuggleWorkServerStore | null>(null);
const subscribeToMissingStore = () => () => {};
const getMissingStoreSnapshot = (): JuggleWorkServerStoreSnapshot | null => null;

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

/**
 * 可选读取本机 JuggleWork Server。
 *
 * TIPS: 根级后台协调器会在工作区 Store 创建前挂载；此时返回 null，
 * 不能像强约束 hook 一样抛错，否则会让整个 React 根节点白屏。
 * @returns 当前 Store；尚未处于 Provider 中时返回 null
 */
export function useOptionalJuggleWorkServer(): JuggleWorkServerStore | null {
  const store = use(JuggleWorkServerContext);
  useSyncExternalStore<JuggleWorkServerStoreSnapshot | null>(
    store?.subscribe ?? subscribeToMissingStore,
    store?.getSnapshot ?? getMissingStoreSnapshot,
    store?.getSnapshot ?? getMissingStoreSnapshot,
  );
  return store;
}
