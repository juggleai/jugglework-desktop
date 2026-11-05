# Tasks

## 1. Dependency Gates and Domain Boundaries

- [ ] 1.1 Verify the implemented contracts from `add-cloud-calendar-core`, `add-calendar-work-planning`, and `add-team-calendar-collaboration` cover stable event IDs/versions, recurrence, authorization, attendance, and privacy-safe free/busy; record a dependency compatibility matrix and pass its contract checks before enabling any ecosystem flag
- [ ] 1.2 Create separate Conferencing, ResourceBooking, AppointmentScheduling, and ExternalCalendarInterop server/Desktop module boundaries with no shared business state machine; verify architecture dependency tests reject cross-domain repository access
- [ ] 1.3 Add independently scoped server read/write, worker, and Desktop feature flags for all four subdomains, default them off, and verify every single-feature combination leaves core calendar CRUD operational
- [ ] 1.4 Define versioned calendar/event/member reference and domain-event envelopes used between the core calendar and each subdomain; verify schema compatibility and duplicate-event contract tests pass
- [ ] 1.5 Add additive migrations for each subdomain behind its own rollout gate, and verify forward migration plus non-destructive rollback leaves all flags off and core calendar data unchanged

## 2. Calendar Conferencing

- [ ] 2.1 Produce the selected conferencing connector's capability/OAuth/quota/data-handling/failure review and approved capability profile before writing connector production code; verify security, privacy, and reliability reviewers sign the gate artifact and unsupported operations remain disabled
- [ ] 2.2 Implement the provider-neutral conference association, operation, status, protected external reference, and cancellation tombstone persistence; verify migration and repository tests cover tenant isolation, versions, idempotency, and retention
- [ ] 2.3 Implement conferencing authorization and generic event projections without adding provider-specific fields to the core event model; verify API tests cover editor, viewer, manager, revoked-member, and cross-organization access
- [ ] 2.4 Implement explicit create, supported update, and cancel workflows using local state plus outbox delivery; verify state-machine tests cover success, retry, permanent failure, and event changes that require no external mutation
- [ ] 2.5 Implement a narrow connector adapter from the approved capability profile, including least-scope OAuth and quota-aware calls; verify connector contract tests skip or reject every capability not established by the review
- [ ] 2.6 Implement uncertain-result resolution, orphan association repair, cancellation compensation, and periodic conference reconciliation; verify fault-injection tests cover timeout-after-remote-success, duplicate completion, drift, and exhausted compensation
- [ ] 2.7 Add Desktop conference create/attach/status/retry/cancel experiences with permission-aware secret redaction; verify connected UI tests cover disabled connector, pending, active, degraded, and failed states without claiming unavailable connectors work
- [ ] 2.8 Document conferencing rollout, support diagnostics, compensation, and rollback procedures in the subdomain runbook; verify a staging recovery drill can pause its worker and resume persisted operations without affecting the other three flags

## 3. Calendar Resource Booking

- [ ] 3.1 Implement organization-scoped resource directory, policy, facilities, timezone, discovery permission, disable/restore, and audit persistence; verify repository tests cover tenant isolation, hidden resources, and future bookings on disabled resources
- [ ] 3.2 Implement resource administration and permission-filtered directory APIs; verify API tests cover manager changes, ordinary-member denials, hidden-resource non-disclosure, pagination, and policy validation
- [ ] 3.3 Implement privacy-safe availability from opening hours, blackout periods, policy, committed occupancy, and event permissions; verify boundary tests cover timezone transitions, all-day events, recurrence, and busy-block redaction
- [ ] 3.4 Select and document the production-database locking or exclusion strategy for time ranges, then implement transactional single-resource booking; verify real-database concurrent tests prove at most one overlapping active booking commits
- [ ] 3.5 Implement deterministic lock ordering and all-or-nothing multi-resource booking; verify high-concurrency tests cover partial conflicts, deadlock retries, and no leaked occupancy
- [ ] 3.6 Implement versioned, idempotent create/reschedule/cancel and event cancellation propagation; verify tests prove failed rescheduling retains the original slot and retries neither double-book nor double-release
- [ ] 3.7 Add Desktop resource discovery, availability, booking, conflict refresh, administration, and disabled-resource states; verify connected UI tests never expose private event details and preserve user input after a stale-availability conflict
- [ ] 3.8 Add occupancy reconciliation and a resource-booking runbook; verify an injected invalid overlap is quarantined with audit evidence and the resource flag can roll back without disturbing event reads

## 4. Calendar Appointment Scheduling

- [ ] 4.1 Implement appointment type, versioned rules, public slug, host calendar, invitee field policy, buffer, date horizon, and pause/archive persistence; verify repository tests cover organization isolation, slug non-enumerability, and rule validation
- [ ] 4.2 Implement authorized appointment-type management APIs and Desktop management UI; verify tests cover publish prerequisites, pause with existing appointments, archive, permissions, and independent feature-flag behavior
- [ ] 4.3 Implement timezone-explicit slot generation from host free/busy, recurrence, resources, buffers, lead time, horizon, and temporary holds; verify deterministic tests cover DST gaps/folds and prove public output contains no underlying event details
- [ ] 4.4 Implement transactional booking revalidation and idempotent creation of the appointment and host event; verify concurrent tests prove only one visitor can confirm a single-capacity slot and failures leave no orphan event or appointment
- [ ] 4.5 Implement minimal invitee data collection, purpose disclosure, field allowlists, retention, and authorized host views; verify privacy tests reject unreviewed sensitive fields and logs/metrics contain no submitted values
- [ ] 4.6 Implement hashed, high-entropy, purpose-bound, revocable, and rotating confirmation/cancellation/reschedule capabilities; verify security tests cover expiry, replay, old-token rejection, brute-force resistance, and detail non-disclosure
- [ ] 4.7 Implement policy-controlled cancellation and atomic rescheduling, with optional resource/conference side effects delegated to their subdomain workflows; verify tests preserve the original slot on reschedule conflict and compensate post-commit side-effect failures
- [ ] 4.8 Implement layered public endpoint rate limits, payload limits, uniform unavailable responses, anomaly detection, and configurable challenge hooks; verify abuse tests cover slot scraping, invalid-token probing, burst booking, and organization-level isolation
- [ ] 4.9 Add the responsive public booking, confirmation, cancellation, and rescheduling experiences plus host status UI; verify accessibility, localization, mobile/desktop, timezone-switching, stale-slot, paused-type, and rate-limit tests
- [ ] 4.10 Document public-endpoint capacity, privacy, abuse-response, retention, and rollback procedures; verify load and security review gates pass before the appointment flag is enabled outside the initial cohort

## 5. External Calendar Interoperability

- [ ] 5.1 Produce each selected external calendar connector's read/write/delete/webhook/cursor/OAuth/quota/data-handling/error review before production connector code; verify the approved profile exposes only demonstrated capabilities and defaults every mapping to read-only
- [ ] 5.2 Implement connection, calendar mapping, capability snapshot, object mapping, sync baseline, cursor, batch, conflict, tombstone, and outbound-delivery persistence; verify migration/repository tests cover tenant isolation, unique external identity, replay, and retention
- [ ] 5.3 Implement least-scope connection authorization, external calendar discovery, explicit target/direction selection, pause, reauthorization, and disconnect APIs; verify tests cover revoked access, remapped IDs, inaccessible calendars, and no automatic same-name remapping
- [ ] 5.4 Implement bounded paginated initial import with stable identity and recurrence provenance; verify restart and overlapping-page tests create no duplicate events or object mappings
- [ ] 5.5 Implement durable incremental processing that advances a cursor only after idempotent batch commit; verify fault-injection tests replay failed pages safely and cursor-expiry tests perform bounded resynchronization with a visible stale state
- [ ] 5.6 Implement verified, replay-protected webhook hints and deduplicated sync wakeups without treating webhook payloads as authoritative; verify signature, timestamp, connection-scope, duplicate, and out-of-order tests pass
- [ ] 5.7 Implement periodic compensating scans and lag watermarks for every enabled mapping, including connectors without webhooks; verify a dropped-webhook scenario converges and emits stale/healthy transitions within the documented objective
- [ ] 5.8 Implement external-authoritative read-only behavior and provenance UI; verify local edits to authoritative fields are rejected and Desktop clearly distinguishes imported, stale, disconnected, and native events
- [ ] 5.9 Implement controlled write-back only for review-approved fields and operations, with durable idempotent delivery, uncertain-result resolution, quota backoff, and permanent-error classification; verify adapter contract and fault-injection tests cover retries without duplicate remote events
- [ ] 5.10 Implement baseline-based conflict detection, allowed disjoint-field merges, and explicit same-field conflict resolution; verify concurrent two-system tests retain both versions and never use silent last-write-wins
- [ ] 5.11 Implement pause, OAuth-loss, explicit disconnect, credential revocation/removal, and retain-or-delete-copy choices; verify disconnect tests stop worker leases and webhooks while preserving the selected provenance outcome
- [ ] 5.12 Implement directional deletion propagation, tombstones, loop prevention, and permanent delete-conflict handling; verify replay, reimport, local-delete, remote-delete, and unsupported-delete tests do not resurrect or falsely report objects
- [ ] 5.13 Add Desktop connection, mapping, mode, health, lag, conflict, reauthorization, disconnect, and resync experiences without naming unimplemented connectors as available; verify connected UI tests cover read-only and approved write-back profiles separately
- [ ] 5.14 Document connector admission, read-only rollout, controlled-write-back promotion, quota capacity, resync, conflict, disconnect, deletion, and rollback runbooks; verify a staging drill can rebuild one mapping without resetting unrelated cursors

## 6. Shared Security and Privacy

- [ ] 6.1 Implement the shared encrypted credential-reference boundary so business records never contain OAuth tokens or webhook secrets; verify storage inspection, rotation, revocation, and cross-tenant access tests pass
- [ ] 6.2 Implement centralized redaction for tokens, conference secrets, public capabilities, invitee fields, and raw external payloads across logs, traces, errors, analytics, and support exports; verify seeded canary-secret tests find no plaintext leakage
- [ ] 6.3 Enforce server-side organization, member, calendar, event, resource, appointment, and mapping authorization on every new read and mutation; verify a cross-product authorization matrix includes revoked membership and direct-object-ID attempts
- [ ] 6.4 Define and enforce data retention and erasure for external payloads, invitee data, operation records, audit entries, and tombstones; verify retention jobs preserve required deduplication evidence while deleting expired sensitive content
- [ ] 6.5 Complete threat modeling and privacy review for OAuth, webhook forgery/replay, public enumeration, SSRF/redirect handling, deletion propagation, and compensation controls; verify all release-blocking findings are closed or explicitly prevent the affected flag from enabling
- [ ] 6.6 Add dependency and connector supply-chain review requirements for every adapter package or SDK; verify license, provenance, update policy, and vulnerability checks are captured before a connector build is promoted

## 7. Shared Reliability, Observability, and Operations

- [ ] 7.1 Implement reusable outbox/inbox, idempotency, lease, retry-budget, backoff, and delivery-record infrastructure without shared subdomain business states; verify crash/restart, duplicate delivery, expired lease, poison item, and clock-skew tests
- [ ] 7.2 Add structured correlation IDs and content-free metrics for queue age, sync lag, retries, unknown results, permanent failures, compensation, conflicts, quota waits, authorization denials, webhook rejection, booking collisions, and public throttling; verify dashboards separate subdomain and connector mode
- [ ] 7.3 Add immutable administrative audit events for connector enablement, mapping authority, resource policy, appointment publication, high-impact lifecycle commands, disconnect, resync, and manual compensation; verify audit access and retention tests exclude secrets and private event content
- [ ] 7.4 Implement subdomain-specific pause, drain, retry, reconcile, resync, and diagnostic controls with scoped authorization; verify each control affects only its intended organization/subdomain/mapping and cannot trigger a global replay
- [ ] 7.5 Define SLOs and alerts for local booking availability, public booking latency/error rate, conferencing compensation age, and external sync lag; verify synthetic failures page the correct runbook and do not mark unaffected subdomains unhealthy
- [ ] 7.6 Run combined feature-flag and failure-isolation tests with each subdomain alone and supported optional compositions; verify disabling or degrading one subdomain leaves the other subdomains and core calendar usable
- [ ] 7.7 Run end-to-end security, privacy, concurrency, quota, webhook-loss, compensation, disconnect, deletion, migration, Desktop, accessibility, localization, and recovery suites; verify all per-subdomain release gates pass before changing any default-off flag
- [ ] 7.8 Validate this change with `openspec validate add-calendar-meeting-ecosystem --type change --strict --no-interactive` and run repository formatting checks; verify both commands pass and archive only after implementation evidence is attached

## Workflow follow-up

- Archive `add-calendar-meeting-ecosystem` only after all tracked tasks and project review requirements are complete.
- Verify the archived specs and implementation evidence remain linked after archive.
