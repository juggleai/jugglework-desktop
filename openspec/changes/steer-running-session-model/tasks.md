## 1. Model-steer contract and persistence

- [ ] 1.1 Add shared Server/client types and strict schemas for run-fenced model-steer requests, target model behavior, correlation IDs, and `recorded` / `already_recorded` / `not_running` / stale-run responses
- [ ] 1.2 Add a bounded persistent model-steer receipt store keyed by workspace, session, run, generation, and command correlation ID, including one generated OpenCode message ID and dispatch/terminal state
- [ ] 1.3 Add receipt-store tests for idempotent retries, conflicting payloads, unknown dispatch outcomes, pruning, restart recovery, and workspace/session isolation

## 2. Server admission and engine dispatch

- [ ] 2.1 Add a synchronous OpenCode no-reply prompt helper that records a synthetic model-steer user marker with namespaced non-secret metadata and confirms persistence before success
- [ ] 2.2 Add the collaborator-scoped `POST /workspace/:id/sessions/:sessionId/runs/:runId/model-steers` route with identifier limits, expected generation, and strict payload validation
- [ ] 2.3 Validate the requested provider/model and normalized variant/reasoning behavior against the authoritative workspace runtime before recording the marker
- [ ] 2.4 Serialize model-steer admission with run start/terminal transitions, reject stale run fences, and guarantee that a late steer cannot alter a replacement run
- [ ] 2.5 Implement idempotent dispatch/reconciliation so retries reuse one receipt and message ID, including ambiguous upstream timeout handling without duplicate markers
- [ ] 2.6 Return `not_running` without recording a marker when the target run is already terminal, preserving next-task-only model selection semantics

## 3. Mounted client and desktop model selection

- [ ] 3.1 Extend the JuggleWork Server client and mounted OpenCode facade with a typed model-steer operation and active-run fence lookup
- [ ] 3.2 Extract one model-behavior normalization path shared by normal prompt submission and model steering, including variant sanitization and Codex reasoning-effort translation
- [ ] 3.3 Route every session-level model picker entry through a per-session steering coordinator after persisting the local selection
- [ ] 3.4 Coalesce rapid model selections, make the last submitted selection authoritative, and avoid duplicate requests for the same target without adding user-visible lifecycle state
- [ ] 3.5 Preserve the selected model and silently degrade to next-task behavior on Server rejection, stale-run response, or transport failure
- [ ] 3.6 Verify split-view selections target only the pane's workspace/session/run and cannot steer the other visible session

## 4. Invisible steering coordination

- [ ] 4.1 Keep per-session steering bookkeeping private to the coordinator and clear it on submission completion, terminal run evidence, stale-run replacement, or disposal
- [ ] 4.2 Preserve existing model-picker labels, context-window behavior, model-unavailable behavior, and conversation presentation without pending, applied, actual-model, fallback, toast, or error additions
- [ ] 4.3 Add regression tests proving accepted, rejected, stale, unavailable, and failed steering requests produce no new user-visible model or conversation state

## 5. Transcript transparency and diagnostics

- [ ] 5.1 Extend raw-message mapping to recognize namespaced synthetic model-steer markers and omit them from visible user turns without splitting the current assistant task group
- [ ] 5.2 Add copy/export regression tests proving model-steer text and metadata are excluded from all user-facing transcript output
- [ ] 5.3 Add safe diagnostics for requested model, run fence, correlation ID, acceptance timestamp, dispatch state, and matching-assistant observation while excluding credentials and provider secrets

## 6. Behavioral and race tests

- [ ] 6.1 Add Server route tests for unavailable models, incompatible behavior, scope enforcement, idle sessions, stale generations, duplicate correlation IDs, and conflicting retries
- [ ] 6.2 Add active-run tests proving an in-flight provider request remains on model A while the next request uses model B without aborting tools or changing run identity
- [ ] 6.3 Add run-completion race tests proving a no-reply steer never starts an unsolicited assistant response and never modifies a replacement run
- [ ] 6.4 Add rapid-switch tests proving A→B→C resolves to C for the next provider request and creates no visible task boundaries
- [ ] 6.5 Add cross-provider, retry, automatic compaction, and tool-call continuation tests, including provider-specific signed metadata conversion
- [ ] 6.6 Add desktop tests for split view, silent transport fallback, terminal coordinator cleanup, variant reset, reasoning-effort translation, and unchanged UI presentation

## 7. Sidecar compatibility and rollout

- [ ] 7.1 Add a real bundled-sidecar compatibility fixture proving busy no-reply modeled-message persistence, per-iteration latest-user model resolution, and single-loop coalescing
- [ ] 7.2 Gate active-run steering behind a local capability flag that remains disabled when compatibility proof or runtime capability detection fails
- [ ] 7.3 Run focused Server/app tests, both TypeScript typechecks, Electron tests covering packaged runtime integration, and `git diff --check`
- [ ] 7.4 Manually verify same-provider and cross-provider switches while streaming text, executing tools, retrying, compacting, and finishing a run; confirm transcript/export invisibility and actual model evidence
- [ ] 7.5 Document the OpenCode sidecar upgrade regression requirement and rollback procedure, then enable the feature for JuggleWork-managed local workspaces
