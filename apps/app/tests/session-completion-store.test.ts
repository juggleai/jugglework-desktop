import { beforeEach, describe, expect, it } from "bun:test";

import { useSessionCompletionStore } from "../src/react-app/domains/session/sidebar/session-completion-store";

const accessible = new Set(["session-a", "session-b"]);

describe("session completion store", () => {
  beforeEach(() => {
    useSessionCompletionStore.setState({ unseenSessionIds: [], previousStatusBySessionId: {} });
  });

  it("marks only an unseen running-to-terminal transition", () => {
    const store = useSessionCompletionStore.getState();
    store.reconcile({ "session-a": "idle" }, accessible, new Set());
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual([]);
    store.reconcile({ "session-a": "running" }, accessible, new Set());
    store.reconcile({ "session-a": "idle" }, accessible, new Set());
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual(["session-a"]);
  });

  it("does not mark a visible completion and clears when opened", () => {
    const store = useSessionCompletionStore.getState();
    store.reconcile({ "session-a": "running", "session-b": "running" }, accessible, new Set());
    store.reconcile({ "session-a": "idle", "session-b": "idle" }, accessible, new Set(["session-a"]));
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual(["session-b"]);
    useSessionCompletionStore.getState().clear("session-b");
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual([]);
  });

  it("running again clears the previous completion marker", () => {
    const store = useSessionCompletionStore.getState();
    store.reconcile({ "session-a": "running" }, accessible, new Set());
    store.reconcile({ "session-a": "error" }, accessible, new Set());
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual(["session-a"]);
    store.reconcile({ "session-a": "retrying" }, accessible, new Set());
    expect(useSessionCompletionStore.getState().unseenSessionIds).toEqual([]);
  });
});
