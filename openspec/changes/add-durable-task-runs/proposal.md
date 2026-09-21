## Why

Long-running JuggleWork tasks currently depend on an in-memory session run and the health of one OpenCode agent loop. If that loop remains busy after a tool has completed, or Desktop/Server restarts while work is active, JuggleWork cannot reliably distinguish active work from a lost continuation, preserve a recovery decision, or resume without risking duplicate side effects.

The first durable-task-runtime release should make execution state survive UI and Server interruptions, reconcile it against OpenCode and recorded tool outcomes, and recover a narrowly proven stalled continuation without replaying the original task.

## What Changes

- Add a Server-owned, SQLite-backed task-run state machine for user task intent, OpenCode attempts, and tool/external operations.
- Persist non-terminal runs, revisions, generation fences, progress timestamps, recovery receipts, operation outcomes, and content-free lifecycle events.
- Reconcile non-terminal task runs against authoritative OpenCode session status and persisted operation evidence after startup, reconnect, and watchdog deadlines.
- Detect a root attempt stalled after all observable tools have reached a persisted terminal state, then admit at most one run-fenced soft-recovery steer without replaying the original prompt or automatically aborting the root session.
- Mark uncertain or unsafe outcomes as requiring attention instead of automatically retrying non-idempotent work.
- Expose task-run status, recovery state, and attention reasons through Server APIs and session UI while preserving the existing conversation transcript and task-progress presentation.
- Keep the first release deliberately scoped: task steps remain inferred from attempts and operations; automatic hard recovery, arbitrary workflow planning, cross-device execution, and automatic retry of unknown side effects are deferred.

## Capabilities

### New Capabilities

- `durable-task-runtime`: Persistent Task Run, Attempt, and Operation state, legal transitions, reconciliation, recovery fencing, and safe restart behavior.

### Modified Capabilities

- `server-owned-runtime`: Extend Server authority from engine lifecycle and in-memory session mutation state to durable task execution and startup reconciliation.
- `session-runtime-observability`: Turn stalled evidence into a Server-owned recovery decision with one safe soft-recovery attempt and an explicit requires-attention outcome.
- `session-task-progress`: Present durable task-run status, recovery, and attention state without treating prompt acceptance or model narration as completion evidence.

## Impact

- Adds runtime SQLite schema and repositories under `apps/server`, plus a Server supervisor/reconciler and task-run APIs.
- Evolves `session-mutation-coordinator`, session routes, lifecycle journaling, and OpenCode V2 steer integration around persistent task and attempt identities.
- Adds typed task-runtime contracts and client methods shared by Server, Electron, and renderer.
- Updates session synchronization and session surfaces to consume durable task-run state rather than infer recovery solely from renderer timers.
- Requires focused state-machine, crash/restart, race, idempotency, and UI tests plus a real bundled-OpenCode compatibility test for soft-recovery steer behavior.
- Introduces no external service or database dependency and does not persist prompts, tool arguments, tool output, credentials, or hidden reasoning in the task-runtime ledger.
