import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockerFingerprint,
  buildGoalEnvelope,
  goalRunPromptPart,
  createGoalStore,
  GOAL_BLOCKER_REPEAT_LIMIT,
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
    // Sections are separated by real newlines, never literal backslash-n.
    expect(envelope).not.toContain("\\n");
    expect(envelope.split("\n").length).toBeGreaterThan(5);
    expect(envelope).toContain(base.objective);
    expect(envelope).toContain("[pending] CSV export works");
    expect(envelope).toContain("[pending, optional] Docs updated");
    expect(envelope).toContain("<automatic_continuations_remaining>10</automatic_continuations_remaining>");
    expect(envelope).toContain("<checkpoint>none yet</checkpoint>");
  });

  async function running() {
    const { store } = await open();
    const goal = store.create(base);
    store.reserveRun(goal.id, { trigger: "create" });
    store.markRunStarted(goal.id, 1, "run_1");
    return { store, goal: store.get(goal.id)! };
  }

  test("model progress needs a running goal turn, known criteria, and evidence for met", async () => {
    const { store } = await open();
    const idle = store.create(base);
    const [first] = idle.criteria;
    const report = { criteria: [{ id: first!.id, status: "met" as const, evidence: "ran export test" }], checkpoint: "export done", madeProgress: true };
    // No run in progress: the model cannot change the goal between turns.
    expect(errorCode(() => store.reportProgress("ws", "ses", report))).toBe("goal_invalid_transition");
    expect(errorCode(() => store.reportProgress("ws", "other", report))).toBe("goal_not_found");

    store.reserveRun(idle.id, { trigger: "create" });
    store.markRunStarted(idle.id, 1, "run_1");
    expect(errorCode(() => store.reportProgress("ws", "ses", { ...report, criteria: [{ id: "c_missing", status: "met", evidence: "x" }] }))).toBe("goal_invalid");
    expect(errorCode(() => store.reportProgress("ws", "ses", { ...report, criteria: [{ id: first!.id, status: "met" }] }))).toBe("goal_invalid");
    expect(errorCode(() => store.reportProgress("ws", "ses", { ...report, checkpoint: "   " }))).toBe("goal_invalid");

    const updated = store.reportProgress("ws", "ses", report);
    expect(updated.criteria[0]).toMatchObject({ status: "met", evidence: "ran export test" });
    expect(updated.checkpoint).toBe("export done");
    expect(updated.noProgressCount).toBe(0);
    // Evidence and the checkpoint are product state; events stay content-free.
    expect(JSON.stringify(store.events(idle.id))).not.toContain("ran export test");
    expect(store.events(idle.id)[0]).toMatchObject({ event: "progress_reported", runId: "run_1" });

    // Repeating the same report is not progress.
    expect(store.reportProgress("ws", "ses", report).noProgressCount).toBe(1);
  });

  test("a paused goal rejects model progress and completion until the user resumes it", async () => {
    const { store, goal } = await running();
    const paused = store.pause(goal.id, goal.version);
    const report = { criteria: [{ id: goal.criteria[0]!.id, status: "met" as const, evidence: "x" }], checkpoint: "x", madeProgress: true };
    expect(errorCode(() => store.reportProgress("ws", "ses", report))).toBe("goal_invalid_transition");
    expect(errorCode(() => store.requestCompletion("ws", "ses"))).toBe("goal_invalid_transition");
    expect(store.get(goal.id)!.criteria[0]!.status).toBe("pending");
    store.resume(paused.id, paused.version);
    expect(store.reportProgress("ws", "ses", report).criteria[0]!.status).toBe("met");
  });

  test("the same blocker three times in a row blocks the goal; a different reason restarts the count", async () => {
    const { store, goal } = await running();
    expect(GOAL_BLOCKER_REPEAT_LIMIT).toBe(3);
    expect(blockerFingerprint("Build fails: 3 errors")).toBe(blockerFingerprint("build FAILS - 12 errors"));
    let current = store.reportBlocker("ws", "ses", { reason: "Build fails: 3 errors", needsUser: false });
    expect(current).toMatchObject({ status: "active", blockerCount: 1, execution: "running" });
    current = store.reportBlocker("ws", "ses", { reason: "Network timeout", needsUser: false });
    expect(current.blockerCount).toBe(1);
    current = store.reportBlocker("ws", "ses", { reason: "build fails - 5 errors", needsUser: false });
    current = store.reportBlocker("ws", "ses", { reason: "Build fails: 7 errors", needsUser: false });
    expect(current.blockerCount).toBe(2);
    current = store.reportBlocker("ws", "ses", { reason: "Build fails: 9 errors", needsUser: false });
    expect(current).toMatchObject({ status: "blocked", blockerCount: 3, execution: "waiting_user" });
    // Blocked goals take no further model changes and cannot be auto-continued.
    expect(errorCode(() => store.reportBlocker("ws", "ses", { reason: "again", needsUser: false }))).toBe("goal_invalid_transition");
    expect(errorCode(() => store.reserveRun(goal.id, { trigger: "auto" }))).toBe("goal_invalid_transition");
    // Resume clears the blocker audit.
    const resumed = store.resume(current.id, store.get(goal.id)!.version);
    expect(resumed).toMatchObject({ status: "active", blockerReason: null, blockerCount: 0 });
  });

  test("needsUser keeps waiting_user after the run ends; progress clears a recorded blocker", async () => {
    const { store, goal } = await running();
    const waiting = store.reportBlocker("ws", "ses", { reason: "Which database should I use?", needsUser: true });
    expect(waiting).toMatchObject({ status: "active", execution: "waiting_user", blockerCount: 1 });
    expect(store.observeRunTerminal("ws", "ses", "run_1", "completed")).toMatchObject({ execution: "waiting_user", activeRunId: null });

    // The next run (after the user answers) can report progress, which clears the blocker.
    store.reserveRun(goal.id, { trigger: "user_continue" });
    store.markRunStarted(goal.id, 2, "run_2");
    const first = goal.criteria[0]!;
    const progressed = store.reportProgress("ws", "ses", { criteria: [{ id: first.id, status: "met", evidence: "chose sqlite" }], checkpoint: "db chosen", madeProgress: true });
    expect(progressed).toMatchObject({ blockerReason: null, blockerCount: 0, execution: "running" });
  });

  test("model completion requires every required criterion to be met and still closes the run record", async () => {
    const { store, goal } = await running();
    expect(errorCode(() => store.requestCompletion("ws", "ses"))).toBe("goal_criteria_unmet");
    // Optional criteria do not block completion.
    store.reportProgress("ws", "ses", { criteria: [{ id: goal.criteria[0]!.id, status: "met", evidence: "test passed" }], checkpoint: "done", madeProgress: true });
    const done = store.requestCompletion("ws", "ses");
    expect(done).toMatchObject({ status: "completed", execution: "idle" });
    expect(done.completedAt).not.toBeNull();
    expect(store.unfinished("ws", "ses")).toBeNull();
    // The terminal event for that same run still ends its run record.
    expect(store.observeRunTerminal("ws", "ses", "run_1", "completed")).toMatchObject({ status: "completed", activeRunId: null });
    expect(store.runs(goal.id)[0]).toMatchObject({ state: "ended", outcome: "completed" });
  });

  test("the envelope lists criterion ids, the last blocker, and tells the model to use the goal tools", async () => {
    const { store, goal } = await running();
    const blocked = store.reportBlocker("ws", "ses", { reason: "Tests need a database", needsUser: false });
    const envelope = buildGoalEnvelope(blocked, { ordinal: 2, trigger: "user_continue" });
    expect(envelope).toContain(`id=${goal.criteria[0]!.id} [pending] CSV export works`);
    expect(envelope).toContain('<last_blocker repeats="1">');
    expect(envelope).toContain("jugglework_goal_progress");
    expect(envelope).toContain("jugglework_goal_blocker");
    expect(envelope).toContain("jugglework_goal_complete");
  });

  test("goal run requests carry stable content-free metadata and different wording per trigger", async () => {
    const { store } = await open();
    const goal = store.create(base);
    const first = goalRunPromptPart(goal, { ordinal: 1, trigger: "create" });
    const next = goalRunPromptPart(goal, { ordinal: 2, trigger: "user_continue" });
    expect(first.metadata).toEqual({ jugglework_goal: { goalId: goal.id, ordinal: 1, trigger: "create" } });
    expect(next.metadata.jugglework_goal.trigger).toBe("user_continue");
    expect(first.text).toContain(base.objective);
    // Continuation wording never embeds user data, so metadata alone identifies it.
    expect(next.text).not.toContain(base.objective);
    expect(JSON.stringify(next.metadata)).not.toContain(base.objective);
  });

  test("the envelope is rebuilt from durable state after a reopen, so compaction cannot erase the goal", async () => {
    const first = await open();
    const goal = first.store.create(base);
    first.store.reserveRun(goal.id, { trigger: "create" });
    first.store.markRunStarted(goal.id, 1, "run_1");
    first.store.reportProgress("ws", "ses", { criteria: [{ id: goal.criteria[0]!.id, status: "met", evidence: "bun test export" }], checkpoint: "Export done; docs left", madeProgress: true });
    first.store.close();
    const reopened = await open(first.path);
    const restored = reopened.store.unfinished("ws", "ses")!;
    const envelope = buildGoalEnvelope(restored, { ordinal: 2, trigger: "user_continue" });
    expect(envelope).toContain("Export done; docs left");
    expect(envelope).toContain(`id=${goal.criteria[0]!.id} [met`);
  });
});
