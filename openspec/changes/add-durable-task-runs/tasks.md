## 1. Runtime Contracts and Persistence

- [ ] 1.1 Add shared Task Run, Attempt, Operation, recovery, attention-reason, lifecycle-event, and API schemas with strict identifier, revision, generation, timestamp, and enum validation.
- [ ] 1.2 Add runtime SQLite migrations for current task runs, attempts, operations, recovery receipts, and bounded lifecycle events, including indexes, retention, and independent repair of partially upgraded schemas.
- [ ] 1.3 Implement the task-runtime repository with transactional compare-and-swap revisions, generation fences, monotonic terminal states, stable admission identities, and content-free event append.
- [ ] 1.4 Add repository tests for every legal and illegal transition, concurrent revision conflicts, stale generations, duplicate recovery fingerprints, retention, restart reopening, and schema repair.
- [ ] 1.5 Add security tests proving persisted rows and events exclude prompt text, tool arguments/output, file contents, hidden reasoning, credentials, and secret environment canaries.

## 2. Managed Task Admission and Compatibility

- [ ] 2.1 Integrate durable Task Run and initial Attempt reservation with managed session prompt admission so dispatch acceptance or failure is recorded atomically around the existing session mutation fence.
- [ ] 2.2 Return durable task identity alongside compatible session-run responses and add typed clients without breaking existing local-renderer, remote-control, abort, observe, or active-run callers.
- [ ] 2.3 Project managed active-run reads from durable Task Run/Attempt state while preserving the existing compatibility path for unmanaged pre-upgrade OpenCode sessions.
- [ ] 2.4 Integrate terminal observations, authoritative idle reconciliation, abort, and replacement generation handling with durable state, ensuring delayed coordinator and SSE events cannot mutate a newer Attempt.
- [ ] 2.5 Add end-to-end tests for accepted, fast-completing, dispatch-failed, aborted, terminal-error, stale-observation, double-start, and pre-upgrade unmanaged sessions.

## 3. Operation Ledger

- [ ] 3.1 Project authoritative OpenCode tool lifecycle into durable Operations using stable tool-call identity, terminal timestamps, and conservative idempotency classification without storing payloads or output bodies.
- [ ] 3.2 Record approved stable external-job identifiers, result digests, verification digests, and `outcome_unknown` evidence from trusted adapters while treating arbitrary bash and unknown tools as non-idempotent.
- [ ] 3.3 Make repeated snapshot/history/SSE observations idempotent and generation-fenced, including multi-tool turns and reconnect replay.
- [ ] 3.4 Add tests for running, completed, failed, parallel, repeated, stale-generation, external-wait, verified, and unknown-outcome Operations.

## 4. Server Supervisor and Reconciliation

- [ ] 4.1 Implement a Server-owned supervisor that schedules bounded reconciliation for non-terminal Task Runs after managed OpenCode startup, on due progress deadlines, and on explicit wake-up hints.
- [ ] 4.2 Reconcile OpenCode status, messages or V2 history, open model steps, tool state, retry, compaction, interactions, delegated children, pending steers, and Operation evidence into legal Task Run/Attempt states.
- [ ] 4.3 Make renderer stall timers and SSE reconnects wake reconciliation without allowing renderer state to declare success, failure, or destructive recovery.
- [ ] 4.4 Handle startup and shutdown idempotently, fail closed while a session is unreconciled, and preserve valid state when reconciliation is interrupted.
- [ ] 4.5 Add fake-clock tests for active tools, provider retry, waiting interaction, external wait, delegated child, idle completion, engine unavailability, repeated busy heartbeats, and Server restart during each non-terminal state.

## 5. Stall Confirmation and Recovery Receipts

- [ ] 5.1 Implement two-stage stall suspicion and confirmation using unchanged Task Run revision, Attempt generation, durable history/message sequence, and a non-secret terminal-tool fingerprint.
- [ ] 5.2 Exclude any candidate with a pending/running tool, open provider step, retry, compaction, interaction, delegated child, pending steer, external wait, unmanaged session, or unsafe Operation outcome.
- [ ] 5.3 Persist recovery receipts and claim dispatch transactionally so one run/generation/fingerprint can produce at most one stable OpenCode admission ID across retries, reconnects, concurrent clients, and Server restart.
- [ ] 5.4 Implement recovery outcome tracking that returns the Attempt to active/terminal state only after new authoritative progress and moves it to `requires_attention` when the recovery deadline expires.
- [ ] 5.5 Add race tests for busy-to-idle transition, replacement generation, concurrent recovery/cancel, admission timeout with unknown outcome, duplicate watchdogs, SSE replay, and exhausted recovery.

## 6. OpenCode Soft-Recovery Compatibility

- [ ] 6.1 Add the fixed synthetic continuation instruction and run-fenced V2 steer adapter using the persisted recovery admission ID and `resume: false`, with no original-prompt replay or automatic root abort.
- [ ] 6.2 Add a real bundled-OpenCode compatibility test proving a busy loop consumes the steer after terminal tool evidence, remains a single loop, preserves the tool result in context, leaves an idle session idle, and deduplicates repeated admission IDs.
- [ ] 6.3 Gate automatic soft recovery by verified managed runtime capability/version and prove unsupported or changed OpenCode behavior falls back to `requires_attention` rather than `resume: true`, abort, or replay.
- [ ] 6.4 Add transcript, copy, export, and raw diagnostic tests proving the synthetic recovery marker is hidden from normal conversation output but remains traceable by non-secret receipt IDs.

## 7. Task Run APIs and User Actions

- [ ] 7.1 Add collaborator-scoped APIs to list/read Task Runs and bounded events and to request reconcile, resume, or cancel with expected revision and command correlation ID.
- [ ] 7.2 Make resume revalidate engine and Operation evidence and limit the first release to safe reconciliation or retry of the same unknown soft-recovery admission; do not implement general automatic hard recovery.
- [ ] 7.3 Return stable conflict, stale-revision, stale-generation, recovery-unsupported, unsafe-outcome, engine-unavailable, and requires-attention reason codes without leaking task content.
- [ ] 7.4 Add API authorization, validation, idempotency, conflict, restart, and content-minimization tests.

## 8. Desktop and Session Presentation

- [ ] 8.1 Add typed renderer query/cache support for Server-owned Task Run state and invalidate or refresh it after task events, SSE gaps, workspace reconnects, and fenced commands.
- [ ] 8.2 Present compact running, waiting, recovering, requires-attention, and terminal states in the existing session progress surface while preserving todos and tool-derived detail.
- [ ] 8.3 Add revision-fenced resume and cancel actions for attention states, refresh on stale conflicts, and avoid describing unsafe unknown outcomes as automatic retries.
- [ ] 8.4 Ensure prompt acceptance, model narration, stale snapshots, and stale local active-run mirrors cannot override a newer durable Task Run state.
- [ ] 8.5 Add split-pane, reconnect, remount, stale-query, recovery, attention, terminal, accessibility, and localization tests.

## 9. Migration, Observability, and Rollout

- [ ] 9.1 Add a local capability flag defaulting off, dual-write diagnostics, startup metrics, stable reason-code logs, and bounded counters without task content.
- [ ] 9.2 Verify existing session-run journal, pending steer/enqueue operations, remote control, delegated-child recovery, compaction, permissions, and workspace reload behavior remain compatible.
- [ ] 9.3 Add crash-point integration coverage around Task Run reservation, prompt admission, Operation completion, recovery claim, upstream recovery admission, and terminal settlement.
- [ ] 9.4 Run focused app, Desktop, Server, and packaged-sidecar tests; run all affected type checks and `openspec validate add-durable-task-runs --strict`.
- [ ] 9.5 Document feature enablement, fail-closed behavior, runtime database retention, diagnostics, rollback, and the deferred hard-recovery boundary before enabling the first managed local workspace cohort.
