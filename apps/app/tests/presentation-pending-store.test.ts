import { beforeEach, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const {
  PERSISTED_PRESENTATION_PENDING_STORE_KEY,
  getPendingPresentationTurnIds,
  usePresentationPendingStore,
} = await import("../src/react-app/domains/session/presentation/presentation-pending-store");

function turns(workspaceId: string, sessionId: string) {
  return getPendingPresentationTurnIds(usePresentationPendingStore.getState(), workspaceId, sessionId);
}

beforeEach(() => {
  storage.clear();
  usePresentationPendingStore.setState({ turnsByWorkspaceId: {} });
});

describe("presentation pending store", () => {
  test("scopes concurrent turns to workspace and session without overwriting", () => {
    const { add } = usePresentationPendingStore.getState();
    add("workspace", "session-a", "turn-a1");
    add("workspace", "session-a", "turn-a2");
    add("workspace", "session-b", "turn-b");
    add("other-workspace", "session-a", "turn-other");

    expect(turns("workspace", "session-a")).toEqual(["turn-a1", "turn-a2"]);
    expect(turns("workspace", "session-b")).toEqual(["turn-b"]);
    expect(turns("other-workspace", "session-a")).toEqual(["turn-other"]);
  });

  test("deduplicates turns and removes only the exact terminal turn", () => {
    const { add } = usePresentationPendingStore.getState();
    add("workspace", "session", "turn-1");
    add("workspace", "session", "turn-1");
    add("workspace", "session", "turn-2");
    expect(turns("workspace", "session")).toEqual(["turn-1", "turn-2"]);

    usePresentationPendingStore.getState().remove("workspace", "session", "turn-1");
    expect(turns("workspace", "session")).toEqual(["turn-2"]);
  });

  test("restores pending turns after persisted rehydration", async () => {
    usePresentationPendingStore.getState().add("workspace", "session", "turn");
    const persisted = storage.get(PERSISTED_PRESENTATION_PENDING_STORE_KEY);
    expect(persisted).toBeTruthy();

    usePresentationPendingStore.setState({ turnsByWorkspaceId: {} });
    storage.set(PERSISTED_PRESENTATION_PENDING_STORE_KEY, persisted!);
    await usePresentationPendingStore.persist.rehydrate();

    expect(turns("workspace", "session")).toEqual(["turn"]);
  });
});
