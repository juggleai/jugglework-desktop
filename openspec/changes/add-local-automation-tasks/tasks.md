## 1. Local contracts and persistence

- [x] 1.1 Define versioned TypeScript contracts for automation definitions with raw/extension preservation and compatibility state, durable prompt parts, schedules, permission acknowledgement, run states, stable envelope/projections, sync mutations, and stable error codes.
- [x] 1.2 Add validation/defaults for trimmed 1–100-character duplicate-allowed names, exactly one local workspace, non-empty durable prompt parts, `Auto` model, system IANA timezone, no connectors/range, full-access acknowledgement, and rejection of ephemeral/credential-shaped data.
- [x] 1.3 Add forward-only `runtime.sqlite` migrations for automation tasks, runs, sync outbox, runtime state, indexes, foreign keys, and scheduled-run uniqueness.
- [x] 1.4 Implement automation repository CRUD, revision checks, tombstones, paginated run queries, transactional run claiming, and outbox acknowledgement.
- [x] 1.5 Add local embedded-server DTOs/routes for task CRUD, pause/resume, duplicate/delete support, manual run, task/run listing, outbox reading, and sync acknowledgement.
- [x] 1.6 Add Chinese API documentation to new public interfaces/methods and `TIPS` comments around claiming, revision, and tombstone invariants required by AGENTS.md.
- [x] 1.7 Add repository and route tests for validation, migration replay, revision conflicts, deduplication, pagination, deletion, and local-first outbox atomicity.

## 2. Schedule calculation and scheduler

- [x] 2.1 Implement the exact versioned schedule union: future one-time local date/time; positive whole-number minute/hour/day interval with anchor; and daily time, multi-weekday weekly, day-of-month monthly, or month/day yearly calendar recurrence with IANA timezone.
- [x] 2.2 Implement deterministic daylight-saving gap/overlap, leap-year, invalid-calendar-date, and timezone-change rules.
- [x] 2.3 Implement the fixed ten-minute latest-only catch-up policy and stable `missed_deadline` history outcome.
- [x] 2.4 Implement one-active-run-per-task overlap handling and stable `overlap_blocked` history outcome.
- [x] 2.5 Implement the embedded-server nearest-deadline scheduler with transactional due claiming, persisted `next_run_at`, one global executor slot, queue wake-up, and graceful disposal.
- [x] 2.6 Add an injectable clock/timer seam and deterministic unit tests for restart, duplicate wake-up, clock jump, sleep recovery, active-range exit, one-time completion, interval anchoring, and simultaneous tasks.
- [x] 2.7 Implement both-dates-or-none inclusive active-range validation, occurrence-existence validation, one-time containment, localized schedule summary, and exact next-run preview.
- [x] 2.8 Implement create/edit future-only recomputation, inactive-mode field stripping, captured-revision isolation, and pause/resume behavior with no catch-up or skipped rows during intentional pause.

## 3. Unattended session execution

- [x] 3.1 Extend workspace session creation to accept agent, concrete model, metadata, and session-scoped permission rules without navigating the renderer.
- [x] 3.2 Implement the automation executor that snapshots a definition revision, creates a uniquely titled session, persists the session id, and dispatches the structured prompt asynchronously.
- [x] 3.3 Implement `unattended-full-access-v1` rules that allow available tools without approval, explicitly deny questions, and add the unattended system instruction while preserving organization/OS policy.
- [x] 3.4 Implement runtime resolution for `Auto` model and strict preflight for explicit model, agent, skills, workspace-relative files, and workspace availability with stable errors.
- [x] 3.5 Filter local MCP tool exposure to the captured selected-connector allowlist and prove unselected MCP servers are unavailable.
- [ ] 3.6 Integrate run-bound cloud connector scope acquisition with the server contract and prohibit fallback to an unrestricted interactive token.
- [x] 3.7 Preserve an audit session for post-session-creation preflight failures while avoiding model dispatch.
- [x] 3.8 Subscribe to OpenCode session idle/error events and implement terminal run updates with concrete selections, timestamps, and sanitized errors.
- [x] 3.9 Reconcile queued/running runs on startup through persisted session status and fail missing sessions with `session_lost` without redispatch.
- [x] 3.10 Add native failure notifications and notification navigation to run details/session, with success notifications controlled by the existing user preference pattern.
- [x] 3.11 Add executor tests for session metadata, permission/question behavior, dependency failures, connector allowlisting, asynchronous completion, duplicate events, restart recovery, and active-run exclusion.
- [x] 3.12 Allow manual run for enabled, paused, and completed definitions while ignoring schedule/range, preserving lifecycle/next run, and still enforcing acknowledgement, non-overlap, and dependency/connector preflight.

## 4. Cloud sync client

- [x] 4.1 Add a stable Electron installation/device identity persisted across ordinary restart and upgrade and expose it to local automation creation/scheduling.
- [x] 4.2 Retain stable-envelope Den/private-cloud client methods for the future remote-workspace phase without invoking them for current local-workspace automations.
- [x] 4.3 Keep current local-workspace definitions and runs local-only: do not enqueue new outbox mutations, clear legacy pending mutations during migration, and do not mount a cloud sync coordinator.
- [x] 4.4 Deterministically serialize complete opaque definition/run documents plus `automation-display/v1` and authoritative document-bound `automation-connector-policy/v1` projections, reject local document/projection connector mismatches, and exclude credentials, tokens, attachment bytes, blob URLs, external absolute paths, transcripts, and tool outputs.
- [x] 4.5 Implement pending/synced/error/incompatible-read-only state, envelope/projection capability negotiation, retry classification, stale-revision conflict preservation, authentication recovery, minimal-list fallback, and server capability detection.
- [x] 4.6 Treat mirrored tasks assigned to another executor device as read-only and exclude them from local scheduling/manual execution.
- [x] 4.7 Remove cloud synchronization state and cross-device mirror presentation from the current local-workspace task and run lists while retaining local completion notifications.
- [ ] 4.8 Add sync tests when remote-workspace automation is implemented: exact-byte unknown-field/schema/projection round trip, supported-schema extension preservation, unsupported-schema read-only/no-execution behavior, offline creation/run, restart persistence, lost responses, idempotent retry, stale revision, tombstone replay, redaction, and connector-policy gating.

## 5. Shared composer and connector selection

- [x] 5.1 Add characterization tests around the existing live session composer before extracting shared editor/toolbar primitives.
- [ ] 5.2 Extract shared prompt editor, model/variant, agent, skill, file-reference, and connector UI primitives without changing interactive session submission or pending-interaction behavior.
- [x] 5.3 Implement an automation composer adapter that has no Run task action and writes a validated versioned durable prompt template into the form.
- [x] 5.4 Add explicit UI rejection/explanation for ephemeral parts and preserve workspace-relative file and stable skill references across reopen/restart.
- [x] 5.5 Implement an automation connector multi-select with removable selected chips, stable ordering, existing connect/authorize flows, readiness-gated save, existing identity/icon/status logic, and stable-id-only persistence.
- [x] 5.6 Add component tests proving session composer parity, absent automation submit action, durable serialization, multi-selection, credential exclusion, and disconnected-connector display.

## 6. Automation UI

- [x] 6.1 Extend `AppNavigationRail` and every rail host with a localized `AlarmClock` Automation item immediately below Cloud workspace, add route-backed `/automations` and `/automations/runs` active states, and preserve task scope, selected workspace/session, and Chat subview on navigation.
- [x] 6.2 Implement the route-backed `定时任务 / 运行记录` segmented tabs with local pagination, search, loading/error states, deep-link/refresh behavior, and responsive layouts matching the supplied references.
- [x] 6.3 Implement create/edit breadcrumbs, Cancel/Save header, ordered form sections, per-visit-dismissible recurring warning, bounded duplicate-allowed name, required local workspace, shared composer, fixed full-access indicator, conditional variant, optional agent/skills, connector multi-select, frequency, timezone, active range, and the specified helper text.
- [x] 6.4 Implement accessible `周期 / 按间隔 / 单次` controls with daily/weekly/monthly/yearly field variants, multi-weekday selection, interval amount/unit/anchor, future one-time date/time, mode-field isolation, timezone, summaries, and next-run preview.
- [x] 6.5 Implement the versioned full-access dialog with explicit risk list, mandatory checkbox, disabled-until-checked confirmation, no default-permission fallback, cancellation back to intact draft, and renewed acknowledgement after profile change or duplication.
- [x] 6.6 Implement manual run, edit, pause/resume, duplicate-as-paused, and delete/tombstone actions with overlap and destructive confirmations.
- [x] 6.7 Implement run-history status/timing/error details and workspace-session navigation when a session id exists.
- [x] 6.8 Display task/run sync health and actionable workspace/model/skill/connector reauthorization failures without exposing internal reasoning.
- [x] 6.9 Add Chinese and English i18n strings for all automation pages, schedules, permissions, statuses, errors, notifications, and accessibility labels.
- [x] 6.10 Add keyboard/focus/ARIA coverage for the rail entry, tabs, empty-state action, template cards, form controls, connector multiselect, menus, confirmation dialog, and history navigation.
- [x] 6.11 Implement atomic save progress/error behavior, post-local-save navigation with pending sync, and dirty-draft discard confirmation for Cancel/navigation.
- [x] 6.12 Implement Current/Ended grouping, deterministic row ordering, all schedule/timezone/range/lifecycle/sync/next-run row fields, and absence of the inactive batch-management control.
- [x] 6.13 Implement newest-first history rows with trigger, schedule/actual timing, duration, status, session/error/sync details, search, and API-ready status/trigger/time filters.
- [x] 6.14 Implement the scheduled-task first-use state with the alarm/check illustration, `开启你的第一个自动化任务吧`, `+ 添加自动化`, hidden search/row actions, and a separate run-history empty state without task templates.
- [x] 6.15 Add a versioned bundled catalog for the twelve specified initial templates with stable ids, localized card copy, icon keys, durable prompt parts, optional supported schedule drafts, recommended-connector metadata, and no credentials/absolute paths/server-owned ids.
- [x] 6.16 Render the inline template catalog below both the first-task state and non-empty task list as a responsive three/two/one-column grid with two-line ellipsis, keyboard activation, and the existing card/focus visual language.
- [x] 6.17 Implement template application as a side-effect-free prefilled create draft: keep workspace empty, keep recommended connectors unselected, leave missing/time-sensitive fields invalid, reuse normal Save/authorization/full-access flows, and never persist template-catalog coupling into required server projections.
- [x] 6.18 Add route/component tests for exact rail ordering and active state, preservation of workspace/session state, empty-to-list transitions, template visibility by tab, all twelve catalog entries, responsive/accessible cards, zero writes on template selection, validation of incomplete one-time drafts, and server-independent catalog evolution.

## 7. Lifecycle and integration

- [x] 7.1 Wire scheduler startup after runtime database/workspace initialization and disposal before embedded-server shutdown; verify no scheduler starts in unsupported/remote-only contexts.
- [x] 7.2 Verify scheduling continues while the Electron window is hidden and stops cleanly on explicit client exit; keep platform-specific warning copy accurate.
- [x] 7.3 Add bounded, redacted logs/metrics for due claim, queue delay, dispatch, completion, misfire, overlap, reconciliation, and sync health without prompt or credential content.
- [x] 7.4 Add end-to-end fake-clock flows covering every calendar/interval/once form variant, active-range validation, atomic create, automatic trigger, background session, edit revision isolation, pause/resume, manual run of paused/completed tasks, delete, and restart recovery.
- [ ] 7.5 Add integration coverage against the `add-automation-sync-api` contract for definition/run mirroring and connector-scope enforcement.

## 8. Verification and rollout

- [x] 8.1 Run focused embedded-server unit/integration tests, renderer component tests, TypeScript checks, lint, and production builds for affected packages.
- [x] 8.2 Run database migration/inspection checks against a fresh runtime DB and an existing populated runtime DB, including idempotent reopen.
- [ ] 8.3 Perform manual QA for rail placement/selection from Session, Settings, Apps, and Chat; first-task and history-empty states; every bundled template; DST/month boundaries; sleep longer/shorter than grace; hidden window; explicit exit; revoked connector; removed model/skill/workspace; offline sync; and stale revision.
- [x] 8.4 Verify no prompt, credential, token, external absolute path, attachment bytes, transcript, or tool output enters logs or cloud payload fixtures.
- [x] 8.5 Ship behind separate local-automation and cloud-connector-scope feature flags, enabling local-only execution before unified cloud connectors.
