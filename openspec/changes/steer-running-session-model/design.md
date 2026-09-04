## Context

See `proposal.md` for the user-visible mismatch. The relevant execution chain is:

1. A JuggleWork-mounted client starts a run through `POST /workspace/:id/sessions/:sessionId/runs/start` with a prompt containing `model` and optional `variant`/`reasoning_effort`.
2. Server proxies that prompt to OpenCode. Desktop model selection currently updates only session-scoped browser storage and the default preference.
3. OpenCode 1.18.15 persists the selected model on each user message. Its active run loop reloads messages on every iteration and resolves each provider request from the newest user message's model. A prompt submitted while the runner is already active persists its user message and coalesces onto the existing run instead of creating a concurrent loop.
4. A normal busy `prompt_async` with a reply can race with run completion and start an unsolicited new response. OpenCode also supports `noReply: true`, which records the user message and session model but never starts a run by itself.
5. OpenCode text-part inputs support `synthetic` and metadata. The renderer already drops synthetic text from visible UI messages, but all transcript copy/export paths need explicit regression coverage.

## Goals / Non-Goals

**Goals:**
- Change the model of a running JuggleWork-managed session from the first provider request that has not yet started
- Preserve the existing run identity, task grouping, tool state, permissions, and context
- Make admission race-safe: a late steer must not start an extra assistant response or alter a replacement run
- Preserve the existing model picker and conversation presentation without exposing steering lifecycle state
- Avoid an OpenCode fork and establish a compatibility test for the upstream behavior being relied upon

**Non-Goals:**
- Migrating an already-streaming provider request to another model
- Changing model assignments inside already-started child/subagent sessions; each child keeps its own agent/model contract unless independently steered in a future change
- Applying this behavior to arbitrary unmanaged or incompatible OpenCode endpoints in the first release
- Replaying or regenerating text already produced by the prior model
- Hiding the model change from diagnostics or raw engine storage

## Decisions

1. **Record a synthetic `noReply` user marker rather than aborting, restarting, or modifying OpenCode.** Server records a message with the target model, model behavior, a fixed continuation instruction, `synthetic: true`, `noReply: true`, and namespaced model-steer metadata. If the old run is still active, its next loop iteration sees this as the newest user message and selects the new model. If the run has already ended, `noReply` prevents an unsolicited new run while the session-level model still advances for future prompts.
   - Rejected: abort-and-retry loses in-flight tool state and may duplicate side effects.
   - Rejected: updating only session metadata does not change `lastUser.model`, which is authoritative inside the active loop.
   - Rejected: forking OpenCode or adding a mutable engine-global model pointer adds a high-maintenance dependency when the required semantics already exist.

2. **Add an explicit, run-fenced Server operation.** Add `POST /workspace/:id/sessions/:sessionId/runs/:runId/model-steers` with collaborator scope. The request carries a command correlation id, expected run generation, target `{ providerID, modelID }`, and normalized optional variant/reasoning behavior. Server validates identifiers, resolves the workspace runtime, confirms the requested model is currently available, and verifies that `(runId, generation)` is still active before recording the marker. Responses distinguish `recorded`, `already_recorded`, `not_running`, and stale-run conflicts.
   - The operation is separate from `/runs/start`: start rejects a busy local run and represents a new user task, while model steer mutates the routing of an existing task.
   - The operation is separate from remote-control text steer: model steer has no new user intent, must be transcript-transparent, and needs provider/model validation.

3. **Serialize model steer admission with local run start for the same session.** A per-session mutation gate orders model-steer recording and local run-start admission. A run started after an accepted steer therefore writes its real user message later and remains authoritative; a steer arriving after a replacement run is reserved fails its old run fence. Abort and terminal observation retain their existing coordinator semantics but expose enough generation state for the gate to reject stale writes.
   - This avoids the dangerous case where a delayed old-run steer becomes the newest user message inside a newly started task.

4. **Use no-reply synchronous message persistence rather than fire-and-forget `prompt_async`.** Server adds a helper that POSTs the synthetic prompt to OpenCode's synchronous message endpoint with `noReply: true` and does not return success until the marker has been persisted. It still does not wait for or start an assistant response. A stable command correlation id provides idempotence at the JuggleWork boundary; retries return the prior result and never append duplicate markers. Server persists a bounded model-steer receipt keyed by workspace/session/run/correlation id, generates the OpenCode message ID once, and reuses that ID and terminal receipt on retry. Receipt reconciliation distinguishes an unknown upstream outcome from a confirmed failure so a timeout cannot append a second marker.

5. **Apply last-accepted selection semantics.** Desktop serializes model-steer submissions per session and coalesces consecutive unsubmitted choices. Server preserves acceptance order; when more than one distinct marker is recorded before the loop reads again, OpenCode's newest-user ordering makes the last marker authoritative. Re-selecting the last queued or last observed model is a no-op.

6. **Reuse normal prompt model-behavior normalization.** The desktop computes the same sanitized variant and Codex reasoning-effort translation used by `sendPrompt`. Server rejects unavailable provider/model pairs before marker persistence. Unsupported variants are rejected or omitted according to the normal prompt contract; stale behavior from the prior model is never copied implicitly.

7. **Keep steering state outside user-visible model state.** The picker continues to show only the existing session selection. A per-session background coordinator may transiently retain the latest requested target, run fence, correlation ID, and submission promise to serialize/coalesce work, but it MUST NOT add pending, applied, actual-model, fallback, toast, or error presentation. Terminal run evidence or request completion clears coordinator bookkeeping silently. Dispatch failure retains the local selection so the next normal task uses it.

8. **Synthetic markers remain hidden but diagnosable.** Use a namespaced text-part metadata marker (for example `metadata.jugglework.model_steer`) and `synthetic: true`. Extend raw-to-UI conversion, task grouping, copy, and export tests so the marker cannot create a visible turn or boundary. Raw OpenCode storage and safe diagnostics retain non-secret target model, run fence, operation id, and timestamps.

9. **Guard the upstream contract with a packaged-sidecar test.** Add an integration fixture that starts a real bundled OpenCode sidecar, begins a tool-bearing run under model A, records a no-reply synthetic user marker under model B while busy, and proves: one run loop remains active; the in-flight request stays on A; the next assistant message records B; the marker remains hidden by renderer mapping. Keep focused unit tests for all local code, but do not substitute mocks for this compatibility proof.

## Risks / Trade-offs

- **[Upstream behavior changes]** OpenCode may stop re-reading `lastUser.model` or alter busy prompt coalescing → pin the relied-upon sidecar version, run the packaged compatibility test on upgrades, and disable active-run steering rather than claiming success when the test/runtime capability is unavailable.
- **[One extra context message]** Every accepted steer adds a short synthetic user message → coalesce rapid desktop changes and keep the continuation text minimal; preserve it because it is the mechanism that makes routing and task continuation deterministic.
- **[Provider-bound metadata across models]** Prior provider tool-call metadata may be incompatible with a new provider → rely on OpenCode's existing cross-model message conversion and add cross-provider integration coverage, especially signed reasoning/tool calls.
- **[Late admission race]** A run can end while the marker is being persisted → `noReply` prevents a new response, run fencing plus session serialization protects replacement runs, and UI confirmation remains assistant-evidence-based.
- **[Invalid model poisons latest-user state]** Persisting an unavailable model would make the next loop fail → perform authoritative provider/model validation before writing the marker.
- **[Picker can temporarily differ from the in-flight request]** Local selection changes immediately while an old request streams → accept this existing transient behavior as part of an intentionally invisible feature; rely on internal receipts and assistant-message evidence for diagnostics and tests, not normal UI.

## Migration Plan

1. Land Server schema, run-fenced model-steer operation, idempotency, validation, and focused tests behind a local capability flag defaulting off.
2. Add packaged OpenCode compatibility coverage and enable the Server capability only when the bundled sidecar contract is verified.
3. Land desktop background submission coordination and synthetic-marker filtering without changing normal model or conversation presentation.
4. Enable for JuggleWork-managed local workspaces first; verify same-provider and cross-provider switches during text streaming, tool execution, retry, compaction, and run completion.
5. Expand to compatible managed remote workspaces only after endpoint/version capability negotiation is available.

Rollback is additive: disable the capability flag and keep existing model-selection persistence. Active tasks then revert to next-task-only behavior; already stored synthetic markers remain hidden and harmless. No data migration is required.
