import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoalEnvelope,
  createGoalStore,
  GOAL_MAX_CONSECUTIVE_CONTINUATIONS,
  GoalStoreError,
  type GoalStore,
} from "./goal-store.js";

const roots: string[] = [];
const stores: GoalStore[] = [];
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function open(path?: string) {
  let resolved = path;
  if (!resolved) {
    const root = await mkdtemp(join(tmpdir(), "goal-store-"));
    roots.push(root);
    resolved = join(root, "runtime.sqlite");
  }
  let time = 1_000;
  const store = await createGoalStore({ path: resolved, now: () => ++time });
  stores.push(store);
  return { store, path: resolved };
}

function errorCode(fn: () => unknown) {
  try { fn(); } catch (error) { return error instanceof GoalStoreError ? error.code : String(error); }
  return null;
}

const base = { workspaceId: "ws", sessionId: "ses", objective: "Ship the export feature", criteria: [{ text: "CSV export works" }, { text: "Docs updated", required: false }] };

describe("goal store", () => {
  test("creates an active goal with the default cap of 10 and rejects a second unfinished goal", async () => {
    const { store } = await open();
    const goal = store.create(base);
    expect(goal).toMatchObject({ status: "active", execution: "idle", continuationCap: GOAL_MAX_CONSECUTIVE_CONTINUATIONS, continuationStreak: 0, version: 1 });
    expect(GOAL_MAX_CONSECUTIVE_CONTINUATIONS).toBe(10);
    expect(goal.criteria.map((criterion) => [criterion.required, criterion.status])).toEqual([[true, "pending"], [false, "pending"]]);
    let conflict: unknown;
    try { store.create(base); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(GoalStoreError);
    expect((conflict as GoalStoreError).code).toBe("goal_exists");
    expect((conflict as GoalStoreError).goal?.id).toBe(goal.id);
    // A different session is independent.
    expect(store.create({ ...base, sessionId: "other" }).id).not.toBe(goal.id);
  });

  test("validates objective and criteria", async () => {
    const { store } = await open();
    expect(errorCode(() => store.create({ ...base, objective: "  " }))).toBe("goal_invalid");
    expect(errorCode(() => store.create({ ...base, criteria: [] }))).toBe("goal_invalid");
    expect(errorCode(() => store.create({ ...base, criteria: [{ text: "optional only", required: false }] }))).toBe("goal_invalid");
    expect(errorCode(() => store.create({ ...base, objective: "x".repeat(4_001) }))).toBe("goal_invalid");
    expect(errorCode(() => store.create({ ...base, criteria: Array.from({ length: 21 }, (_, i) => ({ text: `c${i}` })) }))).toBe("goal_invalid");
  });

  test("enforces versions and legal lifecycle transitions; a terminal goal allows a new one", async () => {
    const { store } = await open();
    const goal = store.create(base);
    expect(errorCode(() => store.pause(goal.id, 99))).toBe("goal_version_conflict");
    const paused = store.pause(goal.id, goal.version);
    expect(paused.status).toBe("paused");
    expect(errorCode(() => store.pause(paused.id, paused.version))).toBe("goal_invalid_transition");
    expect(errorCode(() => store.reserveRun(paused.id, { trigger: "user_continue" }))).toBe("goal_invalid_transition");
    const resumed = store.resume(paused.id, paused.version);
    expect(resumed.status).toBe("active");
    expect(errorCode(() => store.complete(resumed.id, resumed.version, { override: false }))).toBe("goal_criteria_unmet");
    const done = store.complete(resumed.id, resumed.version, { override: true });
    expect(done).toMatchObject({ status: "completed" });
    expect(done.completedAt).not.toBeNull();
    expect(errorCode(() => store.cancel(done.id, done.version))).toBe("goal_terminal");
    // The terminal goal stays as history; current() prefers a new unfinished goal.
    const next = store.create(base);
    expect(store.current("ws", "ses")?.id).toBe(next.id);
    store.cancel(next.id, next.version);
    expect(store.current("ws", "ses")?.status).toBeOneOf(["cancelled", "completed"]);
  });

  test("editing keeps progress for unchanged criteria and resets changed ones", async () => {
    const { store } = await open();
    const goal = store.create(base);
    const [first, second] = goal.criteria;
    const edited = store.edit(goal.id, goal.version, {
      objective: "Ship export v2",
      criteria: [{ id: first!.id, text: first!.text }, { id: second!.id, text: "Docs and changelog updated", required: true }, { text: "New one" }],
    });
    expect(edited.objective).toBe("Ship export v2");
    expect(edited.criteria.map((criterion) => criterion.id).slice(0, 2)).toEqual([first!.id, second!.id]);
    expect(edited.criteria).toHaveLength(3);
    expect(edited.version).toBe(goal.version + 1);
  });

  test("reservations are idempotent while queued, user continue resets the streak, auto stops at the cap", async () => {
    const { store } = await open();
    const goal = store.create({ ...base, continuationCap: 2 });
    const first = store.reserveRun(goal.id, { trigger: "create" });
    expect(first.run).toMatchObject({ ordinal: 1, idempotencyKey: `${goal.id}:1`, state: "queued" });
    expect(first.goal).toMatchObject({ execution: "queued", continuationTotal: 0, continuationStreak: 0 });
    // A repeated reservation before dispatch returns the same queued run.
    expect(store.reserveRun(goal.id, { trigger: "create" }).run.ordinal).toBe(1);
    store.markRunStarted(goal.id, 1, "run_1");
    expect(store.observeRunTerminal("ws", "ses", "run_stale", "completed")).toBeNull();
    expect(store.observeRunTerminal("ws", "ses", "run_1", "completed")?.execution).toBe("idle");

    for (const [ordinal, runId] of [[2, "run_2"], [3, "run_3"]] as const) {
      const auto = store.reserveRun(goal.id, { trigger: "auto" });
      expect(auto.run.ordinal).toBe(ordinal);
      store.markRunStarted(goal.id, ordinal, runId);
      store.observeRunTerminal("ws", "ses", runId, "completed");
    }
    expect(store.get(goal.id)).toMatchObject({ continuationStreak: 2, continuationTotal: 2 });
    expect(errorCode(() => store.reserveRun(goal.id, { trigger: "auto" }))).toBe("goal_continuation_cap");
    expect(store.get(goal.id)?.execution).toBe("waiting_user");

    const manual = store.reserveRun(goal.id, { trigger: "user_continue" });
    expect(manual.goal).toMatchObject({ continuationStreak: 0, continuationTotal: 3 });
    expect(manual.run.trigger).toBe("user_continue");
  });

  test("a failed dispatch releases the reservation", async () => {
    const { store } = await open();
    const goal = store.create(base);
    const { run } = store.reserveRun(goal.id, { trigger: "create" });
    expect(store.markRunFailed(goal.id, run.ordinal, "session_busy")?.execution).toBe("idle");
    expect(store.reserveRun(goal.id, { trigger: "user_continue" }).run.ordinal).toBe(2);
    expect(store.runs(goal.id).map((item) => [item.ordinal, item.state])).toEqual([[2, "queued"], [1, "ended"]]);
  });

  test("events hold status codes only, persist across reopen, and are removed with the session", async () => {
    const { store, path } = await open();
    const goal = store.create(base);
    store.pause(goal.id, goal.version);
    const events = store.events(goal.id);
    expect(events.map((event) => event.event)).toEqual(["paused", "created"]);
    expect(JSON.stringify(events)).not.toContain("Ship the export feature");
    expect(JSON.stringify(events)).not.toContain("CSV export works");
    store.close();
    stores.pop();
    const { store: reopened } = await open(path);
    expect(reopened.get(goal.id)).toMatchObject({ status: "paused", objective: base.objective });
    reopened.deleteSession("ws", "ses");
    expect(reopened.get(goal.id)).toBeNull();
    expect(reopened.events(goal.id)).toEqual([]);
  });

  test("the envelope carries objective, criteria status, checkpoint and remaining continuations", async () => {
    const { store } = await open();
    const goal = store.create(base);
    const envelope = buildGoalEnvelope(goal, { ordinal: 1, trigger: "create" });
    expect(envelope).toContain(base.objective);
    expect(envelope).toContain("[pending] CSV export works");
    expect(envelope).toContain("[pending, optional] Docs updated");
    expect(envelope).toContain("<automatic_continuations_remaining>10</automatic_continuations_remaining>");
    expect(envelope).toContain("<checkpoint>none yet</checkpoint>");
  });
});
