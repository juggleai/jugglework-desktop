## Context

`add-local-automation-tasks` established the local-execution model this change extends: the embedded server owns scheduling/execution, `AutomationDefinition` is the versioned local record, and a hard connector allowlist plus an unattended permission profile gate what a run can touch. See `docs/event-triggered-automation-prd.md` for full scenarios, ASCII UX layouts, and the P0/P1/P2 breakdown; this document covers only technical decisions not already settled there.

This change assumes the server side (`jugglework-server`, tracked separately as `add-github-event-trigger-relay`) provides: GitHub App event capture and routing, a device-facing poll/detail REST API, an App/repo readiness probe, and JuggleIM headless delivery. Nothing here re-derives that design; it only specifies what the device does with what the server hands it.

## Goals / Non-Goals

**Goals:**
- Add event triggers as a first-class trigger kind without touching the existing schedule calculator, executor, or connector-preflight code paths.
- Make the device the sole place that understands per-automation filter nuance (branch/path/author/mention) and debounce/suppression, so the server stays a thin, stable router.
- Make every discard (self-loop, debounce merge, backlog drop, rate limit) visible in run history rather than silent.

**Non-Goals:**
- Executing event-triggered automations without a local device (cloud/headless execution) — deferred; the editor and run history must communicate the "this device must be online" constraint instead of hiding it.
- GitHub Enterprise Server (on-prem GitHub) support.
- Path-glob filtering in the server's coarse match — path filtering stays entirely device-side per the server design's coarse/fine split.

## Decisions

### 1. Trigger becomes a union, not a new field bolted beside `schedule`

`AutomationDefinition.schedule: AutomationSchedule` becomes `AutomationDefinition.trigger: AutomationSchedule | AutomationEventTrigger`, with `schedule` kept as a deprecated read-compatible alias during migration rather than a parallel optional field. This keeps exactly one code path deciding "is this automation due" per definition, instead of two independently-nullable fields that could both be present or both be absent. Alternative considered: add `eventTrigger?: AutomationEventTrigger` alongside the existing required `schedule` — rejected because it re-introduces the "which one is authoritative" ambiguity the schedule union was designed to avoid, and because scheduled-vs-event is exclusive in every scenario gathered (no automation needs both a clock and an event).

```ts
type AutomationEventTrigger = {
  version: 1;
  kind: "event";
  provider: "github";
  connectorId: string;
  repository: { owner: string; name: string };
  matches: GithubEventMatch[];
  debounceSeconds?: number;       // default 60
  concurrencyKey: "entity" | "repository" | "none"; // default "entity"
  deliveryMode: "auto" | "im" | "poll";
  hourlyTriggerCap?: number;
  permissionTier: "auto" | AutomationPermissionProfile; // "auto" resolves by repo visibility at save time
};
```

### 2. Permission tiering is resolved and frozen at save time, not evaluated per run

Repository visibility is looked up once when the user reaches the permission step and the chosen/forced tier is written into `AutomationPermissionAcknowledgement` at save time, identical to how the existing full-access acknowledgement is frozen. Alternative considered: re-check visibility on every run (a repo could flip public→private after creation) — rejected for V1 because it adds a network round-trip to every run's preflight for a rare edge case; instead, changing a bound repository's visibility invalidates the automation's acknowledgement and forces re-confirmation on next edit, reusing the existing `connector_unavailable`-style invalidation pattern rather than a new per-run check.

### 3. Debounce and self-suppression run on the device, after delivery, before run creation

Both apply in the same pre-claim step that today only checks "is there a non-terminal run for this automation" — extended to check "is there a non-terminal or just-merged run for this `concurrencyKey`" instead of a global per-automation lock. This reuses the existing claim-transaction shape (`apps/server/src/automation`) rather than adding a second concurrency mechanism; the lock granularity changes from `automation_id` to `automation_id + concurrencyKey`.

### 4. Untrusted-content wrapping is a prompt-assembly concern, not a permission-tier concern

The boundary marker around event-sourced text is applied unconditionally, including for full-access private-repo automations — permission tier controls what the run is *allowed to do*, the content boundary controls how the model is told to *interpret what it reads*. Conflating the two (e.g., only wrapping content for the restrictive tier) would leave full-access automations on trusted private repos exposed to injected instructions from any collaborator who can comment, which is a strictly larger attack surface than the tiering decision was meant to close.

### 5. Entity-scoped session reuse supersedes "every trigger creates a new session" for event triggers only

`add-local-automation-tasks` decision #6 ("Every accepted trigger creates a new unattended OpenCode session") was written for scheduled runs, where triggers are independent by construction. Event-triggered runs are not independent when they share an entity: a "PR updated, re-review" trigger is a continuation of the "PR opened, initial review" trigger, not an unrelated event. This change adds a local `automation_entity_sessions` table (`automation_id`, `entity_ref`, `workspace_id`, `session_id`, `status`, `created_at`/`last_used_at`, unique on `(automation_id, entity_ref)`) and changes event-triggered dispatch to look up this table before deciding whether to create a session:

- Hit, session/workspace still resolvable → dispatch the new turn into the existing session.
- Miss, or hit but no longer resolvable → create a new session, and write/overwrite the mapping; a no-longer-resolvable hit records a visible "previous session unavailable, started a new one" note on that run rather than silently switching.

This is safe to build on top of decision #3's per-`concurrencyKey` non-overlap lock without new correlation machinery: because same-entity triggers are already serialized (only one non-terminal run per entity), a session never receives two concurrently dispatched turns, so the existing "subscribe to session events, mark terminal on idle" completion detection needs no change — it now just fires once per turn instead of once per session's entire lifetime.

Two sub-decisions:
- **Retirement**: an entity-closing event (merge/close) for a subscribed automation marks its mapping `closed`; a later reopen starts a fresh mapping rather than resurrecting a closed one. An automation that never subscribed to close/merge events has no precise retirement signal — it relies solely on the staleness fallback below, which is an accepted approximation, not a gap that needs a server-side "always deliver close events" special case in this change.
- **Staleness/graduation**: long-lived entities must not let a session's context grow unbounded. Reuse the existing session context-usage tracking (see the desktop's recent context-meter work) as the graduation trigger rather than inventing a second usage metric; graduating opens a new session seeded with a short carried-forward summary and a link back to the retired one, and updates the mapping to the new session id.

Alternative considered: key session affinity on `entity_ref` alone (repository + PR number), shared across every automation touching that entity — rejected because different automations on the same entity represent different roles/purposes (e.g., a review bot vs. a notify-Slack automation), and forcing them into one shared transcript would produce an incoherent conversation neither automation's prompt design anticipated.

Prompt assembly for a reused-session turn additionally injects an explicit delta (new commits/comments/review-state changes since the entity's last processed event) rather than relying on implicit session memory for GitHub-side activity the agent was never told about in-session — session memory only covers what the agent itself said in prior turns, not what happened on GitHub between turns.

### 6. Provider-neutral naming at the boundaries that are cheap to get right now

A review of this design against "would this generalize to a non-GitHub event source" found the execution-side pipeline (subscription/delivery shape, debounce, session affinity) already provider-agnostic, but several GitHub-specific names had leaked into what should be shared vocabulary. Since nothing has shipped yet, these are renamed now rather than left for a costlier post-launch migration:

- `AutomationEventTrigger`'s advanced filters split into a common shape (`author`, `label`, `mention`, `keyword`) and a GitHub-specific extension (`branch`, `path`) instead of one flat structure — only GitHub's adapter reads the extension.
- Permission tiering resolves through `inputTrustLevel: "open" | "restricted"`, computed by the GitHub adapter from repository visibility; the shared tiering logic never reads "repository visibility" directly.
- `entity_ref` uses a `${provider}:${resourceType}:${id}` namespace (e.g. `github:pull_request:482`) so a future provider's entities cannot collide with GitHub's in the same local table.

None of this implies building a second provider now — see proposal.md and the sibling `jugglework-server` design for the corresponding server-side renames (`provider_delivery_id`, generalized readiness states). It only avoids hardcoding GitHub vocabulary into names that are structurally shared.

### 7. Blocked-draft persistence and resume notification

A draft blocked on "App not installed" or "repository not bound" must survive the delegated wait for an admin to act, and the requester must learn when it clears — otherwise the inline-guidance requirement (§ config capability) is nominally satisfied but practically undermined, since most requesters are not the admin who can self-service the block away. This adds:
- A local draft state, `blocked-on-readiness`, that a draft can be saved into without passing full validation (repository resolution specifically). It carries the same event-trigger fields as a normal draft, just not yet promotable to `enabled`.
- A stored link between a blocked draft and the readiness probe target (organization + repository) it's waiting on, checked opportunistically (e.g. on automation-list load) rather than via a new polling loop, to avoid adding a second background poller alongside the existing event-delivery one.
- A local notification when that readiness flips to `ready`, deep-linking back into the blocked draft's event-configuration step with all fields intact.

Alternative considered: require the draft to stay open in the editor until the repository is bound — rejected outright; it assumes an unrealistic session length for a wait that can span days when the blocker is a different person.

### 8. Write-back happens as the GitHub App identity, authorized per run through the existing run-bound-scope precedent

Reviewing token-lifecycle edge cases surfaced a gap this design had left implicit: self-trigger suppression (decision in the execution capability) compares an incoming event's author against "the automation's GitHub App identity," but nothing previously specified how the device acquires authority to post *as* that identity — the App's installation token is a server-held secret, never handed to a device. Resolved: write-back authority is a new `AutomationConnectorSelection.source: "github-app"` entry, and at the preflight step of every event-triggered run (including every continuation turn into a reused session, not just session creation) the device fetches a fresh, short-lived, run-bound grant from the server — the same shape as the existing `add-local-automation-tasks` decision #7 pattern for unified cloud connector scope, not a new mechanism. A mid-run expiry (single-turn work occasionally outlasting a ~1-hour installation token) gets exactly one silent re-fetch-and-retry before that write-back action is marked failed; acquisition failure maps onto the existing `connector_unavailable`/`connector_reauth_required`/`connector_scope_unavailable` codes.

Alternative considered: write back through the user's own personal GitHub connector (`local-mcp`/`cloud`), same as any other connector-gated action — rejected because it invalidates the self-trigger-suppression design (comparison target would need to be "this connector's GitHub login," and the identity posting would be the individual user's, not a stable bot identity), and because it makes write-back availability depend on an individual's personal repository access rather than the App's org-level grant. Confirmed with the product owner as the intended direction before implementing.

### 9. Two restart/ordering nuances introduced by session reuse and webhook delivery, not present in the original single-session-per-run model

- **Restart reconciliation**: the inherited rule "session idle → run must be done" assumed one run per session. With reuse, a session's idle state after restart is ambiguous between "prior turn finished" and "this turn's dispatch never went out before the crash." Reconciliation must correlate the run's own dispatch record against the session's message history rather than reading idle state alone.
- **Delta-aware prompt ordering**: assembling "what's new since last processed event" (execution capability) must sort by each event's own GitHub-reported timestamp, not device arrival order — GitHub does not guarantee webhook delivery order, and network retries can deliver an earlier event after a later one.

## Risks / Trade-offs

- **Device-must-be-online is a real availability gap for an "event bot" mental model** → Not solved by this change. Mitigated by making the constraint visible everywhere (editor, list, run history) rather than implying always-on behavior; revisit only if usage data shows this is the primary source of dissatisfaction.
- **Per-entity concurrency changes the existing non-overlap invariant's granularity** → Scoped narrowly to event-sourced runs; scheduled-automation locking is untouched, and the claim-transaction change is additive (new key dimension), not a rewrite of the existing lock.
- **Debounce merges reduce transparency into exactly which event caused a run** → Run detail always records the merged-event count and links to the entity (PR/issue), not just the final triggering event, so the audit trail stays reconstructable from the linked GitHub thread even when the exact merge boundary isn't itemized in V1.
- **Session reuse without a precise close signal (automation didn't subscribe to merge/close events) leaves a mapping "active" indefinitely** → Covered by the staleness/graduation fallback, not a correctness gap; worth revisiting only if usage data shows entities frequently outlive the graduation threshold without ever closing.
- **Entity-scoped reuse could be mistaken for a general "share sessions across automations" pattern** → Explicitly keyed on `(automation_id, entity_ref)`, not `entity_ref` alone; a different automation on the same entity always gets its own session.
- **Per-run token re-fetch adds a network round-trip to every event-triggered run's preflight** → Accepted; the existing model/skill/connector revalidation already does this per run, and a short-lived grant is the whole point of the run-bound pattern — caching it across runs would reintroduce the token-handling risk this design avoids.
- **GitHub's secondary rate limits (abuse detection on posting velocity across many entities) are a different failure mode than the primary API quota already covered** → Addressed on the server side (see `add-github-event-trigger-relay`'s organization-level posting-rate gate); this change's per-entity debounce alone does not bound cross-entity posting velocity.
- **A blocked draft with no persisted state is effectively lost if the requester isn't the admin who can self-service the block away** → Addressed directly by decision 7; without it, the inline-guidance requirement is undermined for the common (non-admin requester) case.
- **"Session unresolvable" and "upstream connector/repository revoked" collapsing into one error code makes troubleshooting ambiguous** (the first is a local-state problem, the second is a permissions/authorization problem — different remediation) → Kept as two distinct error codes in the execution capability's requirements.

## Open Questions

- Once `add-local-automation-tasks` archives to `openspec/specs/automation-management` and `automation-session-execution`, a follow-up delta must be filed against those capabilities for the trigger-kind selector and `event` trigger source (see proposal.md's Modified Capabilities note). Filing it now against a non-existent main spec isn't possible; this doesn't change this change's approach or tasks, only when the formal delta lands.
- Whether the debounce window (default 60s) should be surfaced as user-configurable in V1 or fixed like the schedule module's ten-minute catch-up window was in its first release — leaning fixed for consistency, confirm during implementation.
