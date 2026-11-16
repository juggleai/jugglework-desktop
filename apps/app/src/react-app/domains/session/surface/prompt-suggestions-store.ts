import type { JuggleWorkPromptSuggestion } from "@/app/lib/jugglework-server";

type Phase = "eligible" | "pending" | "ready" | "accepted" | "dismissed" | "skipped";
/** A stable snapshot value distinct from both ready text and no suggestion. */
export const promptSuggestionPending = Symbol("prompt-suggestion-pending");
export type PromptSuggestionObservation = {
  scope: string;
  turnKey: string;
  turnCreatedAt?: number;
  /** Highest persisted/live user timestamp, including the tail hidden by revert. */
  userCreatedAtBaseline?: number;
  loaded: boolean;
  enabled: boolean;
  active: boolean;
  context: string;
  completed: boolean;
  running: boolean;
  blocked: boolean;
  empty: boolean;
  ready: boolean;
  request: (signal: AbortSignal) => Promise<JuggleWorkPromptSuggestion>;
  /** Recheck turn, queue and context without invalidating user draft edits. */
  current: () => boolean;
  /** Initial dispatch additionally requires an empty live draft. */
  canRequest: () => boolean;
};

type RecordState = {
  turnKey: string;
  /** Monotonic real-user frontier, retained across revert and recent-turn replacement. */
  latestUserCreatedAt?: number;
  context: string;
  phase: Phase;
  suggestion: string | null;
  owners: Set<object>;
  owner?: object;
  schedule?: ReturnType<typeof setTimeout>;
  backgroundCompletion?: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
};

export function promptSuggestionScope(endpoint: string, workspaceId: string, sessionId: string, identity = "") {
  return JSON.stringify([endpoint, workspaceId, sessionId, identity]);
}

export const promptSuggestionStoragePrefix = "jugglework.prompt-suggestion.v1:";
type SuggestionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type PersistedSuggestion = { identity: string; turnKey: string; turnCreatedAt: number; timestamp: number; text: string; context?: string };
function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Bounded in-memory turn ledger; ready text survives independently in local storage. */
export class PromptSuggestionsStore {
  private records = new Map<string, RecordState>();
  private listeners = new Set<() => void>();
  constructor(private limit = 128, private budgetMs = 8_000, private storage: () => SuggestionStorage | undefined = browserStorage) {}
  private storageKey(scope: string) { return promptSuggestionStoragePrefix + encodeURIComponent(scope); }
  private restore(scope: string): PersistedSuggestion | undefined {
    try {
      const item = JSON.parse(this.storage()?.getItem(this.storageKey(scope)) ?? "null") as PersistedSuggestion | null;
      if (item?.identity === scope && typeof item.text === "string" && item.text && typeof item.turnKey === "string" &&
        Number.isFinite(item.turnCreatedAt) && Number.isFinite(item.timestamp)) return item;
    } catch { /* Storage is optional; the live ledger remains usable. */ }
  }
  private forget(scope: string) {
    try { this.storage()?.removeItem(this.storageKey(scope)); } catch { /* Memory-only degradation. */ }
  }
  private persist(scope: string, record: RecordState) {
    if (!record.suggestion || record.latestUserCreatedAt === undefined) return;
    const item: PersistedSuggestion = { identity: scope, turnKey: record.turnKey, turnCreatedAt: record.latestUserCreatedAt,
      timestamp: Date.now(), text: record.suggestion, context: record.context };
    try { this.storage()?.setItem(this.storageKey(scope), JSON.stringify(item)); } catch { /* Memory-only degradation. */ }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() { for (const listener of this.listeners) listener(); }
  private end(record: RecordState, phase: Phase = "dismissed") {
    clearTimeout(record.schedule);
    clearTimeout(record.deadline);
    record.schedule = undefined;
    record.backgroundCompletion = false;
    record.controller?.abort();
    record.controller = undefined;
    record.phase = phase;
    record.suggestion = null;
    this.notify();
  }
  read(scope: string, turnKey: string, context: string) {
    const record = this.records.get(scope);
    return record?.turnKey === turnKey && record.context === context && record.phase === "ready" ? record.suggestion : null;
  }
  snapshot(scope: string, turnKey: string, context: string) {
    const record = this.records.get(scope);
    if (record?.turnKey !== turnKey || record.context !== context) return null;
    return record.phase === "pending" ? promptSuggestionPending : this.read(scope, turnKey, context);
  }
  finish(scope: string, phase: "accepted" | "dismissed" = "dismissed") {
    const record = this.records.get(scope);
    if (record && (record.phase === "eligible" || record.phase === "pending")) this.end(record, phase);
  }
  remove(scope: string) {
    const record = this.records.get(scope);
    if (record) this.end(record, "skipped");
    this.records.delete(scope);
    this.forget(scope);
    this.notify();
  }
  /** Session deletion is independent of the account currently viewing it. */
  removeSession(endpoint: string, workspaceId: string, sessionId: string) {
    const matches = (scope: string) => {
      try {
        const parts = JSON.parse(scope);
        return Array.isArray(parts) && parts[0] === endpoint && parts[1] === workspaceId && parts[2] === sessionId;
      } catch { return false; }
    };
    const scopes = new Set([...this.records.keys()].filter(matches));
    try {
      const storage = this.storage();
      for (let index = 0; storage && index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(promptSuggestionStoragePrefix)) continue;
        try {
          const scope = decodeURIComponent(key.slice(promptSuggestionStoragePrefix.length));
          if (matches(scope)) scopes.add(scope);
        } catch { /* Ignore an unrelated malformed key, not the rest of storage. */ }
      }
    } catch { /* Still clear every matching live record if storage is unavailable. */ }
    for (const scope of scopes) this.remove(scope);
  }
  detach(scope: string, owner: object) {
    const record = this.records.get(scope);
    if (!record) return;
    record.owners.delete(owner);
    if (record.owner !== owner) return;
    // StrictMode preflight must leave eligibility intact until transport runs.
    if (record.schedule !== undefined) {
      clearTimeout(record.schedule);
      record.schedule = undefined;
    } else if (record.phase === "pending") this.end(record);
    record.owner = undefined;
  }
  observe(input: PromptSuggestionObservation, owner: object) {
    let record = this.records.get(input.scope);
    if (!input.loaded) return;
    if (!record) {
      while (this.records.size >= this.limit) {
        const victim = [...this.records].find(([, value]) => value.owners.size === 0) ?? this.records.entries().next().value;
        if (!victim) break;
        this.end(victim[1], "skipped");
        this.records.delete(victim[0]);
      }
      record = { turnKey: input.turnKey, latestUserCreatedAt: input.userCreatedAtBaseline ?? input.turnCreatedAt ?? (input.turnKey ? undefined : 0), context: input.context, phase: "skipped", suggestion: null, owners: new Set() };
      const saved = this.restore(input.scope);
      if (saved) {
        if ((record.latestUserCreatedAt ?? 0) > saved.turnCreatedAt) this.forget(input.scope);
        else {
          record.turnKey = saved.turnKey;
          // Legacy entries lack a provable generation binding. Keep their
          // text on disk, hidden, until a genuine newer turn replaces it.
          record.context = typeof saved.context === "string" ? saved.context : "";
          record.latestUserCreatedAt = saved.turnCreatedAt;
          record.suggestion = saved.text;
          record.phase = "ready";
        }
      }
      this.records.set(input.scope, record);
      this.notify();
    } else {
      this.records.delete(input.scope);
      this.records.set(input.scope, record);
      if (record.phase === "ready" && typeof input.userCreatedAtBaseline === "number" &&
        input.userCreatedAtBaseline > (record.latestUserCreatedAt ?? 0) &&
        (input.turnCreatedAt ?? -Infinity) < input.userCreatedAtBaseline) {
        this.forget(input.scope);
        this.end(record, "skipped");
        record.latestUserCreatedAt = input.userCreatedAtBaseline;
      }
      if (record.turnKey !== input.turnKey) {
        // A different visible turn can be revert/history replay, not a new
        // submission. Missing or tied timestamps are conservatively baselines.
        const createdAt = input.turnCreatedAt;
        const newUser = typeof createdAt === "number" && Number.isFinite(createdAt) &&
          typeof record.latestUserCreatedAt === "number" && createdAt > record.latestUserCreatedAt;
        if (newUser) {
          this.forget(input.scope);
          this.end(record, "skipped");
          record.turnKey = input.turnKey;
          record.context = input.context;
          record.owner = undefined;
          record.latestUserCreatedAt = createdAt;
          record.phase = input.turnKey && input.enabled ? "eligible" : "skipped";
        } else {
          // Revert/history projections hide a ready placeholder, but do not
          // replace its real-turn frontier or make historical turns eligible.
          if (record.phase !== "ready") this.finish(input.scope);
          return;
        }
      }
    }
    // A newer real tail can arrive while revert still shows an older turn.
    if (record.phase === "ready" && typeof input.userCreatedAtBaseline === "number" &&
      input.userCreatedAtBaseline > (record.latestUserCreatedAt ?? 0)) {
      this.forget(input.scope);
      this.end(record, "skipped");
    }
    // Metadata can arrive after the first user-message frame. Establish only a
    // baseline in that case; it must not retroactively qualify that same turn.
    if (typeof input.turnCreatedAt === "number" && Number.isFinite(input.turnCreatedAt)) {
      record.latestUserCreatedAt = Math.max(record.latestUserCreatedAt ?? input.turnCreatedAt, input.turnCreatedAt);
    }
    if (typeof input.userCreatedAtBaseline === "number" && Number.isFinite(input.userCreatedAtBaseline)) {
      record.latestUserCreatedAt = Math.max(record.latestUserCreatedAt ?? input.userCreatedAtBaseline, input.userCreatedAtBaseline);
    }
    record.owners.add(owner);
    // Context changes hide ready text via read/snapshot, without rebinding or
    // deleting its original generation context, draft, mount or pane state.
    if (record.phase === "ready") return;
    // The hidden duplicate may commit before the active pane on a new turn.
    // Leave that observation available for the active owner in this loop;
    // an actually background-only completion is finalized before dispatch.
    if (!input.active && !record.owner && record.phase === "eligible" && !input.running) {
      record.owner = owner;
      record.backgroundCompletion = true;
      record.schedule = setTimeout(() => {
        record!.schedule = undefined;
        if (record!.owner === owner && record!.phase === "eligible") this.end(record!, "skipped");
      }, 0);
      return;
    }
    if (!input.enabled || record.context !== input.context) {
      this.end(record, "skipped");
      return;
    }
    // An inactive copy of the same session cannot cancel the active pane's work.
    if (!input.active && record.owner && record.owner !== owner) return;
    if (!input.active && record.phase === "eligible" && input.running && !record.owner) return;
    if (!input.active || (record.phase === "pending" &&
      (input.blocked || input.running || !input.ready || !input.current()))) {
      this.end(record);
      return;
    }
    if (record.phase !== "eligible") return;
    if (input.active && record.backgroundCompletion && record.schedule !== undefined) {
      clearTimeout(record.schedule);
      record.schedule = undefined;
      record.backgroundCompletion = false;
    }
    if (record.schedule !== undefined) return;
    record.owner = owner;
    if (input.running) return;
    if (!input.completed && !input.blocked) return;
    if (input.blocked || !input.empty || !input.ready || !input.canRequest()) {
      this.end(record, "skipped");
      return;
    }
    const target = record;
    target.schedule = setTimeout(() => {
      target.schedule = undefined;
      if (this.records.get(input.scope) !== target || target.phase !== "eligible" || !input.canRequest()) {
        this.end(target, "skipped");
        return;
      }
      const controller = new AbortController();
      target.controller = controller;
      target.phase = "pending";
      target.deadline = setTimeout(() => this.end(target, "skipped"), this.budgetMs);
      let request: Promise<JuggleWorkPromptSuggestion>;
      try { request = input.request(controller.signal); }
      catch { this.end(target, "skipped"); return; }
      this.notify();
      void request.then((result) => {
        if (controller.signal.aborted || this.records.get(input.scope) !== target || target.phase !== "pending") return;
        clearTimeout(target.deadline);
        if (!input.current() || result.turnKey !== target.turnKey || !result.suggestion) {
          this.end(target, "skipped");
          return;
        }
        target.suggestion = result.suggestion;
        target.phase = "ready";
        this.persist(input.scope, target);
        this.notify();
      }, () => {
        if (!controller.signal.aborted) this.end(target, "skipped");
      });
    }, 0);
  }
}

export const promptSuggestionsStore = new PromptSuggestionsStore();
