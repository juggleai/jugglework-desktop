# Tasks

## 1. Core Dependency and Delivery Gates

- [ ] 1.1 Verify `add-cloud-calendar-core` migrations, authorization, range/search APIs, version and idempotency writes, change cursors, and Desktop cache contracts are implemented and passing; record the exact focused test commands and keep every work-planning feature flag off if any gate fails
- [ ] 1.2 Define separate server and Desktop flags for recurrence writes, week/day read UI, interactive planning writes, reminder generation/display, each overlay adapter, Agent reads, and Agent writes; verify tests show each flag can be disabled without hiding or corrupting core one-off events
- [ ] 1.3 Add privacy-safe metrics and structured diagnostics for expansion budget rejection, write conflicts, reminder generation/cancellation/deduplication, overlay adapter failure, and Agent preview outcomes; verify telemetry tests contain IDs/statuses but no event title, description, or reminder content

## 2. Recurrence Storage and Expansion

- [ ] 2.1 Add additive series-rule and occurrence-exception persistence with stable original occurrence keys, versions, soft-delete fields, indexes, and uniqueness constraints; verify migration up/down safety and repository round-trip tests against existing one-off events
- [ ] 2.2 Implement validation for daily, weekly, and monthly rules, positive intervals, unique weekdays/month days, inclusive-until and occurrence-count endings, and the two allowed mutation scopes; verify table-driven tests reject arbitrary RRULE, yearly, and `this and following` inputs without writes
- [ ] 2.3 Implement the bounded deterministic range expander with generated/modified/canceled identities, moved-in/moved-out exception filtering, half-open timed intervals, and all-day exclusive-end dates; verify property and fixture tests cover stable identities, pagination limits, month gaps, cross-day intersections, and repeated queries
- [ ] 2.4 Implement IANA wall-clock resolution and original-key generation across DST gaps/folds while preserving elapsed timed duration; verify fixed-tzdata tests cover nonexistent times, ambiguous times, viewer timezone conversion, and monthly dates that do not exist
- [ ] 2.5 Implement versioned, idempotent create/update/delete commands for single exceptions and whole series, including orphan-exception impact analysis and transactional cleanup after confirmation; verify authorization, stale-version, retry, single-instance identity, whole-series delete, and exception-orphan tests
- [ ] 2.6 Extend range, detail, search, and change-cursor APIs for series and exceptions with hard bounds and non-disclosing authorization; verify API tests cover moved occurrences, inaccessible series, limit rejection, soft deletion, and cursor-driven cache invalidation

## 3. Reminder Scheduling and Lifecycle

- [ ] 3.1 Add reminder definition, scheduled work, generated business event, recipient delivery, and installation/channel deduplication persistence with explicit state boundaries; verify migrations and state-transition tests prevent regressions from fetched/display-requested/read and preserve canceled generated audit records
- [ ] 3.2 Implement horizon-based reminder materialization for one-off and recurring events using stable recipient/definition/original-key identities; verify scheduler tests cover all-day semantics, authorization filtering, recurrence horizon advance, concurrent claims, restart, and exactly-once business-event generation
- [ ] 3.3 Connect event, rule, exception, timezone, offset, deletion, and access changes to transactional reminder cancellation and recomputation; verify race tests cover edits before due, edits during claim, moved/canceled instances, entire-series changes, offset removal, and recipient permission loss
- [ ] 3.4 Implement recipient fetch, explicit read, cancellation, and per-installation display-request acknowledgment APIs; verify multi-client tests prove fetch does not imply display/read, two devices share one business event, reconnect does not repeat one installation's display request, and explicit read synchronizes
- [ ] 3.5 Integrate active Desktop runtimes with in-app reminders and platform-permitted system notification requests; verify mocked platform tests cover hidden windows, denied OS permission, deep links, installation deduplication, and startup fetch without claiming a popup occurred at the original due instant
- [ ] 3.6 Document and test the runtime boundary that explicit application exit stops local display requests while cloud reminders remain fetchable; verify an exit/restart integration test and support diagnostics do not promise a desktop popup while no Desktop runtime is active

## 4. Week and Day Planning UI

- [x] 4.0 按 Calendar 产品布局增加日/周/月切换，并移除月视图右侧常驻“选中日/今日日程”栏；新建入口放入主工具栏，详情/编辑按需以浮层打开且关闭后恢复焦点，同时保留左侧迷你月历和 Calendar 筛选；以月/周/日组件测试及窄窗口无障碍测试验证主视图获得完整剩余宽度
- [ ] 4.1 Add route-backed week/day selection, visible-range navigation, shared calendar filters, display-timezone handling, and loading/empty/error states independent of Agent availability; verify Desktop component tests and deep-link refresh tests for both views
- [ ] 4.2 Build the normalized display-item model for one-off events, expanded instances, cross-day timed segments, all-day spans, permissions, versions, and source kinds; verify unit tests preserve one business identity across segments and never convert timed cross-day events into all-day events
- [ ] 4.3 Implement deterministic all-day row allocation, accessible overflow, and timed overlap grouping/lane geometry using half-open intervals; verify layout fixtures cover equal boundaries, nested overlaps, stable rerenders, dense all-day spans, and responsive desktop widths
- [ ] 4.4 Implement the accessible current-time indicator with minute-boundary updates and date/timezone/resume recalculation; verify fake-clock tests cover today visible, historical ranges, midnight rollover, DST transitions, and a non-color-only accessible label
- [ ] 4.5 Implement drag previews for timed move/resize and whole-date all-day moves through one structured mutation-intent pipeline; verify interaction tests cover valid drops, positive duration, cancel/outside drop, permission denial, pending state, stale-version rollback, and idempotent network retry
- [ ] 4.6 Add discoverable keyboard move and duration controls that generate the same mutation intent, expose proposed date/time/timezone, support cancel, and restore event focus; verify keyboard-only and accessibility tests produce the same writes and validation as drag operations
- [ ] 4.7 Add recurring-instance scope selection to interactive edits and deletes with only `this occurrence` and `entire series`, plus whole-series impact preview where required; verify UI/API integration tests reject unsupported scope and do not mutate before required confirmation

## 5. Read-only Source Overlays

- [ ] 5.1 Define the common read-only overlay contract and isolated cache keys for source kind, stable source ID, tenant/member scope, range, effective interval, all-day state, forecast labeling, and source cursor; verify contract tests reject mutable CalendarEvent fields and cross-organization cache reuse
- [ ] 5.2 Implement the Task adapter for permission-filtered due instants and date-only deadlines without calendar writes; verify adapter tests cover timed, all-day, no-due, completed/deleted policy, revoked access, bounded ranges, and title non-disclosure
- [ ] 5.3 Implement the Automation adapter using only the Automation domain's authoritative `next_run_at`; verify adapter tests cover enabled forecasts, paused/ended absence, changed forecasts replacing stale entries, and no independent schedule calculation
- [ ] 5.4 Add independent overlay controls, non-color-only source labels, mixed-source layout/search, and source-specific partial failure states; verify Desktop tests show disabling or failing one source does not mutate records or block CalendarEvent and other-source rendering
- [ ] 5.5 Implement task and automation detail/edit handoff using stable source identity and calendar return location, with source-domain reauthorization and current-data reload; verify navigation tests cover stale versions, deleted/inaccessible sources, browser history, and absence of calendar move/resize/delete/reminder actions

## 6. Page-independent Agent Operations

- [ ] 6.1 Register typed calendar query and mutation affordances in the authenticated runtime service rather than React components; verify runtime tests invoke them before Calendar ever mounts, after route changes, and with a hidden window, and return explicit unavailable results when service/member context is not ready
- [ ] 6.2 Implement bounded Agent range/detail/search queries through the shared server authorization path, including optional authorized overlay sources; verify tests cover inaccessible/nonexistent indistinguishability, required bounds, result limits, organization changes, and stable IDs/versions
- [ ] 6.3 Implement structured Agent create/update/move/resize/recurrence/reminder/delete writes through the same member authorization, expected-version, and idempotency command boundary as Desktop; verify parity tests compare direct-client and Agent results and cover stale versions, retries, unsupported recurrence, and authorization revoked before execution
- [ ] 6.4 Implement candidate-based clarification for ambiguous target, calendar, date, timezone, recurrence scope, and intended value; verify tests produce bounded authorized candidates, perform no write before resolution, reload selected candidate versions, and never create an event as fallback for no match
- [ ] 6.5 Implement server-backed high-impact previews and single-use confirmations bound to member, tenant, normalized payload, target versions, impact horizon/count, exception consequences, expiry, and idempotency key; verify tamper, replay, stale-version, permission-change, entire-series deletion, orphan-exception, and bounded bulk tests
- [ ] 6.6 Implement truthful result/audit states for previewed, committed, conflicted, denied, and unavailable outcomes using member identity plus Agent-origin metadata; verify audit and response tests never report previews or failed writes as saved and never treat the model as an independent principal

## 7. Integrated Verification and Gradual Rollout

- [ ] 7.1 Run cross-service end-to-end scenarios for recurring events in week/day views, drag and keyboard edits, single-instance and whole-series scope, reminder recomputation, source handoff, and page-independent Agent operations; record commands and verify no team, invitation, attendee, meeting, room, booking, or external-calendar behavior is exposed
- [ ] 7.2 Run affected Server migration/unit/API/concurrency suites and Desktop typecheck/unit/component/accessibility/Electron smoke suites, plus strict OpenSpec validation; record passing commands and resolve every failure before enabling any production flag
- [ ] 7.3 Perform security and privacy review of range expansion bounds, recurrence exception authorization, reminder content/delivery, overlay cache tenant isolation, deep links, Agent candidate disclosure, confirmation binding, audit logs, and telemetry; verify the review has no unresolved release-blocking finding
- [ ] 7.4 Execute shadow expansion/reminder calculation and compare canonical one-off results without sending notifications; verify dashboards meet documented correctness, latency, duplicate, cancellation-lag, and backlog thresholds before write/display flags advance
- [ ] 7.5 Roll out sequentially to internal cohorts: week/day read UI, recurrence writes, interactive writes, reminder generation, in-app/OS display, each source adapter, Agent reads, then Agent writes; verify each stage has an owner, observation window, success thresholds, and independent kill-switch exercise
- [ ] 7.6 Exercise rollback by disabling flags in reverse order while retaining additive data and reminder audit records; verify core one-off calendar read/write remains healthy, no generated reminder identity is regenerated, and re-enablement resumes from authoritative versions/cursors

## Workflow follow-up

- Archive the change only after implementation, review, rollout evidence, and all tracked tasks are complete.
- Verify the archived specs preserve the four capability contracts and the dependency on `add-cloud-calendar-core`.
