## Context

See `proposal.md` for motivation. JuggleWork Server already owns the managed OpenCode runtime, stores bounded runtime state in `runtime.sqlite`, fences session mutations by run generation, journals run lifecycle events, and reconciles renderer state with authoritative engine status. The renderer separately projects OpenCode todos as progress for the current run. None of these objects represents a user objective that remains authoritative after a run ends or context is compacted.

The existing remote-control pending-operation store demonstrates durable admission and idempotent redispatch, but it is intentionally scoped to `origin = remote-control`. Goal continuation must not overload renderer draft queues or remote-control semantics. It also must use public session operations instead of modifying OpenCode's private task promises or replaying an arbitrary prior prompt.

## Goals / Non-Goals

**Goals:**

- Make one explicitly created, unfinished goal durable per session.
- Keep goal lifecycle separate from the transient state of an individual model run.
- Preserve a bounded structured checkpoint that can be re-injected after context compaction or process restart.
- Continue eligible goals through server-owned, idempotent, recoverable run admission.
- Stop safely on completion, explicit user control, required user interaction, usage limits, budget exhaustion, repeated blockers, or confirmed lack of progress.
- Present goal state consistently without turning internal continuation requests into separate visible user tasks.

**Non-Goals:**

- Replacing Plan mode, OpenCode agents, OpenCode todos, or automations.
- Supporting more than one unfinished goal in the same session.
- Creating project-wide goals that migrate between unrelated sessions.
- Cloud synchronization or remote-device control of goals in the first release.
- Granting permissions or authorizing publishing, deployment, purchases, deletion, or other external side effects beyond the session's existing authority.
- Guaranteeing uninterrupted execution when the provider, device, account, or operating system is unavailable.

## Decisions

### 1. Goals are server-owned domain objects, not agents or prompts

Add a `goals` table to `runtime.sqlite` with identity and scope (`id`, `workspace_id`, `session_id`), objective and success criteria, lifecycle status, execution state, bounded checkpoint, optional user-specified budget and observed usage, continuation counters, blocker fingerprint/count, active run identity, optimistic version, and timestamps. A partial uniqueness constraint permits at most one non-terminal goal for a workspace/session pair.

Store each admitted attempt in `goal_runs` with a deterministic continuation ordinal and idempotency key. Store content-minimized lifecycle records in `goal_events`; events may contain status codes, criterion identifiers, counters, run identifiers, and timestamps, but not transcript text, tool arguments, file content, credentials, or raw model output. The objective, criteria, and bounded checkpoint remain in the goal row because they are required product state rather than diagnostic telemetry.

Alternative considered: encode the objective in a hidden system message and infer state from the transcript. Rejected because compaction, transcript loss, message projection, and ambiguous model prose cannot provide atomic lifecycle state or reliable restart recovery.

### 2. Goal lifecycle and execution state are independent

Lifecycle status is one of `active`, `paused`, `blocked`, `completed`, or `cancelled`. `completed` and `cancelled` are terminal. Execution state is one of `idle`, `queued`, `running`, `waiting_user`, `retrying`, `budget_limited`, or `usage_limited`.

A run becoming idle or failed changes execution state but does not complete the goal. Pausing is accepted only from an explicit user action. A model blocker report is initially evidence, not an immediate terminal transition; the coordinator moves the goal to `blocked` only after the same normalized blocker recurs in three consecutive goal turns without intervening progress. The user may resume a blocked goal, which resets the blocker audit.

Alternative considered: use a single status enum. Rejected because an active objective can legitimately be idle, waiting for approval, retrying, or unable to consume more usage without being complete or blocked.

### 3. Creation requires current explicit user intent

The plus menu exposes a `目标` entry that opens a setup surface for objective, success criteria, and an optional budget. An equivalent model-facing create operation is available only when the current user request explicitly asks to establish a continuing goal; the system instruction forbids inferring a goal from an ordinary task. Creation fails with the current unfinished goal when the session already has one, allowing the user to edit, complete, or cancel it rather than silently replacing it.

Alternative considered: treat any long prompt as a goal. Rejected because it would unexpectedly retain work and initiate later continuation runs.

### 4. Structured goal operations produce the authoritative checkpoint

Provide model-facing operations to create (under the explicit-intent rule), read, report progress, report a blocker, and request completion. Progress updates identify criteria, concise evidence, a bounded next-action summary, and whether meaningful progress occurred. Completion requires every required criterion to be satisfied or an explicit user override. The server validates versions and legal transitions; model prose alone never mutates goal status.

Before every goal run, Server builds a compact goal envelope containing the goal ID, objective, criteria and their status, most recent checkpoint, remaining optional budget, blocker state, and continuation ordinal. The envelope is rebuilt from durable state instead of preserving the complete prior transcript. Automatic context compaction therefore cannot erase or fork the goal, and a new turn is instructed to inspect current workspace state before repeating work.

Alternative considered: derive checkpoints from todos or final assistant text. Rejected because todos are run-local and natural-language parsing is not a stable protocol.

### 5. A dedicated Goal Coordinator owns continuation admission

Introduce a server-owned coordinator and pump backed by `goal_runs`. When a goal-linked run reaches an authoritative terminal/idle observation, or startup reconciliation finds a non-terminal goal without an active execution, the coordinator evaluates continuation eligibility. An eligible goal receives exactly one durable `queued` run with idempotency key `<goal-id>:<ordinal>`. Admission goes through the existing session mutation/start boundary so generation fencing and authoritative busy checks still prevent concurrent root runs.

The coordinator dispatches a short internal continuation request tagged with goal metadata through supported OpenCode session APIs. The renderer recognizes and groups that internal request under the existing goal presentation rather than rendering another user-authored task. The coordinator never resolves private child-task promises and never replays the original user prompt.

Alternative considered: let the renderer enqueue another composer draft. Rejected because renderer state does not survive application lifecycle reliably and two windows or reconnect races could duplicate execution.

### 6. Continuation is activity-based and bounded

Continuation is allowed only while lifecycle status is `active`, execution is not waiting for the user, no permission or question is pending, optional budget remains, account usage permits work, the session has no authoritative active root run, and the previous run has a terminal or reconciled outcome.

Each goal run tracks last meaningful goal progress separately from provider bytes and tool activity. Provider/tool activity prevents premature run-stall recovery, but it does not by itself prove goal progress. Identical checkpoint and blocker fingerprints across turns drive the no-progress audit. The initial default limit is ten consecutive automatic continuations; reaching it changes execution to `waiting_user` and presents a continue action instead of completing or cancelling the goal.

Provider stalls and delegated-child orphan recovery continue to use the existing run watchdog and authoritative reconciliation. A failed or orphaned run becomes a recorded goal-run outcome; it does not erase the goal and may be retried only through the bounded coordinator policy or explicit user action.

### 7. Budgets are optional and user-authored

No budget is synthesized when the user did not request one. When supplied, a positive token budget is stored with the goal and usage reported by goal-linked model runs is accumulated monotonically. Exhaustion stops automatic continuation in `budget_limited`; it does not mark the goal completed or blocked. Account-level usage limits similarly use `usage_limited` and remain externally controlled. The user may increase a goal budget, but the model cannot silently do so.

### 8. Existing permission and user-interaction boundaries remain authoritative

Goal mode carries the session's current permission mode and does not pre-authorize new scopes. A permission request, question, credential requirement, destructive confirmation, or material scope choice changes execution to `waiting_user` and stops the pump. Answering the interaction permits reevaluation; it does not bypass normal permission handling. Pause and cancellation revoke queued continuations atomically, while cancellation of an already running turn follows the existing session abort path.

### 9. Goal presentation is persistent but separate from run todos

The session UI fetches the current goal when a session opens and displays a compact goal card above the composer or in the session environment surface. It contains objective, lifecycle and execution labels, criterion progress, current/next action, last progress time, optional budget, and pause/resume/cancel actions. OpenCode todos remain the detailed progress of the current run and may be displayed beneath the goal summary.

Goal mutations update renderer query state immediately. OpenCode session lifecycle, reconnect, and snapshot reconciliation invalidate the goal query so coordinator-side changes become visible. While a goal is active, a bounded refresh provides recovery if incremental events are lost. Goal badges remain visible when no run is active; ordinary session running indicators remain run-specific.

### 10. User follow-ups do not silently replace the goal

A user follow-up in the goal's session continues to use the existing immediate steer or queued-submission path. It may supply guidance or resolve an interaction, but it changes objective or criteria only through an explicit goal edit operation. Unrelated questions can be answered without completing, replacing, or automatically resuming a paused goal.

## Risks / Trade-offs

- [Autonomous continuation can loop or repeat file operations] → Use structured checkpoints, deterministic run ordinals, idempotent admission, workspace inspection instructions, progress fingerprints, a continuation cap, and explicit waiting states.
- [Model reports completion incorrectly] → Require criterion-level evidence, reject completion with unresolved required criteria, preserve a user override, and retain the goal event history for diagnosis.
- [Application or Server exits between queueing and dispatch] → Persist admission before dispatch and reconcile queued/dispatching/running goal runs against authoritative session state on startup.
- [Usage accounting differs between providers] → Store normalized usage when available, treat missing usage conservatively, and never claim a budget remains based on a negative or reset counter.
- [Goal text and checkpoints contain user content] → Keep them local in the runtime database, bound their size, exclude them from diagnostic events and routine logs, and delete them with the owning session according to local retention rules.
- [Internal continuation messages fragment the visible transcript] → Tag and group them as goal continuation activity while preserving stored engine history needed for execution recovery.
- [A goal conflicts with automation or remote-control admission] → Route all root-run starts through the existing mutation coordinator and require authoritative idle before dispatch; defer cross-device goal control to a later change.

## Migration Plan

1. Add backward-compatible runtime database tables and indexes; existing sessions have no goal and behave unchanged.
2. Ship read/create/edit/pause/resume/cancel APIs and goal UI with automatic continuation disabled behind the goal feature boundary.
3. Enable structured model operations and checkpoint injection, then validate manual continuation and restart recovery.
4. Enable the coordinator pump with bounded continuation, idempotency, and no-progress safeguards.
5. Remove the feature boundary only after restart, compaction, interaction, stall, budget, and duplicate-dispatch tests pass on macOS and Windows.

Rollback disables new goal creation and continuation dispatch while retaining database rows for a later compatible build. Existing ordinary sessions and OpenCode transcripts remain usable; no main OpenCode schema is modified.
