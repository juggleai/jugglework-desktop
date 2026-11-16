// @ts-ignore -- Bun executes colocated behavior tests; the app targets browser types.
import { expect, mock, test } from "bun:test";
import { promptSuggestionPending, promptSuggestionScope, promptSuggestionStoragePrefix, PromptSuggestionsStore, type PromptSuggestionObservation } from "./prompt-suggestions-store";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; } };
}
function fixture(limit = 128, budget = 8_000, storage = memoryStorage()) {
  const store = new PromptSuggestionsStore(limit, budget, () => storage);
  const owner = {};
  let resolve!: (result: { turnKey: string; suggestion: string | null }) => void;
  let signal!: AbortSignal;
  const request = mock((value: AbortSignal) => {
    signal = value;
    return new Promise<{ turnKey: string; suggestion: string | null }>((done) => { resolve = done; });
  });
  let input: PromptSuggestionObservation = {
    scope: "endpoint/workspace/session", turnKey: "old", turnCreatedAt: 100, loaded: true, enabled: true,
    active: true, context: "model/account/policy", completed: true, running: false,
    blocked: false, empty: true, ready: true, request, current: () => true,
    canRequest: () => input.empty && input.current(),
  };
  const observe = (next: Partial<PromptSuggestionObservation> = {}, target = owner) => {
    if (next.turnKey && next.turnKey !== input.turnKey && !("turnCreatedAt" in next)) {
      next = { ...next, turnCreatedAt: ({ old: 100, new: 200, next: 300 } as Record<string, number>)[next.turnKey] };
    }
    input = { ...input, ...next };
    store.observe(input, target);
  };
  const read = () => store.read(input.scope, input.turnKey, input.context);
  const start = () => { observe(); observe({ turnKey: "new", completed: false, running: true }); };
  const complete = () => observe({ completed: true, running: false });
  const respond = async (suggestion: string | null = "请补充边界测试") => {
    resolve({ turnKey: input.turnKey, suggestion }); await tick();
  };
  return { store, storage, owner, request, observe, read, start, complete, respond,
    get signal() { return signal; }, get input() { return input; } };
}

test("initial snapshots, first active-run mount and enabling on old completion are baselines", async () => {
  const f = fixture();
  f.observe({ enabled: false }); f.observe({ enabled: true });
  f.observe({ scope: "another", running: true, completed: false }); f.complete();
  await tick(); expect(f.request).not.toHaveBeenCalled();
});

test("new real turn completes once; rerenders, two panes and remount cannot retry", async () => {
  const f = fixture(); f.start(); f.complete();
  f.observe({}, {}); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  await f.respond(); expect(f.read()).toBe("请补充边界测试");
  f.observe(); expect(f.read()).toBe("请补充边界测试");
  f.store.detach(f.input.scope, f.owner);
  expect(f.read()).toBe("请补充边界测试"); f.observe(); await tick();
  expect(f.request).toHaveBeenCalledTimes(1);
});

test("StrictMode cleanup before transport does not consume eligibility", async () => {
  const f = fixture(); f.start(); f.complete();
  f.store.detach(f.input.scope, f.owner);
  await tick(); expect(f.request).not.toHaveBeenCalled();
  f.observe(); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  f.store.detach(f.input.scope, f.owner); expect(f.signal.aborted).toBe(true);
  f.observe(); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("subscribers see stable pending and ready snapshots; finish preserves ready text", async () => {
  const f = fixture(); f.start();
  const snapshot = () => f.store.snapshot(f.input.scope, f.input.turnKey, f.input.context);
  const snapshots: ReturnType<typeof snapshot>[] = [];
  const unsubscribe = f.store.subscribe(() => snapshots.push(snapshot()));
  f.complete(); expect(snapshot()).toBeNull();
  await tick();
  expect(snapshots).toEqual([promptSuggestionPending]);
  expect(snapshot()).toBe(snapshot());
  expect(f.store.snapshot("other-scope", f.input.turnKey, f.input.context)).toBeNull();
  expect(f.store.snapshot(f.input.scope, "other-turn", f.input.context)).toBeNull();
  expect(f.store.snapshot(f.input.scope, f.input.turnKey, "other-context")).toBeNull();
  await f.respond(); expect(snapshot()).toBe("请补充边界测试");
  expect(f.store.snapshot(f.input.scope, f.input.turnKey, "other-context")).toBeNull();
  f.store.finish(f.input.scope); expect(snapshot()).toBe("请补充边界测试");
  expect(snapshots).toEqual([promptSuggestionPending, "请补充边界测试"]);
  unsubscribe();
});

test("dismissing notified pending aborts and ignores a late result without retrying", async () => {
  const f = fixture(); f.start(); f.complete(); await tick();
  f.store.finish(f.input.scope);
  expect(f.signal.aborted).toBe(true);
  expect(f.store.snapshot(f.input.scope, f.input.turnKey, f.input.context)).toBeNull();
  await f.respond(); f.observe(); await tick();
  expect(f.read()).toBeNull(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("inactive duplicate committing first cannot consume the active pane's new completion", async () => {
  const f = fixture(); f.observe();
  f.observe({ turnKey: "new", active: false }, {});
  f.observe({ active: true });
  await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  await f.respond(); expect(f.read()).toBe("请补充边界测试");
  f.observe({ active: false }, {}); expect(f.read()).toBe("请补充边界测试");
  f.store.detach(f.input.scope, f.owner); expect(f.signal.aborted).toBe(false);
});

test("retained eligible active run can resume after remount but an evicted run cannot", async () => {
  const f = fixture(); f.start(); f.store.detach(f.input.scope, f.owner);
  f.observe({ running: true, completed: false }, {}); f.complete(); await tick();
  expect(f.request).toHaveBeenCalledTimes(1); f.store.remove(f.input.scope);
  const g = fixture(); g.observe({ running: true, completed: false }); g.complete(); await tick();
  expect(g.request).not.toHaveBeenCalled();
});

test("non-active records are evicted before a live request", async () => {
  const f = fixture(2); f.observe({ scope: "inactive" }); f.store.detach("inactive", f.owner);
  f.observe({ scope: "active", turnKey: "old" }); f.observe({ turnKey: "new", running: true, completed: false });
  f.complete(); await tick();
  f.store.observe({ ...f.input, scope: "third" }, {});
  expect(f.signal.aborted).toBe(false); await f.respond(); expect(f.read()).toBe("请补充边界测试");
  f.store.remove(f.input.scope);
});

for (const [name, change] of Object.entries({
  "queued follow-up or waiting/stopped": { blocked: true },
  "hidden pane": { active: false }, "disabled preference": { enabled: false },
  "model/account/policy": { context: "changed" }, "provider readiness": { ready: false },
  "new turn": { turnKey: "next", running: true, completed: false },
} satisfies Record<string, Partial<PromptSuggestionObservation>>)) {
  test(`${name} aborts real request and drops late response without resurrection`, async () => {
    const f = fixture(); f.start(); f.complete(); await tick();
    f.observe(change); expect(f.signal.aborted).toBe(true);
    await f.respond(); expect(f.read()).toBeNull();
    f.observe({ ...f.input, empty: true, blocked: false, enabled: true, active: true, ready: true });
    await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  });
}

test("inactive completion and queue skip permanently; unknown completion never dispatches", async () => {
  for (const change of [{ active: false }, { blocked: true }, { completed: false }]) {
    const f = fixture(); f.start(); f.observe({ running: false, completed: true, ...change });
    await tick(); expect(f.request).not.toHaveBeenCalled();
    if (change.completed === undefined) { f.observe({ active: true, blocked: false }); await tick(); expect(f.request).not.toHaveBeenCalled(); }
  }
});

test("a nonempty draft at completion skips permanently even after clearing", async () => {
  const f = fixture(); f.start(); f.observe({ empty: false }); f.complete();
  await tick(); expect(f.request).not.toHaveBeenCalled();
  f.observe({ empty: true }); await tick(); expect(f.request).not.toHaveBeenCalled();
});

test("a draft becoming nonempty before scheduled dispatch skips without a request", async () => {
  const f = fixture(); f.start(); let empty = true;
  f.observe({ running: false, completed: true, canRequest: () => empty });
  empty = false; await tick(); expect(f.request).not.toHaveBeenCalled();
  empty = true; f.observe(); await tick(); expect(f.request).not.toHaveBeenCalled();
});

for (const phase of ["pending", "ready"] as const) {
  test(`${phase} survives nonempty draft edits without another request`, async () => {
    const f = fixture(); f.start(); f.complete(); await tick();
    if (phase === "ready") await f.respond();
    f.observe({ empty: false }); expect(f.signal.aborted).toBe(false);
    if (phase === "pending") await f.respond();
    expect(f.read()).toBe("请补充边界测试");
    f.observe({ empty: true }); f.observe({ empty: false });
    expect(f.read()).toBe("请补充边界测试");
    await tick(); expect(f.request).toHaveBeenCalledTimes(1);
    f.store.remove(f.input.scope);
  });
}

test("queue or scope can invalidate synchronously before dispatch or late resolution", async () => {
  const f = fixture(); f.start(); let current = true;
  f.observe({ running: false, completed: true, current: () => current });
  current = false; await tick(); expect(f.request).not.toHaveBeenCalled();
  const g = fixture(); g.start(); g.complete(); await tick();
  g.observe({ current: () => false }); await g.respond(); expect(g.read()).toBeNull();
});

for (const phase of ["accepted", "dismissed"] as const) {
  test(`${phase} preserves text when undo/clear returns to empty`, async () => {
    const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
    f.store.finish(f.input.scope, phase); f.observe({ empty: false }); f.observe({ empty: true });
    await tick(); expect(f.read()).toBe("请补充边界测试"); expect(f.request).toHaveBeenCalledTimes(1);
  });
}

test("timeout, failure and null results are silent one-shot skips", async () => {
  const f = fixture(128, 10); f.start(); f.complete(); await tick(); await tick(); await tick();
  expect(f.signal.aborted).toBe(true); await f.respond(); f.observe(); await tick();
  expect(f.read()).toBeNull(); expect(f.request).toHaveBeenCalledTimes(1);
  for (const request of [async () => ({ turnKey: "new", suggestion: null }), async () => { throw new Error("unavailable"); }]) {
    const g = fixture(); g.start(); g.observe({ running: false, completed: true, request }); await tick(); g.observe();
    expect(g.read()).toBeNull();
  }
});

test("bounded eviction cancels requests and returning snapshots become baselines", async () => {
  const f = fixture(2); f.start(); f.complete(); await tick();
  f.store.observe({ ...f.input, scope: "two" }, {});
  f.store.observe({ ...f.input, scope: "three" }, {});
  expect(f.signal.aborted).toBe(true);
  f.observe(); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  f.store.remove(f.input.scope); f.observe(); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("revert to baseline and replay of an attempted turn never qualify; genuinely newer turn does", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  f.observe({ turnKey: "old", completed: true }); await tick();
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.read()).toBeNull();
  f.observe({ turnKey: "new", completed: true }); await tick();
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.read()).toBe("请补充边界测试");
  f.observe({ turnKey: "next", completed: false, running: true }); f.complete(); await tick();
  expect(f.request).toHaveBeenCalledTimes(2); f.store.remove(f.input.scope);
});

test("unseen older, tied, missing metadata and temporarily empty reverted projections cannot mint a turn", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  for (const [turnKey, turnCreatedAt] of [["unseen-older", 50], ["tied", 200], ["", undefined], ["missing", undefined], ["new", 200]] as const) {
    f.observe({ turnKey, turnCreatedAt, completed: true }); await tick();
    expect(f.request).toHaveBeenCalledTimes(1);
  }
});

test("baseline metadata arriving late is not new-turn evidence", async () => {
  const f = fixture(); f.observe({ turnCreatedAt: undefined });
  f.observe({ turnCreatedAt: 100 }); await tick(); expect(f.request).not.toHaveBeenCalled();
  f.start(); f.complete(); await tick(); expect(f.request).toHaveBeenCalledTimes(1); f.store.remove(f.input.scope);
});

test("evicted reverted session seeds the hidden persisted tail as baseline, not new input", async () => {
  const f = fixture(1);
  f.observe({ turnKey: "old", turnCreatedAt: 100, userCreatedAtBaseline: 200 });
  f.store.observe({ ...f.input, scope: "eviction" }, {});
  f.observe();
  f.observe({ turnKey: "new", turnCreatedAt: 200 }); await tick();
  expect(f.request).not.toHaveBeenCalled();
  f.observe({ turnKey: "next", turnCreatedAt: 300, userCreatedAtBaseline: 300, running: true, completed: false });
  f.complete(); await tick(); expect(f.request).toHaveBeenCalledTimes(1); f.store.remove(f.input.scope);
});

test("new store restores only the matching real turn, with no transport or historical backfill", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  expect([...f.storage.values.keys()][0]).toStartWith(promptSuggestionStoragePrefix);
  const persisted = JSON.parse([...f.storage.values.values()][0]!);
  expect(Object.keys(persisted).sort()).toEqual(["context", "identity", "text", "timestamp", "turnCreatedAt", "turnKey"]);
  const store = new PromptSuggestionsStore(128, 8_000, () => f.storage);
  store.observe({ ...f.input, enabled: false, ready: false, context: "policy-loading" }, {});
  expect(store.read(f.input.scope, "new", "policy-loading")).toBeNull();
  store.observe({ ...f.input, turnKey: "old", turnCreatedAt: 100 }, {});
  expect(store.read(f.input.scope, "old", f.input.context)).toBeNull();
  store.observe(f.input, {});
  expect(store.read(f.input.scope, "new", f.input.context)).toBe("请补充边界测试");
  await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("memory eviction never removes storage and revisiting restores ready text", async () => {
  const f = fixture(1); f.start(); f.complete(); await tick(); await f.respond();
  const saved = [...f.storage.values];
  f.store.observe({ ...f.input, scope: "another-session" }, {});
  expect([...f.storage.values]).toEqual(saved);
  f.observe(); expect(f.read()).toBe("请补充边界测试");
  await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("real new turn clears old storage at start even when disabled or the new request fails", async () => {
  for (const enabled of [true, false]) {
    const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
    f.observe({ turnKey: "next", running: true, completed: false, enabled });
    expect(f.storage.length).toBe(0); expect(f.read()).toBeNull();
    f.observe({ running: false, completed: true, request: async () => { throw new Error("failed"); } });
    await tick(); expect(f.storage.length).toBe(0); expect(f.read()).toBeNull();
    const reloaded = new PromptSuggestionsStore(128, 8_000, () => f.storage);
    reloaded.observe(f.input, {}); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
  }
});

test("reload on a newer real tail discards obsolete text but never bills a historical completion", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  const store = new PromptSuggestionsStore(128, 8_000, () => f.storage);
  store.observe({ ...f.input, turnKey: "next", turnCreatedAt: 300, userCreatedAtBaseline: 300 }, {});
  expect(f.storage.length).toBe(0); expect(store.read(f.input.scope, "next", f.input.context)).toBeNull();
  await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("endpoint, workspace, session, account and org are isolated; deletion clears every account including evicted records", async () => {
  const storage = memoryStorage();
  const scopes = [promptSuggestionScope("e", "w", "s", "account-a/org-a"), promptSuggestionScope("e", "w", "s", "account-b/org-a"),
    promptSuggestionScope("e", "w", "s", "account-a/org-b"), promptSuggestionScope("other", "w", "s", "account-a/org-a"),
    promptSuggestionScope("e", "other", "s", "account-a/org-a"), promptSuggestionScope("e", "w", "other", "account-a/org-a")];
  for (const scope of scopes) {
    const f = fixture(1, 8_000, storage); f.observe({ scope }); f.start(); f.complete(); await tick(); await f.respond(scope);
  }
  const f = fixture(1, 8_000, storage);
  f.observe({ scope: promptSuggestionScope("e", "w", "s", "unknown"), turnKey: "new", turnCreatedAt: 200 });
  expect(f.read()).toBeNull();
  f.store.removeSession("e", "w", "s");
  expect(storage.length).toBe(3);
  for (const [index, scope] of scopes.entries()) {
    f.observe({ scope, turnKey: "new", turnCreatedAt: 200 });
    expect(f.read()).toBe(index < 3 ? null : scope);
  }
  await tick(); expect(f.request).not.toHaveBeenCalled();
});

test("storage failures degrade to a usable memory placeholder", async () => {
  const storage = memoryStorage();
  storage.getItem = () => { throw new Error("denied"); };
  storage.setItem = () => { throw new Error("quota"); };
  storage.removeItem = () => { throw new Error("denied"); };
  const f = fixture(128, 8_000, storage); f.start(); f.complete(); await tick(); await f.respond();
  f.store.detach(f.input.scope, f.owner); f.observe(); expect(f.read()).toBe("请补充边界测试");
  f.store.remove(f.input.scope); expect(f.read()).toBeNull();
});

test("a newer hidden real tail clears old persistence without making revert replay eligible", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  f.observe({ turnKey: "old", turnCreatedAt: 100, userCreatedAtBaseline: 300 });
  expect(f.storage.length).toBe(0);
  f.observe({ turnKey: "new", turnCreatedAt: 200 }); expect(f.read()).toBeNull();
  f.observe({ turnKey: "next", turnCreatedAt: 300 }); await tick();
  expect(f.request).toHaveBeenCalledTimes(1);
});

test("session deletion aborts pending work and a late result cannot recreate persistence", async () => {
  const f = fixture();
  f.observe({ scope: promptSuggestionScope("e", "w", "s", "account/org") });
  f.start(); f.complete(); await tick();
  f.store.removeSession("e", "w", "s"); expect(f.signal.aborted).toBe(true);
  await f.respond(); expect(f.storage.length).toBe(0); expect(f.read()).toBeNull();
  f.observe(); await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});

test("malformed cache values and keys do not block restoration or session deletion", async () => {
  const f = fixture();
  const scope = promptSuggestionScope("e", "w", "s", "account/org");
  f.storage.values.set(promptSuggestionStoragePrefix + "%", "broken");
  f.storage.values.set(promptSuggestionStoragePrefix + encodeURIComponent(scope), "not-json");
  f.observe({ scope }); expect(f.read()).toBeNull();
  f.start(); f.complete(); await tick(); await f.respond();
  f.store.removeSession("e", "w", "s");
  expect(f.storage.length).toBe(1); expect(f.read()).toBeNull();
});

test("restoration preserves the saved generation context rather than binding to current model/policy", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  const saved = [...f.storage.values];
  const store = new PromptSuggestionsStore(128, 8_000, () => f.storage);
  store.observe({ ...f.input, context: "different-model-or-policy" }, {});
  expect(store.snapshot(f.input.scope, "new", "different-model-or-policy")).toBeNull();
  expect(store.read(f.input.scope, "new", f.input.context)).toBe("请补充边界测试");
  store.observe(f.input, {});
  expect(store.snapshot(f.input.scope, "new", f.input.context)).toBe("请补充边界测试");
  expect([...f.storage.values]).toEqual(saved);
});

test("legacy text without generation binding stays preserved and hidden after reload", async () => {
  const f = fixture(); f.start(); f.complete(); await tick(); await f.respond();
  const [key, value] = [...f.storage.values][0]!;
  const { context: _context, ...legacy } = JSON.parse(value);
  f.storage.values.set(key, JSON.stringify(legacy));
  const store = new PromptSuggestionsStore(128, 8_000, () => f.storage);
  store.observe(f.input, {});
  expect(store.snapshot(f.input.scope, "new", f.input.context)).toBeNull();
  expect(f.storage.getItem(key)).toBe(JSON.stringify(legacy));
  await tick(); expect(f.request).toHaveBeenCalledTimes(1);
});
