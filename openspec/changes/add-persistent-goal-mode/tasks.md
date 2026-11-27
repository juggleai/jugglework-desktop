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
- [ ] 2.4 Implement criterion-level progress evidence, bounded checkpoints, stale-generation rejection, and completion validation with an explicit user override path.
- [ ] 2.5 Add API and lifecycle tests for invalid transitions, stale versions, premature completion, pause/resume/cancel races, and workspace/session scope isolation.

## 3. Model Goal Protocol and Context

- [ ] 3.1 Expose model-facing operations for explicit-intent goal creation, current-goal read, progress reporting, blocker reporting, and completion requests.
- [ ] 3.2 Add goal-mode system instructions that forbid inferred creation, inferred pause, premature completion, permission expansion, and repetition of confirmed work.
- [ ] 3.3 Build the compact goal envelope from durable objective, criteria, checkpoint, blocker audit, continuation ordinal, and remaining automatic continuations before the cap for every goal run.
- [ ] 3.4 Tag internal goal continuation requests with stable metadata and keep them out of the user-authored task presentation while preserving engine history needed for recovery.
- [ ] 3.5 Add protocol tests for explicit creation, structured progress, stale updates, compaction reinjection, completion evidence, and ordinary prompts that must not create goals.

## 4. Goal Continuation Coordinator

- [ ] 4.1 Implement a server-owned Goal Coordinator and pump that evaluates active goals on run terminal state, authoritative idle, interaction resolution, explicit continue, and startup recovery.
- [ ] 4.2 Persist deterministic continuation ordinals and idempotency keys before dispatch and reconcile queued or dispatching records after restart.
- [ ] 4.3 Route continuation through the existing session mutation/start boundary with generation fencing, authoritative busy checks, and no concurrent root runs.
- [ ] 4.4 Integrate goal-linked run acceptance, progress heartbeat, usage accounting, terminal outcomes, aborts, and orphan reconciliation with the run lifecycle journal.
- [ ] 4.5 Suspend continuation for unresolved permissions, questions, credentials, destructive confirmations, material scope choices, and account usage limits.
- [ ] 4.6 Implement checkpoint and blocker fingerprints, three-turn repeated-blocker transition, bounded retry, and a consecutive automatic-continuation cap defaulting to 10 that resets only on explicit user continue or resume.
- [ ] 4.7 Atomically revoke queued admissions on pause or cancellation and prevent delayed dispatch or terminal events from reactivating a non-active goal.
- [ ] 4.8 Add coordinator tests for duplicate idle events, dispatch crashes, restart recovery, busy sessions, stale generations, pause/cancel races, interaction gates, continuation-cap reach and reset, no-progress loops, and orphaned runs.
- [ ] 4.9 Add delegated-child integration tests proving recent child activity preserves the parent and child-only stall recovery does not duplicate or abort the goal root run.

## 5. Session and Composer Experience

- [x] 5.1 Add the `目标` plus-menu entry as a sibling of `计划模式`, shown only in local workspaces, and a localized goal setup surface for objective and required success criteria; clear a Plan mode selection when a goal is confirmed.
- [x] 5.2 Add renderer API/query state for current goal, history, mutations, optimistic feedback, reconnect invalidation, and bounded active-goal refresh.
- [x] 5.3 Add a persistent goal card with lifecycle/execution labels, criterion progress, checkpoint or blocker, last progress time, continuations used against the cap, and pause/resume/cancel/continue controls.
- [ ] 5.4 Keep goal summary separate from current-run todos and preserve ordinary run indicators when an unfinished goal is idle between turns.
- [ ] 5.5 Group internal continuation activity into the same goal presentation across live events, snapshots, automatic context compaction, copy, and export.
- [ ] 5.6 Preserve the goal definition for ordinary steer, queued guidance, and unrelated questions; require an explicit edit action for objective or criteria changes.
- [ ] 5.7 Add responsive, keyboard, accessibility, light/dark theme, Chinese, and English coverage for setup, active, paused, blocked, waiting, cap-reached, usage-limited, completed, and cancelled states.

## 6. Reliability, Security, and Recovery Validation

- [ ] 6.1 Verify goal mode never broadens session permissions or bypasses existing approval, connector, credential, publishing, deployment, deletion, or external-side-effect boundaries.
- [ ] 6.2 Add redaction and size-limit tests proving diagnostic events and routine logs exclude goal content, transcript content, tool arguments, files, and credentials.
- [ ] 6.3 Add end-to-end coverage for context compaction, Server/app restart, lost SSE events, authoritative snapshot recovery, provider failure, usage reset, and manual resume.
- [ ] 6.4 Add end-to-end coverage proving one logical goal remains one presentation across multiple continuations and does not create duplicate user task bubbles or repeated file operations.
- [ ] 6.5 Run focused server and renderer suites, type checks, production builds, OpenSpec strict validation, and manual macOS and Windows goal lifecycle acceptance.

## 7. Rollout and Documentation

- [ ] 7.1 Gate creation and automatic continuation independently so storage/UI can ship before autonomous dispatch and rollback can stop new work without deleting goals.
- [ ] 7.2 Document lifecycle semantics, the continuation cap and its reset rule, the local-workspace-only scope, recovery behavior, privacy boundaries, and the distinction between Goal mode, Plan mode, todos, and automations.
- [ ] 7.3 Record rollout evidence and confirm ordinary non-goal sessions, remote-control queues, automations, and archived sessions remain behaviorally unchanged.

## P1 Delivery Notes

P1 (local workspaces only) ships the goal store, Goal API, plus-menu entry, setup dialog, goal card, and manual Continue. Automatic continuation is not wired yet: a goal run ending returns the goal to idle and the user starts the next run with Continue.

- 1.4: the store reserves runs with deterministic ordinals and `<goal-id>:<ordinal>` idempotency keys; the coordinator that consumes them is task 4.x.
- 2.4 remains open: completion validation and the user override are implemented, but criterion evidence is only reported by the model protocol in 3.x.
- 3.3 is partly in place: every goal run carries the envelope (objective, criteria status, checkpoint, remaining continuations) through `runs/start` `system`. Checkpoints are only written once 3.1 lands.
- 5.4 remains open: the goal card renders above the todo panel, but internal-continuation grouping (5.5) is not started.
