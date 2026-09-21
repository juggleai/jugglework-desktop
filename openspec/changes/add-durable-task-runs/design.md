## Context

See `proposal.md` for motivation. JuggleWork Server currently coordinates one in-memory active session mutation per workspace/session, records a bounded diagnostic journal, and persists remote pending steer/enqueue operations with restart reconciliation. Renderer session sync owns the existing no-progress watchdog. OpenCode remains the execution engine and exposes session status, messages, durable V2 history, abort, and V2 prompt admission.

The present boundaries create two gaps. First, accepted task identity and active-run generation are lost when Server restarts even if OpenCode continues running. Second, a tool may have a persisted terminal result while the OpenCode session remains busy without scheduling the next provider step. Replaying the original prompt or automatically aborting the root loop can duplicate side effects.

The first version therefore needs durable execution ownership and a conservative soft-recovery path, not a general workflow language.

## Goals / Non-Goals

**Goals:**

- Persist managed task, attempt, and operation state in the existing runtime SQLite database.
- Make Server the authority for task lifecycle, reconciliation, recovery admission, and attention decisions.
- Survive renderer disconnects and Server restarts without replaying original prompts.
- Detect the narrow state where all observable tools are terminal but the same OpenCode loop remains busy without further progress.
- Admit at most one idempotent soft-recovery steer for a stable run/checkpoint fingerprint.
- Fail closed for uncertain non-idempotent outcomes and stale generations.
- Expose enough content-free state and events for trustworthy UI and diagnostics.

**Non-Goals:**

- A general DAG/workflow authoring system or model-authored step planner.
- Automatic root abort followed by prompt replay.
- Exactly-once semantics for arbitrary shell commands or third-party APIs.
- Persisting prompts, tool arguments, command output, model output, hidden reasoning, or credentials in the task ledger.
- Continuing local execution while the host process is powered off.
- Cross-device ownership transfer, schedules, or hosted workers.
- Replacing OpenCode's internal agent loop or private continuation mechanisms.

## Decisions

### 1. Model Task Run, Attempt, and Operation separately

A Task Run represents one accepted user objective and remains stable across recovery. An Attempt represents one OpenCode loop generation. An Operation represents an observed tool or external side effect. The first release does not persist first-class planned Steps; UI progress continues to use todos and tool observations, while the durable Task Run records lifecycle and safety evidence.

This is preferred over extending a single active-run row because a replacement Attempt must not erase the history or safety evidence of prior operations. It is also smaller than introducing the full Task Run → Step → Attempt → Operation model immediately.

### 2. Store current state plus an immutable content-free event log

Add runtime SQLite tables for current Task Runs, Attempts, Operations, and lifecycle events. Current rows make reads and reconciliation efficient; append-only events explain transitions. Every mutation runs in a transaction and advances a Task Run revision. Attempt replacement advances generation.

The existing session lifecycle journal remains available during migration but is not the durable source of truth. The pending-operation store provides the implementation pattern for schema repair, restart recovery, stable IDs, bounded retention, and fail-closed admission.

Alternatives rejected:

- Rebuild state solely from OpenCode transcript: it cannot represent JuggleWork recovery receipts, unsafe outcomes, or user decisions reliably.
- Persist only events: unnecessary replay complexity for every active-session read.
- Keep the coordinator in memory and persist diagnostics only: does not survive Server restart.

### 3. Create the Task Run at managed prompt acceptance

The Server start path reserves a Task Run and initial Attempt under the existing per-session mutation fence, dispatches the prompt, then records accepted or dispatch-failed state. The API returns both the compatible session run and durable task identity. Only one non-terminal Task Run may own a managed session at a time in this release.

Existing sessions that were already active before the schema becomes available are treated as unmanaged active sessions. They may continue and be reconciled by the compatibility path, but the system does not synthesize a recoverable Task Run without an accepted-task receipt.

### 4. Use explicit legal transitions with revision and generation CAS

Task Run states are:

```text
created -> running
running <-> waiting_tool | waiting_external | waiting_user
running | waiting_* -> stalled -> recovering
recovering -> running | succeeded | failed | requires_attention
any non-terminal -> cancelled | requires_attention
running | waiting_* -> succeeded | failed
```

Attempts use reserved, admitted, running, waiting, stalled, recovering, completed, failed, aborted, superseded, or unknown. Operations use prepared, dispatching, running, waiting_external, completed, verified, failed, cancelled, or outcome_unknown.

All commands carry `expectedRevision`; observations carry Task Run, Attempt, run, and generation identity. Terminal state is monotonic. A stale callback cannot mutate a replacement generation.

### 5. Make a Server supervisor reconcile non-terminal tasks

The supervisor runs after managed OpenCode initialization and on bounded deadlines. It reads persisted non-terminal runs and samples:

- OpenCode authoritative session status;
- current messages or V2 durable history;
- tool states and terminal timestamps;
- pending permission/question state;
- retry, compaction, and delegated-child activity;
- Operation receipts and external job identities.

It derives state but does not infer success from model text. Repeated identical busy heartbeats do not count as progress. New message/history sequence, model output, tool state, interaction state, external-job state, or terminal evidence does.

Renderer watchdogs become wake-up hints. Correctness does not depend on a mounted session surface.

### 6. Record operations from authoritative OpenCode evidence

The first release records OpenCode tool-call identity, tool name, state, start/end timestamps, idempotency class, and digests or stable external IDs exposed by trusted adapters. It does not ingest arbitrary argument or output bodies.

Default idempotency classifications are conservative:

- known read-only tools: `read_only`;
- tools with an explicit stable operation key: `idempotent`;
- side effects with a supported read-back probe: `query_before_retry`;
- arbitrary bash and unknown tools: `non_idempotent`.

This ledger is evidence for recovery; it does not make arbitrary tools exactly once. An uncertain non-idempotent outcome forces `requires_attention`.

### 7. Detect stalls with two-stage, state-specific confirmation

The ordinary no-progress threshold remains suspicion only. A root Attempt is eligible for soft recovery only when two authoritative samples separated by a confirmation grace prove all of the following for the same generation and checkpoint fingerprint:

- OpenCode remains busy;
- every current-turn tool is completed or failed with terminal time;
- no tool is pending or running;
- no provider/model step is open after the latest terminal tool event;
- no retry, compaction, permission, question, delegated child, queued steer, or external wait is active;
- no message/history sequence or Operation progress changed.

The fingerprint hashes non-secret identifiers and terminal evidence: workspace, session, Task Run, Attempt, generation, assistant message, tool call IDs, terminal states, and terminal timestamps. It contains no tool payload or output.

### 8. Soft recovery uses one run-fenced, idempotent OpenCode admission

For a confirmed stall, Server persists a recovery receipt before or atomically with claiming dispatch. It uses a stable admission ID derived from the fingerprint and submits a fixed synthetic continuation instruction to the same OpenCode session. The instruction states that persisted tool results are authoritative and completed calls must not be repeated solely because of recovery.

The preferred OpenCode contract is V2 `delivery: "steer"` with `resume: false`, because a late recovery must not start a new loop after the old run becomes idle. This capability remains disabled unless a bundled-sidecar compatibility test proves that the pinned OpenCode version consumes such a steer in an existing busy loop, does not create a concurrent loop, leaves an idle session idle, and deduplicates a repeated admission ID.

If that contract is unsupported, the state machine still ships reconciliation and `requires_attention`, but automatic soft recovery remains off. It MUST NOT silently fall back to `resume: true`, root abort, or prompt replay.

Admission success is not recovery success. The supervisor waits for a new authoritative progress sequence or terminal state. If the deadline expires, the receipt becomes exhausted and the Task Run enters `requires_attention`; the same fingerprint can never generate another admission.

### 9. Hard recovery is user-controlled and deferred

The first release exposes attention reasons and fenced resume/cancel commands, but it does not automatically abort and create a replacement Attempt. A resume request re-runs reconciliation and may retry only an unfinished soft-recovery admission with the same stable ID when its upstream outcome is unknown. General abort-and-continuation checkpoint generation is deferred until Operation evidence and product approval UX have broader coverage.

This intentionally prioritizes not duplicating production side effects over unattended completion.

### 10. Keep compatibility façades during migration

Existing session-run APIs and `session-mutation-coordinator` remain as compatibility façades. New starts create durable Task Runs, and active-run reads project from durable state where available. Legacy/unmanaged activity continues through existing reconciliation. Electron and renderer clients add Task Run reads and event handling incrementally.

The earlier remote-event rehydration behavior remains necessary: after a reconnect, clients replace local mirrors from Server-owned active run and Task Run state.

### 11. Present durable state without replacing transcript UI

The session surface shows a compact status derived from Task Run state: running, waiting, recovering, requires attention, or terminal. Existing todo and tool-derived summaries remain the detailed progress content. Recovery instructions, fingerprints, and synthetic continuation markers are filtered from normal transcript, copy, and export while remaining diagnosable by non-secret IDs.

The first release does not add a separate workflow editor or global task center.

## Risks / Trade-offs

- **[OpenCode steer semantics change]** The pinned sidecar may not safely consume `resume: false` steer or a future upgrade may change it → gate automatic recovery on a real packaged-sidecar compatibility test and fail closed when unsupported.
- **[False stall detection]** A provider request may be active without visible output → require durable history/message evidence that no step is open, two samples, and unchanged generation/fingerprint.
- **[Duplicate side effects]** A model may choose to call a semantically equivalent tool after recovery → never replay the original prompt, admit once, carry explicit continuation wording, classify arbitrary bash as non-idempotent, and require attention for uncertain outcomes.
- **[Split authority during migration]** Durable Task Run state and the in-memory coordinator could diverge → make durable transactions primary for managed starts and treat the coordinator as a projection/fence until removal.
- **[SQLite growth]** Operation and event rows may grow quickly → retain current non-terminal state, bound terminal/event retention, index active and session reads, and purge without removing live recovery receipts.
- **[Startup latency]** Reconciling many tasks could delay readiness → make startup scheduling bounded and asynchronous after schema initialization, while commands for an unreconciled session fail closed.
- **[Privacy leakage]** Recovery evidence could accidentally capture tool data → schema accepts only IDs, enums, timestamps, hashes, stable reason codes, and explicitly approved external job IDs; tests scan serialized rows/events for canary secrets.
- **[Unmanaged pre-migration runs]** Active loops at upgrade time lack durable acceptance evidence → preserve existing behavior and do not auto-recover them.

## Migration Plan

1. Add shared types, SQLite schema, repository, transition engine, and tests behind a local capability flag defaulting off.
2. Integrate managed task start/observe/abort with dual-write verification, keeping current session-run responses and lifecycle journal.
3. Add supervisor startup reconciliation and Task Run read APIs; verify crash points around reservation, prompt admission, Operation terminalization, and Server restart.
4. Add operation evidence projection and content-leak tests.
5. Add stall confirmation and recovery receipts while leaving automatic admission disabled.
6. Add the real bundled-OpenCode compatibility suite; enable soft recovery only for verified managed runtime versions.
7. Add renderer status consumption and fenced attention actions, then make durable state primary for managed active-run projection.
8. Remove the feature flag only after soak tests show no duplicate admissions, stale-generation mutations, or unsafe operation retries.

Rollback disables new Task Run creation and soft recovery while retaining tables and read-only diagnostics. Existing OpenCode sessions and compatibility session-run APIs continue to function; persisted non-terminal Task Runs become `requires_attention` rather than being deleted or replayed.
