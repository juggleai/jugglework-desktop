/** @jsxImportSource react */
import * as React from "react";
// @ts-ignore -- Colocated behavior tests execute in Bun, outside browser types.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createJuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { promptSuggestionPolicyKey, readPromptSuggestionIdentity, usePromptSuggestionIdentity, usePromptSuggestions } from "./prompt-suggestions";
import { readPromptSuggestionSnapshot, usePromptSuggestionSnapshotRefresh, type ClientHistorySnapshot } from "./prompt-suggestions-snapshot";
import { promptSuggestionUserHistory } from "./prompt-suggestions-history";
import type { JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { useComposerStateStore } from "./composer-state-store";
import { claimSessionSubmission } from "../sync/submission-guard";
import { promptSuggestionScope, promptSuggestionsStore, promptSuggestionStoragePrefix } from "./prompt-suggestions-store";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const values = new Map<string, string>();
const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
const windowTarget = Object.assign(new EventTarget(), {
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  },
  location: { origin: "http://prompt.test" },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  for (const [key, descriptor] of [["window", previousWindow], ["document", previousDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
type Input = Parameters<typeof usePromptSuggestions>[0];
type Output = ReturnType<typeof usePromptSuggestions>;
let view: TestRenderer.ReactTestRenderer;
let output: Output;
let props: Input;
let resolve!: (result: { turnKey: string; suggestion: string | null }) => void;
let signal!: AbortSignal;
let count = 0;
const request = mock((_ws: string, _ses: string, _input: unknown, options: { signal: AbortSignal }) => {
  signal = options.signal;
  return new Promise<{ turnKey: string; suggestion: string | null }>((done) => { resolve = done; });
});
const wait = () => new Promise<void>((done) => setTimeout(done, 5));
function Harness(input: Input) { output = usePromptSuggestions(input); return null; }
let queryClient: QueryClient;
function element() { return <React.StrictMode><QueryClientProvider client={queryClient}><Harness {...props} /></QueryClientProvider></React.StrictMode>; }
async function mount() {
  values.clear(); documentTarget.visibilityState = "visible"; request.mockClear();
  const sessionId = `hook-${++count}`;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const client = {
    ...createJuggleWorkServerClient({ baseUrl: "https://prompt.test" }),
    capabilities: async () => ({ sessions: { promptSuggestions: true } }) as Awaited<ReturnType<Input["client"]["capabilities"]>>,
    getPromptSuggestion: request,
  };
  props = { client, workspaceId: "ws", sessionId, model: { providerID: "p", modelID: "m" }, enabled: true,
    active: true, loaded: true, turnKey: "old", turnCreatedAt: 100, completed: true, running: false, blocked: false, empty: true, ready: true, policyKey: "allowed" };
  await act(async () => { view = TestRenderer.create(element()); await wait(); });
  await act(wait);
}
async function update(next: Partial<Input>) {
  if (next.turnKey && next.turnKey !== props.turnKey && !("turnCreatedAt" in next)) {
    next = { ...next, turnCreatedAt: ({ old: 100, new: 200, next: 300 } as Record<string, number>)[next.turnKey] };
  }
  props = { ...props, ...next };
  await act(async () => { view.update(element()); });
}
async function start() {
  await mount();
  await update({ turnKey: "new", running: true, completed: false });
  await update({ running: false, completed: true });
  await act(wait);
  expect(request).toHaveBeenCalledTimes(1);
  expect(output.pending).toBe(true);
  expect(output.suggestion).toBeNull();
  expect(signal.aborted).toBe(false);
}
async function respond() {
  await act(async () => { resolve({ turnKey: "new", suggestion: "请补充测试" }); await wait(); });
  expect(output.pending).toBe(false);
}
afterEach(async () => { await act(async () => view?.unmount()); queryClient?.clear(); });

test("pending notification rerenders StrictMode hook without detaching or redispatching; dismiss rejects late response", async () => {
  await mount(); expect(output.pending).toBe(false);
  await update({ turnKey: "new", running: true, completed: false }); expect(output.pending).toBe(false);
  await update({ running: false, completed: true }); expect(output.pending).toBe(false);
  await act(wait); expect(output.pending).toBe(true);
  await update({}); await act(wait);
  expect(output.pending).toBe(true); expect(signal.aborted).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => output.dismiss());
  expect(output.pending).toBe(false); expect(signal.aborted).toBe(true);
  await respond(); expect(output.suggestion).toBeNull();
  await update({}); await act(wait);
  expect(output.pending).toBe(false); expect(request).toHaveBeenCalledTimes(1);
});

test("hook acceptance hides without writing the draft and clear restores the suggestion", async () => {
  await start(); await respond();
  expect(output.suggestion).toBe("请补充测试");
  expect(useComposerStateStore.getState().sessions[props.sessionId]?.draft ?? "").toBe("");
  await update({}); expect(output.suggestion).toBe("请补充测试");
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "保留用户草稿"); });
  await update({ empty: false });
  const draft = useComposerStateStore.getState().sessions[props.sessionId];
  expect(output.suggestion).toBeNull();
  await act(async () => output.accept());
  expect(output.suggestion).toBeNull();
  expect(useComposerStateStore.getState().sessions[props.sessionId]).toBe(draft);
  await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
  await update({ empty: true }); expect(output.suggestion).toBe("请补充测试"); expect(request).toHaveBeenCalledTimes(1);
});

test("same-tick type then clear preserves a pending response", async () => {
  await start();
  await act(async () => {
    useComposerStateStore.getState().setDraft(props.sessionId, "用户草稿");
    useComposerStateStore.getState().setDraft(props.sessionId, "");
  });
  expect(signal.aborted).toBe(false); await respond(); expect(output.suggestion).toBe("请补充测试");
  await update({}); expect(request).toHaveBeenCalledTimes(1);
});

const draftMutations = {
  text: (id: string) => useComposerStateStore.getState().setDraft(id, "用户手动编辑"),
  mentions: (id: string) => useComposerStateStore.getState().setMentions(id, { "file.txt": "file" }),
  paste: (id: string) => useComposerStateStore.getState().setPasteParts(id, [{ id: "paste", label: "paste", text: "data", lines: 1 }]),
  attachment: (id: string) => useComposerStateStore.getState().setAttachments(id, [{
    id: "att", name: "file.txt", mimeType: "text/plain", size: 4, kind: "file",
    file: new File(["data"], "file.txt", { type: "text/plain" }),
  }]),
  capability: (id: string) => useComposerStateStore.getState().setCapabilities(id, [{ kind: "skill", name: "test", prompt: "test" }]),
};

for (const [name, mutate] of Object.entries(draftMutations)) {
  for (const phase of ["pending", "ready"] as const) {
    test(`${phase} suggestion survives ${name} edits, hides while nonempty and restores on clear`, async () => {
      await start();
      if (phase === "ready") await respond();
      await act(async () => { mutate(props.sessionId); });
      await update({ empty: false });
      expect(signal.aborted).toBe(false);
      if (phase === "pending") await respond();
      expect(output.suggestion).toBeNull();
      const draft = useComposerStateStore.getState().sessions[props.sessionId];
      await update({});
      expect(useComposerStateStore.getState().sessions[props.sessionId]).toBe(draft);
      expect(output.suggestion).toBeNull();
      await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
      await update({ empty: true });
      expect(output.suggestion).toBe("请补充测试");
      expect(request).toHaveBeenCalledTimes(1);
    });
  }

  test(`initial nonempty ${name} draft prevents dispatch and clearing cannot retry the turn`, async () => {
    await mount(); await update({ turnKey: "new", running: true, completed: false });
    await act(async () => { mutate(props.sessionId); });
    // Even a stale empty prop cannot bypass the live composer gate.
    await update({ running: false, completed: true }); await act(wait);
    expect(request).not.toHaveBeenCalled();
    await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
    await update({ empty: true }); await act(wait);
    expect(request).not.toHaveBeenCalled();
  });
}

test("a live edit after completion but before transport skips without dispatch or retry", async () => {
  await mount(); await update({ turnKey: "new", running: true, completed: false });
  await update({ running: false, completed: true });
  expect(request).not.toHaveBeenCalled();
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "派发前输入"); await wait(); });
  expect(request).not.toHaveBeenCalled();
  await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
  await update({}); await act(wait); expect(request).not.toHaveBeenCalled();
});

test("a nonempty surface-only draft gate skips at completion", async () => {
  await mount(); await update({ turnKey: "new", running: true, completed: false });
  await update({ running: false, completed: true, empty: false }); await act(wait);
  expect(request).not.toHaveBeenCalled();
  await update({ empty: true }); await act(wait); expect(request).not.toHaveBeenCalled();
});

for (const phase of ["pending", "ready"] as const) {
  test(`${phase} queue then clear cancels pending but preserves ready text`, async () => {
    await start();
    if (phase === "ready") await respond();
    await act(async () => {
      const store = useComposerStateStore.getState();
      store.appendQueuedDraft(props.sessionId, {
        mode: "prompt", text: "follow-up", resolvedText: "follow-up", parts: [{ type: "text", text: "follow-up" }], attachments: [],
      });
      store.clearQueuedDrafts(props.sessionId);
    });
    expect(signal.aborted).toBe(phase === "pending");
    if (phase === "pending") await respond();
    expect(output.suggestion).toBe(phase === "ready" ? "请补充测试" : null);
    await update({}); await act(wait); expect(request).toHaveBeenCalledTimes(1);
  });
}

test("explicit dismissal is view-local and clearing the draft restores the placeholder", async () => {
  await start(); await respond();
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "用户草稿"); });
  await update({ empty: false });
  await act(async () => output.dismiss());
  expect(output.suggestion).toBeNull();
  expect(useComposerStateStore.getState().sessions[props.sessionId]?.draft).toBe("用户草稿");
  await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
  await update({ empty: true }); await act(wait);
  expect(output.suggestion).toBe("请补充测试"); expect(request).toHaveBeenCalledTimes(1);
});

test("switching scope with the same turn key cannot display the previous request", async () => {
  await start();
  await update({ sessionId: "different-session", workspaceId: "different-workspace" });
  expect(signal.aborted).toBe(true); await respond(); expect(output.suggestion).toBeNull();
  await act(wait); expect(request).toHaveBeenCalledTimes(1);
});

test("visibility loss aborts synchronously and becoming visible cannot revive", async () => {
  await start();
  await act(async () => { documentTarget.visibilityState = "hidden"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
  expect(signal.aborted).toBe(true); await respond();
  await act(async () => { documentTarget.visibilityState = "visible"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
  expect(output.suggestion).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
});

for (const phase of ["pending", "ready"] as const) {
  test(`organization changes cancel ${phase} suggestions after editing`, async () => {
    await start();
    if (phase === "ready") await respond();
    await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "用户草稿"); });
    await update({ empty: false });
    await act(async () => { values.set("jugglework.den.activeOrgId", "another-org"); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
    expect(output.suggestion).toBeNull(); expect(signal.aborted).toBe(phase === "pending");
    if (phase === "pending") await respond();
    expect(output.suggestion).toBeNull();
    await update({}); expect(request).toHaveBeenCalledTimes(1);
  });

  test(`submission preparation still cancels ${phase} suggestions after editing`, async () => {
    await start();
    if (phase === "ready") await respond();
    await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "待发送草稿"); });
    await update({ empty: false });
    const release = claimSessionSubmission(props.workspaceId, props.sessionId);
    try {
      await update({});
      expect(output.suggestion).toBeNull(); expect(signal.aborted).toBe(phase === "pending");
      if (phase === "pending") await respond();
    } finally { release(); }
    await update({}); await act(wait);
    expect(output.suggestion).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  });
}

test("model, policy, preference, new turn, readiness, queue and unmount cancel transport", async () => {
  for (const change of [{ model: { providerID: "p", modelID: "next" } }, { policyKey: "new-policy" }, { enabled: false },
    { turnKey: "next", running: true, completed: false }, { ready: false }, { blocked: true }, { active: false }]) {
    await start(); await update(change); expect(signal.aborted).toBe(true);
    await respond(); expect(output.suggestion).toBeNull(); await act(async () => view.unmount()); queryClient.clear();
  }
  await start(); await act(async () => view.unmount()); expect(signal.aborted).toBe(true);
});

test("capability missing or metadata/provider not ready prevents transport", async () => {
  await mount(); await update({ ready: false, turnKey: "new", running: true, completed: false });
  await update({ running: false, completed: true }); await act(wait); expect(request).not.toHaveBeenCalled();
  await update({ ready: true }); await act(wait); expect(request).not.toHaveBeenCalled();
  queryClient.setQueriesData({ queryKey: ["prompt-suggestions-capabilities"] }, { sessions: {} });
  await update({ turnKey: "next", running: true, completed: false });
  await update({ running: false, completed: true }); await act(wait); expect(request).not.toHaveBeenCalled();
});

test("send SSE turn precedes history receipt and clearing submitted draft without consuming new turn", async () => {
  await mount();
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "已提交草稿"); });
  await update({ turnKey: "new", running: true, completed: false, empty: false });
  await act(async () => {
    const store = useComposerStateStore.getState();
    store.appendHistory(props.sessionId, "已提交草稿");
    store.appendHistory("another-session", "无关历史");
    store.setDraft("another-session", "无关输入");
    store.setMentions(props.sessionId, {}); // Equivalent content is not input.
    store.clearSession(props.sessionId);
  });
  await update({ empty: true });
  await update({ running: false, completed: true }); await act(wait);
  expect(request).toHaveBeenCalledTimes(1); await respond(); expect(output.suggestion).toBe("请补充测试");
});

test("typing during running then clearing before successful completion still qualifies", async () => {
  await mount(); await update({ turnKey: "new", running: true, completed: false });
  await act(async () => {
    const store = useComposerStateStore.getState();
    store.setDraft(props.sessionId, "下一步的新输入");
    store.setDraft(props.sessionId, "");
    store.appendHistory(props.sessionId, "已提交草稿");
  });
  await update({ running: false, completed: true }); await act(wait);
  expect(request).toHaveBeenCalledTimes(1);
  await respond(); expect(output.suggestion).toBe("请补充测试");
});

test("a running edit still present at completion skips permanently", async () => {
  await mount();
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, "已提交"); });
  await update({ turnKey: "new", running: true, completed: false, empty: false });
  await act(async () => {
    const store = useComposerStateStore.getState();
    store.appendHistory(props.sessionId, "已提交");
    store.setDraft(props.sessionId, "已提交，但现在继续编辑");
  });
  await update({ running: false, completed: true }); await act(wait);
  expect(request).not.toHaveBeenCalled();
  await act(async () => { useComposerStateStore.getState().clearSession(props.sessionId); });
  await update({ empty: true }); await act(wait);
  expect(request).not.toHaveBeenCalled();
});

test("revert and forward replay never regenerate an already attempted suggestion", async () => {
  await start(); await respond();
  await update({ turnKey: "old" }); await act(wait); expect(output.suggestion).toBeNull();
  await update({ turnKey: "new" }); await act(wait); expect(output.suggestion).toBe("请补充测试");
  expect(request).toHaveBeenCalledTimes(1);
});

test("ready placeholder survives session switches, hidden panes, page visibility and unmount/remount", async () => {
  await start(); await respond();
  const sessionId = props.sessionId;
  await update({ sessionId: "another-session" }); expect(output.suggestion).toBeNull();
  await update({ sessionId }); expect(output.suggestion).toBe("请补充测试");
  await update({ active: false }); expect(output.suggestion).toBeNull();
  await update({ active: true }); expect(output.suggestion).toBe("请补充测试");
  await act(async () => { documentTarget.visibilityState = "hidden"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
  expect(output.suggestion).toBeNull();
  await act(async () => { documentTarget.visibilityState = "visible"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
  expect(output.suggestion).toBe("请补充测试");
  await act(async () => view.unmount());
  await act(async () => { view = TestRenderer.create(element()); await wait(); });
  await act(wait);
  expect(output.suggestion).toBe("请补充测试"); expect(request).toHaveBeenCalledTimes(1);
});

test("accept plus editor draft fill and undo restores text without regenerating; Esc resets on reopen", async () => {
  await start(); await respond();
  await act(async () => { output.accept(); useComposerStateStore.getState().setDraft(props.sessionId, "请补充测试"); });
  expect(output.suggestion).toBeNull();
  await act(async () => { useComposerStateStore.getState().setDraft(props.sessionId, ""); });
  expect(output.suggestion).toBe("请补充测试");
  await act(async () => output.dismiss()); expect(output.suggestion).toBeNull();
  await update({}); expect(output.suggestion).toBeNull();
  await update({ active: false }); await update({ active: true });
  expect(output.suggestion).toBe("请补充测试"); expect(request).toHaveBeenCalledTimes(1);
});

test("preference, readiness, loading policy, model and queue only hide persisted ready text", async () => {
  await start(); await respond();
  const saved = [...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix));
  for (const change of [{ enabled: false }, { ready: false }, { ready: false, policyKey: "loading" },
    { ready: false, model: { providerID: "p", modelID: "next" } }, { blocked: true }]) {
    const previous = props;
    await update(change); expect(output.suggestion).toBeNull();
    expect([...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix))).toEqual(saved);
    await update(previous); expect(output.suggestion).toBe("请补充测试");
  }
  await act(async () => { useComposerStateStore.getState().appendQueuedDraft(props.sessionId, {
    mode: "prompt", text: "queued", resolvedText: "queued", parts: [{ type: "text", text: "queued" }], attachments: [],
  }); });
  expect(output.suggestion).toBeNull();
  await act(async () => { useComposerStateStore.getState().clearQueuedDrafts(props.sessionId); });
  expect(output.suggestion).toBe("请补充测试"); expect(request).toHaveBeenCalledTimes(1);
});

test("stable account and org partition survives switching back; identity reads never request credentials", async () => {
  await start(); await respond();
  const originalGet = windowTarget.localStorage.getItem;
  const reads: string[] = [];
  windowTarget.localStorage.getItem = (key) => { reads.push(key); return originalGet(key); };
  try {
    for (const key of ["jugglework.den.userId", "jugglework.den.activeOrgId"]) {
      await act(async () => { values.set(key, "another"); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
      expect(output.suggestion).toBeNull();
      await act(async () => { values.delete(key); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
      expect(output.suggestion).toBe("请补充测试");
    }
    expect(reads.some((key) => /token|credential/i.test(key))).toBe(false);
    expect([...values.values()].some((value) => /authToken|credentials|history/.test(value))).toBe(false);
  } finally { windowTarget.localStorage.getItem = originalGet; }
  expect(request).toHaveBeenCalledTimes(1);
});

test("ready model/policy changes hide without deletion even when readiness remains true", async () => {
  await start(); await respond();
  const saved = [...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix));
  for (const change of [{ model: { providerID: "p", modelID: "B" } }, { policyKey: "changed-policy" }]) {
    const previous = props;
    await update(change); expect(props.ready).toBe(true); expect(output.suggestion).toBeNull();
    expect([...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix))).toEqual(saved);
    await update(previous); expect(output.suggestion).toBe("请补充测试");
  }
  expect(request).toHaveBeenCalledTimes(1);
});

test("identity switch cannot apply A loaded300 to B saved200; only verified B history can advance it", async () => {
  await mount();
  const accountA = readPromptSuggestionIdentity();
  values.set("jugglework.den.userId", "B");
  const accountB = readPromptSuggestionIdentity();
  values.delete("jugglework.den.userId");
  const scopeB = promptSuggestionScope(props.client.baseUrl, props.workspaceId, props.sessionId, accountB);
  const keyB = promptSuggestionStoragePrefix + encodeURIComponent(scopeB);
  const saved = JSON.stringify({ identity: scopeB, turnKey: "B-turn", turnCreatedAt: 200, timestamp: 1, text: "B建议",
    context: JSON.stringify(["p", "m", "allowed"]) });
  values.set(keyB, saved);
  await update({ turnKey: "A-turn", turnCreatedAt: 300, userCreatedAtBaseline: 300, historyIdentity: accountA });
  await act(async () => { values.set("jugglework.den.userId", "B"); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
  for (const next of [{}, { ready: false }, { ready: true }, { model: { providerID: "p", modelID: "B" } }, { model: { providerID: "p", modelID: "m" } }]) {
    await update(next); await act(wait); expect(values.get(keyB)).toBe(saved); expect(output.suggestion).toBeNull();
  }
  await update({ historyIdentity: accountB, turnKey: "B-turn", turnCreatedAt: 200, userCreatedAtBaseline: 200 });
  expect(output.suggestion).toBe("B建议"); expect(values.get(keyB)).toBe(saved);
  await update({ turnKey: "B-next", turnCreatedAt: 400, userCreatedAtBaseline: 400, running: true, completed: false });
  expect(values.has(keyB)).toBe(false); expect(output.suggestion).toBeNull();
  await update({ running: false, completed: true }); await act(wait); expect(request).toHaveBeenCalledTimes(1);
});

test("without identity-bound history an account change stays paused until an actual loading cycle", async () => {
  await start(); await respond();
  const saved = [...values].find(([key]) => key.startsWith(promptSuggestionStoragePrefix))!;
  values.set("jugglework.den.userId", "B"); const accountB = readPromptSuggestionIdentity(); values.delete("jugglework.den.userId");
  const scopeB = promptSuggestionScope(props.client.baseUrl, props.workspaceId, props.sessionId, accountB);
  const keyB = promptSuggestionStoragePrefix + encodeURIComponent(scopeB);
  const text = JSON.stringify({ ...JSON.parse(saved[1]), identity: scopeB }); values.set(keyB, text);
  await update({ turnKey: "next", turnCreatedAt: 300, userCreatedAtBaseline: 300 });
  await act(async () => { values.set("jugglework.den.userId", "B"); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
  await update({}); await update({ ready: false }); await update({ ready: true });
  expect(values.get(keyB)).toBe(text); expect(output.suggestion).toBeNull();
  await update({ loaded: false });
  await update({ loaded: true, turnKey: "new", turnCreatedAt: 200, userCreatedAtBaseline: 200 });
  expect(output.suggestion).toBe("请补充测试"); expect(values.get(keyB)).toBe(text);
});

test("new hook mount restores persisted generation binding through loading policy and ready model mismatch", async () => {
  await start(); await respond();
  const saved = [...values].find(([key]) => key.startsWith(promptSuggestionStoragePrefix))!;
  await act(async () => view.unmount());
  // A fresh session key forces a storage restoration rather than a live record read.
  props = { ...props, sessionId: `${props.sessionId}-reloaded`, policyKey: null, ready: false };
  const scope = promptSuggestionScope(props.client.baseUrl, props.workspaceId, props.sessionId, readPromptSuggestionIdentity());
  const key = promptSuggestionStoragePrefix + encodeURIComponent(scope);
  const savedText = JSON.stringify({ ...JSON.parse(saved[1]), identity: scope }); values.set(key, savedText);
  await act(async () => { view = TestRenderer.create(element()); }); await act(wait);
  expect(output.suggestion).toBeNull();
  await update({ policyKey: "changed-policy", ready: true }); expect(output.suggestion).toBeNull();
  await update({ policyKey: "allowed", model: { providerID: "p", modelID: "B" } }); expect(output.suggestion).toBeNull();
  await update({ model: { providerID: "p", modelID: "m" } }); expect(output.suggestion).toBe("请补充测试");
  expect(values.get(key)).toBe(savedText); expect(request).toHaveBeenCalledTimes(1);
  expect(promptSuggestionPolicyKey({ b: { d: 1, c: 2 }, a: true })).toBe(promptSuggestionPolicyKey({ a: true, b: { c: 2, d: 1 } }));
});

test("real hook baseline ignores synthetic/compaction controls but a real reverted tail clears ready persistence", async () => {
  await start(); await respond();
  type Raw = JuggleWorkSessionSnapshot["messages"][number];
  const raw = (id: string, created: number, parts: unknown[], info = {}) => ({ info: { id, role: "user", time: { created }, ...info }, parts }) as Raw;
  const real = raw("new", 200, [{ type: "text", text: "真实用户" }]);
  const controls = [raw("synthetic", 300, [{ type: "text", text: "系统注入", synthetic: true }]),
    raw("continue", 400, [{ type: "text", text: "continue", synthetic: true, metadata: { compaction_continue: true } }]),
    raw("boundary", 500, [{ type: "compaction", auto: true }]),
    raw("metadata", 600, [{ type: "text", text: "continue" }], { metadata: { compaction_continue: true } })];
  const saved = [...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix));
  await update({ userCreatedAtBaseline: promptSuggestionUserHistory([real, ...controls]).userCreatedAtBaseline });
  expect(props.userCreatedAtBaseline).toBe(200); expect(output.suggestion).toBe("请补充测试");
  expect([...values].filter(([key]) => key.startsWith(promptSuggestionStoragePrefix))).toEqual(saved);
  // The raw tail is unreverted, even when the visible turn remains `new`.
  await update({ userCreatedAtBaseline: promptSuggestionUserHistory([real, ...controls, raw("real-tail", 700, [{ type: "text", text: "新指令" }])]).userCreatedAtBaseline });
  expect(output.suggestion).toBeNull(); expect([...values.keys()].filter((key) => key.startsWith(promptSuggestionStoragePrefix))).toEqual([]);
});

test("session deletion clears the live placeholder and persistent text across accounts", async () => {
  await start(); await respond();
  await act(async () => promptSuggestionsStore.removeSession(props.client.baseUrl, props.workspaceId, props.sessionId));
  expect(output.suggestion).toBeNull();
  expect([...values.keys()].filter((key) => key.startsWith(promptSuggestionStoragePrefix))).toEqual([]);
  await update({}); await act(wait); expect(request).toHaveBeenCalledTimes(1);
});

test("background cross-source deleted event clears all identities without an active session listener", async () => {
  await start(); await respond();
  const { __createWorkspaceSessionSyncForTest, __applySessionSyncEventForTest, __disposeWorkspaceSessionSyncForTest } = await import("../sync/session-sync");
  const input = { baseUrl: "https://engine.prompt.test", workspaceId: props.workspaceId, juggleworkToken: "test-only",
    promptSuggestionsEndpoint: props.client.baseUrl };
  const saved = [...values].find(([key]) => key.startsWith(promptSuggestionStoragePrefix))!;
  const otherScope = promptSuggestionScope(props.client.baseUrl, props.workspaceId, props.sessionId, "other-account/org");
  values.set(promptSuggestionStoragePrefix + encodeURIComponent(otherScope), JSON.stringify({ ...JSON.parse(saved[1]), identity: otherScope }));
  await update({ active: false });
  __createWorkspaceSessionSyncForTest(input);
  try {
    await act(async () => __applySessionSyncEventForTest(input, { type: "session.deleted", properties: { info: { id: props.sessionId } } } as never));
    expect([...values.keys()].filter((key) => key.startsWith(promptSuggestionStoragePrefix))).toEqual([]);
    await update({ active: true }); expect(output.suggestion).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  } finally { __disposeWorkspaceSessionSyncForTest(input); }
});

function snapshotFixture(sessionId: string, turnKey: string, created: number): JuggleWorkSessionSnapshot {
  return { session: { id: sessionId, slug: sessionId, projectID: "project", directory: "/test", version: "1", title: "Original", time: { created: 1, updated: 1 } }, status: { type: "idle" }, todos: [],
    messages: [{ info: { id: turnKey, sessionID: sessionId, role: "user", agent: "build", model: { providerID: "p", modelID: "m" }, time: { created } },
      parts: [{ id: `${turnKey}-part`, sessionID: sessionId, messageID: turnKey, type: "text", text: "用户请求" }] }] } satisfies JuggleWorkSessionSnapshot;
}

function SnapshotHarness({ input, read }: { input: Input; read: (signal: AbortSignal) => Promise<JuggleWorkSessionSnapshot> }) {
  const identity = usePromptSuggestionIdentity();
  const key = React.useMemo(() => ["react-session-snapshot", input.workspaceId, input.sessionId], [input.workspaceId, input.sessionId]);
  const query = useQuery<ClientHistorySnapshot>({ queryKey: key,
    queryFn: ({ signal }) => readPromptSuggestionSnapshot(read, signal), staleTime: Infinity });
  usePromptSuggestionSnapshotRefresh(queryClient, key, identity);
  const user = query.data?.messages.findLast((message) => message.info.role === "user");
  output = usePromptSuggestions({ ...input, loaded: Boolean(query.data), historyIdentity: query.data?.clientHistoryIdentity ?? null,
    turnKey: user?.info.id ?? "", turnCreatedAt: user?.info.time.created,
    userCreatedAtBaseline: promptSuggestionUserHistory(query.data?.messages ?? []).userCreatedAtBaseline });
  return null;
}

test("actual session.updated QueryClient replacement preserves identity, ready text and eligibility for the next turn", async () => {
  await start(); await respond();
  await act(async () => view.unmount());
  const { __createWorkspaceSessionSyncForTest, __applySessionSyncEventForTest, snapshotKey } = await import("../sync/session-sync");
  const target = globalThis as typeof globalThis & { __owReactQueryClient?: QueryClient };
  const previous = target.__owReactQueryClient;
  target.__owReactQueryClient = queryClient;
  const syncInput = { workspaceId: props.workspaceId, baseUrl: "https://title-sync.test", juggleworkToken: "test-only" };
  const dispose = __createWorkspaceSessionSyncForTest(syncInput);
  const key = snapshotKey(props.workspaceId, props.sessionId);
  const read = async () => snapshotFixture(props.sessionId, "new", 200);
  try {
    await act(async () => { view = TestRenderer.create(<QueryClientProvider client={queryClient}><SnapshotHarness input={props} read={read} /></QueryClientProvider>); });
    await act(wait); await act(wait);
    expect(output.suggestion).toBe("请补充测试");
    const before = queryClient.getQueryData<ClientHistorySnapshot>(key)!;
    await act(async () => __applySessionSyncEventForTest(syncInput, { type: "session.updated", properties: { info: { id: props.sessionId, title: "Renamed" } } } as never));
    await act(wait);
    const renamed = queryClient.getQueryData<ClientHistorySnapshot>(key)!;
    expect(renamed).not.toBe(before); expect(renamed.session.title).toBe("Renamed");
    expect(renamed.clientHistoryIdentity).toBe(readPromptSuggestionIdentity());
    expect(output.suggestion).toBe("请补充测试");
    // Keep default structural sharing enabled; a plain client field must survive it.
    await act(async () => { queryClient.setQueryData(key, { ...snapshotFixture(props.sessionId, "next", 300), clientHistoryIdentity: renamed.clientHistoryIdentity }); });
    await act(wait); await act(wait);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { resolve({ turnKey: "next", suggestion: "新轮建议" }); });
    expect(output.suggestion).toBe("新轮建议");
  } finally { dispose(); target.__owReactQueryClient = previous; }
});

test("actual QueryClient cancels initial deferred A read before B refetch, ignoring a late A response", async () => {
  await mount(); await act(async () => view.unmount());
  const calls: { account: string; signal: AbortSignal; resolve: (value: JuggleWorkSessionSnapshot) => void }[] = [];
  const read = (signal: AbortSignal) => new Promise<JuggleWorkSessionSnapshot>((resolve) => {
    calls.push({ account: readPromptSuggestionIdentity(), signal, resolve });
  });
  await act(async () => { view = TestRenderer.create(<QueryClientProvider client={queryClient}><SnapshotHarness input={props} read={read} /></QueryClientProvider>); });
  expect(calls).toHaveLength(1);
  values.set("jugglework.den.userId", "B"); const accountB = readPromptSuggestionIdentity(); values.delete("jugglework.den.userId");
  const scope = promptSuggestionScope(props.client.baseUrl, props.workspaceId, props.sessionId, accountB);
  const key = promptSuggestionStoragePrefix + encodeURIComponent(scope);
  const saved = JSON.stringify({ identity: scope, turnKey: "B-turn", turnCreatedAt: 200, timestamp: 1, text: "B建议", context: JSON.stringify(["p", "m", "allowed"]) });
  values.set(key, saved);
  await act(async () => { values.set("jugglework.den.userId", "B"); windowTarget.dispatchEvent(new Event(denSettingsChangedEvent)); });
  await act(wait);
  expect(calls).toHaveLength(2); expect(calls[0]!.signal.aborted).toBe(true); expect(calls[1]!.account).toBe(accountB);
  await act(async () => { calls[0]!.resolve(snapshotFixture(props.sessionId, "A-turn", 300)); });
  await act(wait);
  expect(output.suggestion).toBeNull(); expect(values.get(key)).toBe(saved);
  await act(async () => { calls[1]!.resolve(snapshotFixture(props.sessionId, "B-turn", 200)); });
  await act(wait); await act(wait);
  expect(output.suggestion).toBe("B建议"); expect(values.get(key)).toBe(saved);
  expect(request).not.toHaveBeenCalled();
});

test("persisted policy binding is a stable digest with no policy field or value sentinel", async () => {
  await mount();
  const policy = { forbiddenPolicyField_SENTINEL: "private-policy-value_SENTINEL", nested: { enabled: true } };
  const digest = promptSuggestionPolicyKey(policy);
  expect(digest).toMatch(/^policy-fnv1a32:/);
  expect(digest).toBe(promptSuggestionPolicyKey({ nested: { enabled: true }, forbiddenPolicyField_SENTINEL: "private-policy-value_SENTINEL" }));
  await update({ policyKey: digest, turnKey: "new", running: true, completed: false });
  await update({ running: false, completed: true }); await act(wait); await respond();
  const stored = [...values.values()].join("\n");
  expect(stored).not.toContain("forbiddenPolicyField_SENTINEL"); expect(stored).not.toContain("private-policy-value_SENTINEL");
  expect(stored).toContain(digest);
  await update({ policyKey: promptSuggestionPolicyKey({ nested: { enabled: false } }) }); expect(output.suggestion).toBeNull();
  await update({ policyKey: digest }); expect(output.suggestion).toBe("请补充测试");
});
