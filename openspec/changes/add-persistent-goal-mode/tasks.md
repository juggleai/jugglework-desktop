## 1. Goal Domain and Persistence

- [x] 1.1 Define shared goal, criterion, checkpoint, lifecycle, execution-state, run, event, continuation-counter, and API schemas with bounded field sizes and legal transition validation.
- [x] 1.2 Add backward-compatible `runtime.sqlite` migrations for goals, goal runs, goal events, uniqueness, idempotency, and lookup indexes.
- [x] 1.3 Implement the goal repository with atomic create, versioned update, checkpoint, lifecycle, usage, and terminal-history operations for both supported SQLite runtimes.
- [x] 1.4 Implement durable goal-run admission records and content-minimized goal-event retention without logging objective, checkpoint, transcript, tool input, file content, or credentials.
- [x] 1.5 Add storage tests for one-unfinished-goal enforcement, optimistic concurrency, terminal history, restart persistence, event minimization, and session deletion cleanup.

## 2. Goal APIs and Lifecycle Service

- [x] 2.1 Add collaborator-authorized local APIs to create, read, list, edit, pause, resume, cancel, explicitly continue, and inspect runs/events for session goals.
- [x] 2.2 Require explicit creation intent, return the existing unfinished goal on conflict, reject non-local (remote, cloud, sandbox) workspaces, and preserve ordinary submissions as non-goal tasks.
- [x] 2.3 Implement independent lifecycle and execution-state transitions, including terminal fencing and reset of blocker audit on explicit resume.
- [x] 2.4 Implement criterion-level progress evidence, bounded checkpoints, stale-generation rejection, and completion validation with an explicit user override path.
- [x] 2.5 Add API and lifecycle tests for invalid transitions, stale versions, premature completion, pause/resume/cancel races, and workspace/session scope isolation.

## 3. Model Goal Protocol and Context

- [x] 3.1 Expose model-facing operations for explicit-intent goal creation, current-goal read, progress reporting, blocker reporting, and completion requests.
- [x] 3.2 Add goal-mode system instructions that forbid inferred creation, inferred pause, premature completion, permission expansion, and repetition of confirmed work.
- [x] 3.3 Build the compact goal envelope from durable objective, criteria, checkpoint, blocker audit, continuation ordinal, and remaining automatic continuations before the cap for every goal run.
- [x] 3.4 Tag internal goal continuation requests with stable metadata and keep them out of the user-authored task presentation while preserving engine history needed for recovery.
- [x] 3.5 Add protocol tests for explicit creation, structured progress, stale updates, compaction reinjection, completion evidence, and ordinary prompts that must not create goals.

## 4. Goal Continuation Coordinator

- [x] 4.1 Implement a server-owned Goal Coordinator and pump that evaluates active goals on run terminal state, authoritative idle, interaction resolution, explicit continue, and startup recovery.
- [x] 4.2 Persist deterministic continuation ordinals and idempotency keys before dispatch and reconcile queued or dispatching records after restart.
- [x] 4.3 Route continuation through the existing session mutation/start boundary with generation fencing, authoritative busy checks, and no concurrent root runs.
- [x] 4.4 Integrate goal-linked run acceptance, progress heartbeat, usage accounting, terminal outcomes, aborts, and orphan reconciliation with the run lifecycle journal.
- [x] 4.5 Suspend continuation for unresolved permissions, questions, credentials, destructive confirmations, material scope choices, and account usage limits.
- [x] 4.6 Implement checkpoint and blocker fingerprints, three-turn repeated-blocker transition, bounded retry, and a consecutive automatic-continuation cap defaulting to 10 that resets only on explicit user continue or resume.
- [x] 4.7 Atomically revoke queued admissions on pause or cancellation and prevent delayed dispatch or terminal events from reactivating a non-active goal.
- [x] 4.8 Add coordinator tests for duplicate idle events, dispatch crashes, restart recovery, busy sessions, stale generations, pause/cancel races, interaction gates, continuation-cap reach and reset, no-progress loops, and orphaned runs.
- [x] 4.9 Add delegated-child integration tests proving recent child activity preserves the parent and child-only stall recovery does not duplicate or abort the goal root run.

## 5. Session and Composer Experience

- [x] 5.1 Add the `目标` plus-menu entry as a sibling of `计划模式`, shown only in local workspaces, and a localized goal setup surface for objective and required success criteria; clear a Plan mode selection when a goal is confirmed.
- [x] 5.2 Add renderer API/query state for current goal, history, mutations, optimistic feedback, reconnect invalidation, and bounded active-goal refresh.
- [x] 5.3 Add a persistent goal card with lifecycle/execution labels, criterion progress, checkpoint or blocker, last progress time, continuations used against the cap, and pause/resume/cancel/continue controls.
- [x] 5.4 Keep goal summary separate from current-run todos and preserve ordinary run indicators when an unfinished goal is idle between turns.
- [x] 5.5 Group internal continuation activity into the same goal presentation across live events, snapshots, automatic context compaction, copy, and export.
- [x] 5.6 Preserve the goal definition for ordinary steer, queued guidance, and unrelated questions; require an explicit edit action for objective or criteria changes.
- [x] 5.7 Add responsive, keyboard, accessibility, light/dark theme, Chinese, and English coverage for setup, active, paused, blocked, waiting, cap-reached, usage-limited, completed, and cancelled states.

## 6. Reliability, Security, and Recovery Validation

- [x] 6.1 Verify goal mode never broadens session permissions or bypasses existing approval, connector, credential, publishing, deployment, deletion, or external-side-effect boundaries.
- [x] 6.2 Add redaction and size-limit tests proving diagnostic events and routine logs exclude goal content, transcript content, tool arguments, files, and credentials.
- [x] 6.3 Add end-to-end coverage for context compaction, Server/app restart, lost SSE events, authoritative snapshot recovery, provider failure, usage reset, and manual resume.
- [x] 6.4 Add end-to-end coverage proving one logical goal remains one presentation across multiple continuations and does not create duplicate user task bubbles or repeated file operations.
- [ ] 6.5 Run focused server and renderer suites, type checks, production builds, OpenSpec strict validation, and manual macOS and Windows goal lifecycle acceptance.

## 7. Rollout and Documentation

- [x] 7.1 Gate creation and automatic continuation independently so storage/UI can ship before autonomous dispatch and rollback can stop new work without deleting goals.
- [x] 7.2 Document lifecycle semantics, the continuation cap and its reset rule, the local-workspace-only scope, recovery behavior, privacy boundaries, and the distinction between Goal mode, Plan mode, todos, and automations.
- [ ] 7.3 Record rollout evidence and confirm ordinary non-goal sessions, remote-control queues, automations, and archived sessions remain behaviorally unchanged.

## P1 Delivery Notes

P1 (local workspaces only) ships the goal store, Goal API, plus-menu entry, setup dialog, goal card, and manual Continue. Automatic continuation is not wired yet: a goal run ending returns the goal to idle and the user starts the next run with Continue.

- 1.4: the store reserves runs with deterministic ordinals and `<goal-id>:<ordinal>` idempotency keys; the coordinator that consumes them is task 4.x.
- 2.4 remains open: completion validation and the user override are implemented, but criterion evidence is only reported by the model protocol in 3.x.
- 3.3 is partly in place: every goal run carries the envelope (objective, criteria status, checkpoint, remaining continuations) through `runs/start` `system`. Checkpoints are only written once 3.1 lands.
- 5.4 remains open: the goal card renders above the todo panel, but internal-continuation grouping (5.5) is not started.

## P2 Delivery Notes

- 3.1: model-facing tools `jugglework_goal_read`, `jugglework_goal_progress`, `jugglework_goal_blocker`, `jugglework_goal_complete` ship as the `jugglework-goal` OpenCode plugin, backed by `POST /workspace/:id/goal-agent/{read,progress,blocker,complete}`. Goal creation stays user-only (no model creation tool), so inferred creation is impossible by construction.
- 2.4: updates are accepted only for the calling session's unfinished goal while its goal run is in progress. `met` needs evidence, unknown criterion ids and missing checkpoints are rejected, and `waived` criteria are not overwritten. Completion requires every required criterion met. The same blocker (case, whitespace, and digit insensitive) three times in a row sets `blocked`; `needsUser` sets `waiting_user`, which survives the run ending. Progress without `madeProgress` increments `noProgressCount`.
- 3.3: the envelope lists criterion ids, checkpoint, last blocker with repeat count, and the tool-call rules.
- Renderer: the card shows blocker reason, per-criterion evidence, and checkpoint; a finished `jugglework_goal_*` tool call invalidates the goal query so the card refreshes immediately.
- 3.2: the plugin injects a standing guardrail instruction (`experimental.chat.system.transform`) only while the session has an unfinished goal. It forbids inferred creation/edit/pause/cancel, premature completion, and permission expansion, and says an ordinary user message is not a goal run. Failures to read the goal never break a turn.
- 3.4: every goal run request carries stable content-free part metadata `jugglework_goal: { goalId, ordinal, trigger }`. Continuation requests (`trigger` other than `create`) are hidden from the task transcript (snapshot and live sync), ignored by prompt suggestions, and excluded from response-language detection. The `create` request stays visible because it restates the user's own objective. Real user content in the same message stays visible.
- 2.5 / 3.5: tests cover a delayed run end after pause/cancel, stale versions, session scope isolation, explicit-only creation, envelope rebuild after a reopen, and lookalike text that must not be treated as a continuation.
- Not done in this phase: grouping continuation activity under one goal presentation in export/copy (5.5) and automatic continuation (P3).

## P3 Delivery Notes

- 4.1 / 4.3: `GoalCoordinator` (`apps/server/src/goal-coordinator.ts`) runs on a 2s timer and is woken by every run terminal event. It continues a goal only when it is active and idle, its last accepted run ended `completed`, the session is authoritatively idle with no mutation-coordinator run, no permission or question is pending (child sessions included), the workspace is local and unsandboxed, and the cap and no-progress limit are not reached. It starts the run through `startSessionRun` (via `startGoalRunInternally`), so admission, response language, and model rules are shared with user-started runs. An unreadable engine status or interaction snapshot fails closed.
- 4.2 / 4.7: the run is reserved durably (`session_goal_runs`, key `<goalId>:<ordinal>`) before dispatch; duplicate passes resolve to the same record. A busy session abandons the reservation and does not consume the cap. Pause and cancel fence a stale candidate: the goal is re-read and reserved with `expectedVersion`, and `reserveRun` refuses non-active goals.
- 4.4 / 4.5: a run that ends `failed`, `aborted`, or `orphaned`, a run that reported no progress three times in a row, three failed dispatches in a row, and the 10-run cap each move the goal to `waiting_user` with a `stopReason` shown on the card. User Stop is respected: it never auto-continues. Pending interactions suspend the pump.
- 4.6: the cap resets only on explicit Continue or Resume; automatic runs do not reset it. Explicit user actions also reset the no-progress count and stop reason.
- 4.8: 17 coordinator unit tests and 4 end-to-end tests cover duplicates, each gate, busy, dispatch failure and a thrown dispatch, cap and reset, no-progress, completion, restart recovery, a stale candidate, and fail-closed reads.
- 7.1: creation and automatic continuation are independent. `JUGGLEWORK_GOAL_AUTO_CONTINUE=0` stops dispatch at runtime without deleting goals or blocking manual Continue.
- Restart recovery: a `running` run the mutation coordinator no longer knows is closed as `orphaned`; a `queued` or `dispatching` run of unknown outcome is never re-dispatched automatically. Both wait for the user, who sees the checkpoint.
- Not done in P3: usage-limit detection (`usage_limited` has no producer yet, so an account limit surfaces as a failed run), delegated-child stall integration test (4.9), and per-user toggle UI for the switch.

## P4 Delivery Notes

- 4.9: delegated-child tests show a busy child keeps the goal run alive with no continuation behind it, and child-only stall recovery aborts the child without aborting or duplicating the goal root run.
- Usage limit: a run that failed with a hard account limit (402, `insufficient_quota`, plan or balance wording; transient 429 is excluded) waits in `usage_limited` instead of `run_failed`. Only an explicit Continue clears it. An archived session is never continued automatically.
- 5.4 / 5.6: the goal card shows objective and criteria progress only and exposes no todo content; an unfinished goal stays visible between turns. Ordinary submissions, steer, and queued guidance make no goal calls; only the explicit edit call changes the objective or criteria.
- 5.5 / 6.4: several continuations render as one task bubble and one assistant group with no repeated tool output; copy and export read the same presentation, so internal requests never appear in them. The server records one run per ordinal and never repeats the first request.
- 5.7: the card is a labelled region, state changes are announced, controls have accessible names and focus rings, the control row wraps on narrow widths, and styling uses theme tokens only. All states have English and Chinese labels.
- 6.1: a goal run carries no permission, tool, or agent override and never touches the session permission mode; a pending permission or question suspends continuation and approval still goes through the normal flow.
- 6.2: events hold status codes and counters only; goal text, evidence, checkpoints and blockers stay out of logs and event history; oversized inputs are rejected or truncated.
- 6.3: the goal envelope is rebuilt identically after compaction or a Server restart; goals and runs survive a restart; a run lost across a restart is closed as orphaned and waits for the user; a provider failure waits, a usage limit waits as `usage_limited`, and manual Continue resumes; missed renderer events are recovered by invalidating goal queries on idle and on stream reconnect.
- 7.2: user documentation is `packages/docs/start-here/do-work-with-it/goals.mdx`.
- Still open and not claimed: 6.5 manual macOS and Windows lifecycle acceptance, and 7.3 rollout evidence (behavior of ordinary sessions, remote-control queues, automations, and archived sessions on a real build). These need a human run on both platforms.
