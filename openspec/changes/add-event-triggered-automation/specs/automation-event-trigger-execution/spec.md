## Purpose

Turns a GitHub event delivered to the device into a locally executed automation run, applying self-trigger suppression, per-entity debounce, untrusted-content handling, backlog visibility, and rate limiting before handing off to the existing unattended session executor.

## ADDED Requirements

### Requirement: Delivery consumption
The device SHALL consume pending event deliveries through whichever channel the automation's delivery mode resolves to — an IM push notification followed by a detail fetch, or a polling request — and SHALL treat both paths as producing the same internal delivery record shape before any downstream processing.

#### Scenario: IM-delivered event
- **WHEN** the device receives an IM push referencing a pending delivery id
- **THEN** it fetches the full event detail by that id and processes it through the same pipeline as a polled delivery

#### Scenario: Polling fallback
- **WHEN** the automation's delivery mode is forced or resolved to polling
- **THEN** the device periodically requests pending deliveries for its own device id and processes any returned records through the same pipeline

### Requirement: Run-bound GitHub App write-back authorization
At the preflight step of every event-triggered run — including every continuation turn dispatched into a reused session, not only at session creation — the device SHALL fetch a fresh, short-lived, run-bound write-back authorization from the server for the automation's `github-app` connector entry, and SHALL NOT reuse a grant obtained for a prior run or turn. A write-back call that fails due to the grant expiring mid-run SHALL trigger exactly one silent re-fetch and retry before that write-back action is marked failed. A failure to obtain the grant at all SHALL be reported using one of the existing `connector_unavailable`, `connector_reauth_required`, or `connector_scope_unavailable` error codes.

#### Scenario: Continuation turn fetches its own grant
- **WHEN** a second triggered turn dispatches into a session reused from a prior trigger
- **THEN** the device fetches a new run-bound authorization for this turn rather than reusing the grant obtained for the prior turn

#### Scenario: Grant expires mid-run
- **WHEN** a write-back call fails because the run-bound grant expired during a long-running turn
- **THEN** the device re-fetches the grant exactly once and retries the write-back call before marking it failed

#### Scenario: Grant acquisition fails outright
- **WHEN** the server cannot issue a run-bound grant (revoked installation, upstream failure)
- **THEN** the run records one of the existing connector-related error codes rather than an undefined failure state

### Requirement: Self-trigger suppression
The device SHALL discard any delivered event whose author identity matches the GitHub App identity used by the triggering automation's connector, without creating a run or a skipped-run record, before any other filtering.

#### Scenario: Automation's own comment re-triggers the subscription
- **WHEN** a delivered event's author is the same GitHub App identity the automation posts as
- **THEN** the device discards the event with no run and no skipped-run entry

### Requirement: Per-entity debounce
The device SHALL apply a debounce window (default 60 seconds, configurable) keyed by the event-trigger's `concurrencyKey` (default: the PR or issue number). Multiple qualifying events for the same key within the window SHALL collapse into a single run, and the run record SHALL note how many events were merged. Events for different keys SHALL be allowed to run concurrently.

#### Scenario: Rapid consecutive pushes to the same PR
- **WHEN** five `synchronize` events for the same PR arrive within the debounce window
- **THEN** exactly one run is created for that PR and its detail records that four events were merged

#### Scenario: Concurrent events on different PRs
- **WHEN** qualifying events for two different PR numbers arrive at the same time
- **THEN** both are allowed to produce runs without either being blocked by the other's non-terminal state

### Requirement: Untrusted event content boundary
When assembling the prompt for an event-triggered run, the device SHALL wrap event-sourced text (titles, descriptions, comment bodies) with an explicit boundary marking it as untrusted external data, distinct from instruction text, in every case regardless of permission tier.

#### Scenario: Comment body reaches the model
- **WHEN** a triggering comment's body is included in the assembled prompt
- **THEN** it is enclosed by a boundary that states it is external data and not an instruction

### Requirement: Offline backlog visibility
When a device reconnects and the server reports that pending deliveries for one of its automations expired past the bounded backlog window, the device SHALL create a `skipped` run history entry with error code `event_backlog_dropped`, the count of dropped events, and the covered time range, rather than discarding them without a trace.

#### Scenario: Device offline for a week
- **WHEN** a device reconnects and the server reports 12 expired deliveries for an automation
- **THEN** run history shows one `event_backlog_dropped` entry stating 12 events were dropped and the time range they cover

### Requirement: Per-hour rate limiting
When an automation has a configured per-hour trigger cap, the device SHALL count qualifying (post-debounce, post-suppression) triggers per rolling hour and SHALL discard triggers beyond the cap, recording each discarded trigger in run history with error code `rate_limited` rather than silently dropping it.

#### Scenario: Cap exceeded within an hour
- **WHEN** an automation with a 10-per-hour cap has already produced 10 runs in the current rolling hour and an 11th qualifying event arrives
- **THEN** the 11th event is recorded in run history as `rate_limited` and does not produce a run

### Requirement: Entity-scoped session reuse
For an event-triggered automation, the device SHALL maintain a session-affinity mapping keyed by `(automation_id, entity_ref)`. When a qualifying trigger's mapping resolves to an existing, still-resolvable session, the device SHALL dispatch that trigger's turn into the existing session instead of creating a new one. When no mapping exists, or the mapped session is no longer resolvable, the device SHALL create a new session, record it in the mapping, and — only in the no-longer-resolvable case — record a visible note on that run stating the previous session was unavailable and a new one was started.

#### Scenario: Re-review continues the original session
- **WHEN** a second qualifying trigger arrives for a PR whose first trigger's session is still resolvable
- **THEN** the new run dispatches into that same session rather than creating a new one, and the run's `sessionId` matches the prior run's `sessionId`

#### Scenario: Mapped session no longer resolvable
- **WHEN** a qualifying trigger's mapped session cannot be resolved (deleted session or unavailable workspace)
- **THEN** the device creates a new session, updates the mapping, and the run's history entry explicitly states the previous session was unavailable

#### Scenario: Different automations on the same entity do not share a session
- **WHEN** two different automations are each configured with an event trigger on the same repository and entity
- **THEN** each maintains its own independent session-affinity mapping and neither automation's turns are dispatched into the other's session

### Requirement: Session-affinity invalidation on upstream revocation
When a session-affinity mapping's underlying connector authorization or repository binding is revoked — the organization unbinds the repository, the App/connector is disconnected, or the repository is transferred to a different organization/account — the device SHALL mark that mapping invalid using a distinct error code from an unresolvable-session failure, and SHALL NOT attempt to dispatch into or silently recreate a session for it until the connector/repository dependency is restored. Repository transfer is treated identically to an explicit unbind/uninstall even though no admin action inside this product triggered it. This is deliberately a different signal from "mapped session no longer resolvable" (local-state problem) because the remediation differs — one requires the user to fix local session/workspace state, the other requires restoring upstream access the device does not control.

#### Scenario: Repository unbound mid-review
- **WHEN** an event arrives for an entity whose session-affinity mapping depends on a connector/repository binding that has since been revoked
- **THEN** the device records the run with a distinct upstream-unavailable error code, does not create a new session, and does not conflate it with a local session-resolution failure

#### Scenario: Repository transferred mid-review
- **WHEN** the repository underlying an active session-affinity mapping is transferred to a different organization or account
- **THEN** the device treats it the same as an explicit unbind, marking the mapping invalid with the same distinct error code

### Requirement: Session-affinity retirement and graduation
The device SHALL mark an entity's session-affinity mapping `closed` when it processes an entity-closing event (merge/close) for that automation, and SHALL start a new mapping rather than reusing a closed one if the entity is later reopened. Independent of the closing event, the device SHALL graduate a mapping to a new session when the underlying session's tracked context usage exceeds a defined threshold, seeding the new session with a brief carried-forward summary and a reference to the retired session.

#### Scenario: PR merged
- **WHEN** the device processes a merge event for an entity with an active session-affinity mapping
- **THEN** the mapping is marked closed and a later reopen of that same entity starts a new mapping and a new session

#### Scenario: Long-lived PR exceeds context threshold
- **WHEN** a session's tracked context usage crosses the graduation threshold while its entity is still open
- **THEN** the device starts a new session seeded with a short summary and a reference to the retired session, and updates the mapping to the new session id

### Requirement: Delta-aware prompt assembly for reused sessions
When dispatching a turn into a reused session, the device SHALL include an explicit summary of what changed since the entity's last processed event (new commits, new comments, review-state changes) in the assembled prompt, rather than relying only on the session's own prior-turn memory for GitHub-side activity the agent was not previously told about. "Last processed event" and the ordering of what counts as new SHALL be determined by each event's own GitHub-reported timestamp, not by the order in which the device received them, since GitHub does not guarantee webhook delivery order.

#### Scenario: Re-review turn states what's new
- **WHEN** a re-review trigger dispatches into a reused session
- **THEN** the assembled prompt includes an explicit statement of what is new since the last processed event for that entity, in addition to whatever the session already remembers from its own prior turns

#### Scenario: Out-of-order delivery
- **WHEN** two events for the same entity are delivered out of the order they actually occurred in
- **THEN** the delta summary reflects their actual GitHub-reported chronological order, not their arrival order

### Requirement: Restart reconciliation for reused sessions
On restart, reconciling a nonterminal event-triggered run whose session was reused from a prior trigger SHALL NOT treat the session's idle state alone as proof the run completed. The device SHALL correlate the run's own dispatch record against the session's message history to distinguish "the prior turn finished normally, leaving the session idle" from "this run's prompt was never actually dispatched before the crash," and SHALL redispatch or mark the run failed accordingly rather than assuming completion from idle state alone.

#### Scenario: Crash before dispatch completes
- **WHEN** the device restarts after crashing between claiming a run for a reused session and confirming the prompt was dispatched
- **THEN** reconciliation does not mark the run succeeded merely because the session is idle; it determines whether this run's turn was actually sent and redispatches or fails it accordingly

#### Scenario: Crash after a turn genuinely completed
- **WHEN** the device restarts and the session is idle because the reconciled run's turn genuinely finished before the crash
- **THEN** reconciliation correctly marks that run terminal without redispatching

### Requirement: Run source and executor reuse
An event-triggered run SHALL use the existing local session-creation and unattended-execution path unchanged, with `AutomationTriggerSource` set to `"event"` and run metadata carrying the source delivery id and a link to the triggering PR/issue.

#### Scenario: Event-triggered run appears in history
- **WHEN** an event-triggered run completes
- **THEN** its run history entry is presented like a scheduled run's entry, plus a link to the triggering GitHub PR or issue
