## Why

JuggleWork currently treats each submitted prompt as an independent session run: plans and todos can describe the current run, but there is no durable objective that survives automatic context compaction, application restarts, or multiple continuation turns. Users who want the application to keep pursuing a result must repeatedly inspect the transcript and ask it to continue, and a run ending, stalling, or exhausting usage can be confused with the objective itself being finished.

## What Changes

- Add an explicit session goal that the user can create with an objective and testable success criteria; a session may have at most one unfinished goal.
- Persist goal lifecycle, execution state, checkpoints, run attempts, optional user-specified budget, and a content-minimized event history in the server-owned runtime database.
- Add structured model-facing goal operations for creating a goal only from explicit user intent, reading the active goal, reporting durable progress or a blocker, and declaring completion with evidence.
- Re-inject a compact goal envelope on every goal run so automatic context compaction and process restarts do not erase the objective or cause completed work to be repeated.
- Add a server-owned coordinator that can safely continue an active goal across multiple runs using durable, idempotent admission records and authoritative session state.
- Stop automatic continuation for explicit pause or cancellation, required user interaction, usage or budget limits, repeated blockers, and confirmed no-progress conditions.
- Add a persistent goal card to the session UI with objective, criteria progress, current activity, last progress time, budget state, and pause/resume/cancel controls.
- Keep goal continuation within the session's existing permission and external-side-effect boundaries; goal mode grants no additional authority.

## Capabilities

### New Capabilities

- `persistent-session-goals`: User-visible creation, persistence, lifecycle, checkpoints, model protocol, progress presentation, and recovery of a session-scoped goal.
- `session-goal-continuation`: Durable and idempotent automatic continuation, no-progress and blocker handling, budget enforcement, and coordination with authoritative session execution.

### Modified Capabilities

None.

## Impact

- Adds goal, goal-run, and goal-event storage to `runtime.sqlite`, including migration and retention behavior.
- Adds local Server goal APIs, validation schemas, goal lifecycle services, a continuation pump, and model-facing goal tools.
- Integrates goal identity and goal envelopes with the existing session start path, mutation coordinator, lifecycle journal, permission broker, and authoritative idle reconciliation.
- Adds renderer query state, session synchronization, composer entry, goal setup flow, goal card, localization, and recovery presentation.
- Adds focused server, renderer, restart-recovery, compaction, idempotency, permission, and end-to-end regression coverage.
- Does not replace OpenCode todo state, Plan mode, automations, or ordinary one-shot task execution.
