## P0 — 1. Trigger data model and validation

- [x] 1.1 Add `AutomationEventTrigger`/`GithubEventMatch` types to `packages/types/src/automation.ts`, change `AutomationDefinition`/`AutomationDraft` to a `trigger: AutomationSchedule | AutomationEventTrigger` union with `schedule` kept as a read-compatible deprecated alias, add `"event"` to `AutomationTriggerSource`, add `"github-app"` to `AutomationConnectorSelection.source`, and add `event_backlog_dropped`/`rate_limited` to `AutomationErrorCode`; verify with a type-check build and unit tests asserting both union branches serialize/deserialize losslessly.
- [x] 1.2 Add validation for the event-trigger branch (at least one event type, valid connector/repository reference, debounce/cap bounds) alongside the existing schedule validation; verify with repository/validation unit tests covering both valid and rejected drafts.
- [x] 1.3 Add Chinese API documentation and `TIPS` comments to the new public types/validation functions per repo convention; verify by review against `AGENTS.md` comment requirements.

## P0 — 2. Editor: trigger-kind selection and event configuration

- [x] 2.1 Add the `定时 / 事件触发` selector to the execution-frequency step and the discard-confirmation flow when switching away from a filled event draft; verify with a component test covering both directions of the switch.
- [x] 2.2 Build the event-trigger configuration panel: connector picker (reusing existing authorization UI), repository picker scoped to already-bound repositories, user-story-labeled event-type matrix, and collapsed advanced filters split into a common group (label/author/mention/keyword) and a GitHub-specific group (branch/path); verify with component tests for each field's save/validation behavior, including that the common group's data shape carries no GitHub-specific field names.
- [x] 2.3 Add the inline "绑定此仓库" and "生成安装请求" guidance states driven by the server readiness probe (`automation-event-trigger-config` capability), preserving all previously filled fields across the inline action; verify with a component test that simulates both blocked states and confirms field values survive.
- [ ] 2.3b **Partially done.** Save is already never blocked by readiness (local validation doesn't check server-side binding at all — see `validateEventEditor`, which is what makes "not blocked" true without a new lifecycle state). Not done: discoverability of a specifically-blocked draft from the automation list, and the resume notification consumed when server readiness flips to `ready` — both depend on the server-side requester-tracking/notification capability (`add-github-event-trigger-relay` §4.5), which had not been built when this task was attempted. Revisit once that capability exists.
- [x] 2.4 Add input-trust-level-based permission tiering: resolve `inputTrustLevel` (`open`/`restricted`) from repository visibility via the GitHub adapter, auto-lock the restrictive tier for `open` with a distinct escalation confirmation, keep the existing two-tier choice for `restricted`; verify with component tests for both trust-level branches and a unit test asserting the shared tiering function never reads repository visibility directly.
- [x] 2.5 Add the delivery-mode control (`自动`/`强制 IM 推送`/`强制轮询`) driven by the readiness probe, narrowing to a disabled polling-only option when no server event capability exists; verify with component tests for both capability states.
- [x] 2.6 Add the pre-enable frequency estimate and optional per-hour cap input in the enable-confirmation dialog; verify with a component test asserting the estimate renders and the cap persists onto the saved definition when set.

## P0 — 3. Device-side delivery consumption and execution

- [ ] 3.1 **Partially done.** `GithubEventDelivery` (the common internal shape) and the pipeline that consumes a batch of them exist and are tested (`event-pipeline.ts`), but the two adapters that would actually *produce* that shape from the poll API and from an IM-push detail fetch are not built — `github-event-client.ts` only has the five UI-facing readiness/repository methods from task group 2, not delivery polling/claiming. Needs the corresponding jugglework-server endpoints to exist first (out of scope for this repo).
- [x] 3.2 Implement self-trigger suppression (drop events authored by the automation's own GitHub App identity, no run, no skipped record) as the first stage after delivery consumption; verify with a unit test asserting zero run/skipped rows for a self-authored event.
- [x] 3.3 Extend run-claiming to a per-`concurrencyKey` non-overlap check (instead of per-automation) and implement the debounce merge window, recording merged-event counts on the run; verify with unit tests for same-key collapsing and different-key concurrency.
- [x] 3.4 Implement the untrusted-content prompt boundary around event-sourced text in prompt assembly, applied unconditionally regardless of permission tier; verify with a unit test asserting the boundary marker wraps event text in an assembled prompt.
- [x] 3.5 Wire event-triggered run creation through the existing unattended executor, setting `triggerSource: "event"` (already true of every run `claimEventRun` produces) and attaching delivery id / entity link to run metadata (`eventMetadata`); reused-session dispatch and reconciliation are 3b's scope, not duplicated here.
- [ ] 3.6 **Partially done.** `recordBacklogDropped` exists and is tested at the pipeline/repository level (produces the `skipped`/`event_backlog_dropped` row with count and time range). Not done: the "on reconnect" trigger that calls it from a real expired-delivery server response — depends on the same missing poll adapter as 3.1.
- [x] 3.7 Implement per-hour rate limiting against the configured cap, recording excess triggers as `rate_limited` in run history; verify with a unit test exceeding a configured cap within a rolling hour window.
- [ ] 3.8 **Partially done.** Debounce merge count, self-loop zero-row, backlog visibility, and rate-limit visibility all have passing tests (`event-pipeline.test.ts`, `repository.test.ts`). Not done: an executor-level integration test, since executor.ts's own event-run dispatch (session creation vs. reuse) is 3b's scope.

## P0 — 3b. Entity-scoped session reuse

- [ ] 3b.1 Add the `automation_entity_sessions` local schema (`automation_id`, `entity_ref`, `workspace_id`, `session_id`, `status`, `created_at`/`last_used_at`, unique on `(automation_id, entity_ref)`); verify with a migration test.
- [ ] 3b.2 Change event-triggered dispatch to look up this mapping before session creation: reuse-and-continue on a resolvable hit, create-and-record on a miss; verify with a unit test asserting two sequential triggers for the same entity share one `sessionId`.
- [ ] 3b.3 Implement the no-longer-resolvable fallback (create new session, update mapping, record a visible "previous session unavailable" note on the run); verify with a unit test simulating a deleted session or unavailable workspace.
- [ ] 3b.4 Implement retirement on entity-closing events (mark mapping `closed`; a later reopen starts a new mapping) and context-usage-threshold graduation (new session seeded with a carried-forward summary and a reference to the retired session), reusing the existing session context-usage tracking rather than a new metric; verify with unit tests for both the merge-close path and the graduation-threshold path.
- [ ] 3b.5 Implement delta-aware prompt assembly for reused-session turns (explicit "what's new since last processed event" summary injected alongside the trigger's own prompt parts); verify with a unit test asserting the assembled prompt for a second trigger includes the delta summary.
- [ ] 3b.6 Verify session affinity is scoped to `(automation_id, entity_ref)` and not shared across different automations configured on the same entity; verify with an integration test covering two automations on one PR.
- [ ] 3b.7 Use the `${provider}:${resourceType}:${id}` namespace convention (e.g. `github:pull_request:482`) for `entity_ref`; verify with a unit test asserting the stored key format.
- [ ] 3b.8 Implement session-affinity invalidation on upstream connector/repository revocation — unbind, uninstall, **or repository transfer** (treated identically) — distinct from the unresolvable-session error code, and block dispatch/recreation until the dependency is restored; verify with unit tests simulating a mid-lifecycle repository unbind and a repository transfer, both asserting the distinct error code plus no session creation.
- [ ] 3b.9 Order delta-aware prompt assembly by each event's GitHub-reported timestamp rather than device arrival order; verify with a unit test delivering two events out of arrival order and asserting the delta summary reflects their actual chronological order.
- [ ] 3b.10 Fix restart reconciliation for reused sessions: correlate the run's own dispatch record against the session's message history instead of treating session-idle as proof of completion; verify with unit tests for both "crashed before dispatch confirmed" (must not be marked succeeded) and "crashed after the turn genuinely finished" (must be marked terminal without redispatch).

## P0 — 3c. Write-back authorization

- [ ] 3c.1 Implement the preflight fetch of a fresh run-bound GitHub App write-back grant for every event-triggered run, including every continuation turn into a reused session (never reusing a prior turn's grant); verify with a unit test asserting two sequential turns in the same session each perform an independent fetch.
- [ ] 3c.2 Implement the single silent re-fetch-and-retry on mid-run grant expiry, marking only that write-back action failed (not the whole run) if the retry also fails; verify with a unit test simulating an expired-grant write-back call.
- [ ] 3c.3 Map grant-acquisition failure onto the existing `connector_unavailable`/`connector_reauth_required`/`connector_scope_unavailable` error codes; verify with unit tests for each failure mode.

## P0 — 4. Run history and list surfaces

- [ ] 4.1 Extend the run-history detail view to render event-sourced runs (triggering PR/issue link, delivery id, and the shared "查看会话" link when a run reused a prior session per §4.8) and the `event_backlog_dropped` / `rate_limited` summary rows described in the PRD; verify with component tests for each new row type.
- [ ] 4.2 Extend the scheduled-task list row to show event-trigger summaries (repository, event types) in place of a schedule summary when `trigger.kind === "event"`; verify with a component test for the event-trigger row rendering.

## P1 — 5. Filtering depth and pre-launch confidence

- [ ] 5.1 Add device-side path-glob filtering as an additional advanced-filter field, evaluated after server coarse-match; verify with a unit test for path-match inclusion/exclusion.
- [ ] 5.2 Add a "模拟测试" flow letting a user pick a historical PR/issue and preview the assembled prompt without executing; verify with a component test asserting no run/session is created during preview.
- [ ] 5.3 Add a `shadow` lifecycle state that runs the full pipeline but skips the final dispatch, recording what would have happened; verify with a unit test asserting shadow runs never create a live session.
- [ ] 5.4 Add manual delivery-mode override persistence and a status indicator showing which channel is actually in effect (not just configured); verify with a component test for the indicator reflecting a forced-vs-resolved mismatch.

## P1 — 6. Account/device lifecycle edge cases

- [ ] 6.1 Detect when the currently logged-in account differs from the account that created an event-trigger automation's subscription, and surface a re-confirmation prompt instead of silently continuing to route on stale identity; verify with a unit test simulating an account mismatch.

## P2 — 7. Extended event coverage

- [ ] 7.1 Add `release` and any additional P2 event types to the event-type matrix once the server capability supports them; verify with a component test for the new matrix entries.
- [ ] 7.2 Add configurable mention-trigger keywords beyond the fixed `@` mention default; verify with a unit test for custom keyword matching.
