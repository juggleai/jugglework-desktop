## Context

JuggleWork Desktop is an Electron application with a React renderer, an embedded JuggleWork HTTP server, managed OpenCode runtimes, and a local `runtime.sqlite` database. Interactive sessions are currently created from the active workspace UI and permissions/questions are resolved through renderer-owned interaction state. That path is unsuitable for unattended work because it changes the visible session, depends on a mounted page, and can wait forever for user input.

The embedded server already outlives renderer route changes, owns workspace-to-OpenCode routing, and stops with the client runtime. Electron disables background throttling, and macOS window close hides rather than exits, so the embedded server is the narrowest reliable location for an in-process scheduler. The cloud has no role in deciding when a task is due; the separate `jugglework-server` change `add-automation-sync-api` defines only a passive mirror and connector-scope endpoint.

The existing session composer contains reusable editing behavior but is tightly coupled to live-session submission, attachments, mentions, commands, and pending interaction state. Existing connector inventory also combines local MCP, directory, and organization connections, while organization/cloud capabilities ultimately execute through the unified JuggleWork Connect tools.

## Goals / Non-Goals

**Goals:**

- Let a user create, inspect, edit, pause, manually run, and delete a locally executed automation from a global UI.
- Make that UI discoverable through an alarm-clock entry immediately below Cloud workspace and provide useful built-in starting templates on the scheduled-task landing page.
- Calculate recurring, interval, and one-time schedules deterministically across restart, sleep, timezone, and daylight-saving transitions.
- Create a distinct workspace session and durable run record for each accepted trigger, then execute it without permission or question prompts.
- Reuse session composer behavior and existing workspace/model/agent/skill/connector inventories without duplicating their business rules.
- Keep task execution independent of cloud availability while eventually synchronizing definitions and run history.
- Treat selected connectors as a hard allowlist and never persist connector credentials with an automation.

**Non-Goals:**

- Executing schedules in the cloud, waking a powered-off device, or guaranteeing execution after the client exits.
- Scheduling against remote workspaces in the first release; remote execution would violate the local-execution promise.
- Supporting arbitrary cron expressions, event/webhook triggers, task chaining, batch management, or server-managed/downloaded template catalogs in the first release.
- Scheduling ephemeral clipboard images, blob-backed attachments, running-application references, interactive questions, or permission approvals.
- Providing OS-level workspace containment. “Full access” removes OpenCode confirmation within the effective operating-system and organization policy; it does not bypass OS permissions.

## Decisions

### 1. The embedded local server owns scheduling and execution

Add an automation module to `apps/server` containing repository, schedule calculator, scheduler, executor, OpenCode event reconciler, and local HTTP routes. React calls these routes and never owns timers. The scheduler starts after runtime database/workspace initialization and stops during server disposal.

Use one nearest-deadline wall-clock timer instead of one timer per task. Every wake-up opens a database transaction, selects due enabled tasks, inserts deduplicated run rows, advances each task's `next_run_at`, commits, and then submits claimed runs to a bounded executor. The first release uses a global concurrency of one, with a configuration seam for later tuning. This matches the UI warning that high-load periods may queue work and prevents multiple local models from unexpectedly exhausting the device.

A renderer timer was rejected because hidden/throttled/destroyed renderer state is not a durable scheduler. Electron main-process timers were rejected because they would duplicate workspace/OpenCode routing already owned by the embedded server.

### 2. Store authoritative definitions and runs in runtime SQLite

Add forward-only runtime schema for:

- `automation_tasks`: identity, display name, required workspace id and display snapshot, structured prompt template, agent/model/variant selection, selected connector ids, permission-profile version, schedule JSON, IANA timezone, active range, enabled state, next due instant, revision, full-access acknowledgement metadata, executor device id, sync state, timestamps, and the schema/version plus raw extension-preserving definition document needed for lossless cloud round trip and downgrade safety.
- `automation_runs`: identity, automation id, scheduled instant, trigger source, state, workspace/session ids, definition revision, attempt timestamps, sanitized error, and sync state.
- `automation_sync_outbox`: ordered definition/run mutations with idempotency key, payload version, retry time, attempt count, and last sanitized error.
- `automation_runtime_state`: schema/calculator version and scheduler checkpoints needed for safe recovery.

Use client-generated UUIDs everywhere. Enforce a unique key on `(automation_id, scheduled_for, trigger_source)` for scheduled/catch-up runs; manual runs use a unique run id and are not deduplicated by time. Local rows are committed before any cloud request. Cloud errors update only sync state/outbox and never roll back local execution.

Keeping definitions only in renderer storage was rejected because it is not transactional with run claiming and restart recovery. Making the cloud authoritative was rejected because an offline cloud must not suppress a local due time.

### 3. Use an explicit versioned schedule model

The stored schedule union is versioned and uses UTC instants at its boundary:

- `once`: one required local date and local time converted to a `runAt` instant. The editor requires a strictly future instant when a new definition is saved.
- `interval`: a positive integer `every`, unit (`minute`, `hour`, or `day`), and required local `anchorAt`. The UI labels the anchor as the first/alignment time. It may be in the past so users can preserve wall-clock alignment; the next occurrence is the first anchor-derived instant at or after save time, and save/edit never backfills earlier intervals.
- `calendar`: frequency (`daily`, `weekly`, `monthly`, or `yearly`), required local time, and frequency-specific fields. Daily has no additional field; weekly requires one or more unique ISO weekdays; monthly requires day-of-month 1–31; yearly requires month 1–12 and day-of-month 1–31. Leap-day yearly schedules run only in leap years.

All modes store an explicit IANA timezone, defaulting to the current system timezone at creation rather than following future system-timezone changes silently. An optional active range is either absent or contains both inclusive start and end local dates; partial ranges are rejected, the end must not precede the start, and the schedule must have at least one possible occurrence inside it. Blank means always active. A one-time instant must fall inside the configured range.

The editor maps the reference tabs directly to the union: `周期` → `calendar`, `按间隔` → `interval`, and `单次` → `once`. Switching modes preserves only the last unsaved values for that mode in form state; the saved payload contains exactly one union member and no stale fields from another mode. Every mode shows a localized schedule summary and next-run preview before save.

The calculator persists `next_run_at` but always recomputes it from the schedule and the last accepted scheduled instant, not by repeatedly adding to a stale timer. Creating or editing a definition computes the first occurrence at or after the successful local save time and does not invoke restart catch-up semantics. Editing schedule/timezone/active range creates a new definition revision and atomically replaces `next_run_at`; any already queued/running run retains its captured prior revision.

For a nonexistent daylight-saving local time, choose the earliest valid local instant after the gap on that date. For an ambiguous time, choose the earlier occurrence. Invalid dates such as day 31 in a month without day 31 are skipped, not clamped. A pure calculator with an injected clock and timezone fixtures makes these rules unit-testable.

### 4. Use a fixed misfire and overlap policy for the first release

On scheduler startup/resume, calculate all missed instants but accept at most the latest one. If it is no more than ten minutes late and the active range still permits it, create one `catchup` run; otherwise create a `skipped` history row with `missed_deadline` and advance to the next future instant. Never flood the queue with historical runs.

Only one nonterminal run may exist per automation. If another due instant arrives while its prior run is queued or running, create a `skipped` row with `overlap_blocked` and advance the schedule. The manual-run control is disabled while a run is nonterminal and the API returns conflict if called concurrently.

The ten-minute grace period is deliberately fixed in V1 rather than adding another setting. It can become configurable without changing run-state semantics.

### 5. Extract a shared prompt composer shell with an automation adapter

Refactor the current `ReactSessionComposer` into reusable editor/toolbar primitives and two adapters:

- The session adapter retains current submit, command, attachment, running-app, pending-question, and permission behavior.
- The automation adapter hides the run/submit action, writes changes into the automation form, and exposes only durable features.

The durable prompt template supports text, workspace-relative file references, and skill references. Model, variant, agent, and selected connectors remain explicit definition fields rather than opaque prompt text. Clipboard/file attachments, blob URLs, absolute external paths, transient application mentions, and slash commands with immediate side effects are rejected by validation.

An explicit model selection is frozen. `Auto` is stored as a sentinel and resolves the current workspace default at run time. Referenced files, skills, agents, explicit models, and connectors are revalidated on every run because they may disappear after creation.

Copying the entire composer was rejected because its live-session state would drift and duplicate fixes. Serializing `File` objects was rejected because they are not durable across restart.

### 6. Every accepted trigger creates a new unattended OpenCode session

After a run is claimed, resolve the required local workspace and create a new session with a title derived from automation name and scheduled time. Attach metadata containing automation id, run id, trigger source, scheduled time, and definition revision. Do not navigate or replace the renderer's current session.

Session creation passes the stored agent and resolved model plus the versioned unattended permission profile. The effective rules allow available tools without confirmation and explicitly deny the question capability. A system instruction states that the run is unattended, must not ask for confirmation, must use reasonable assumptions, and must fail clearly when it cannot continue. Organization policy and OS permission continue to take precedence.

Create the session before model/skill/connector preflight after the workspace itself resolves, so a trigger has the requested auditable session even when a later dependency is unavailable. If the workspace cannot resolve, record a failed run without a session because no valid workspace can own it.

Dispatch with `promptAsync`; successful dispatch is not completion. Subscribe to OpenCode events and mark success only after the target session becomes idle without a terminal error. On startup, query status for persisted `running` sessions and reconcile them; an unknown/missing session becomes `failed` with `session_lost` rather than remaining running forever.

### 7. Connector selection is a hard allowlist with per-run preflight

Reuse the existing combined connector inventory for labels, icons, stable ids, and authorization readiness, but provide an automation-specific multi-select field. Persist only stable connection ids and type/source descriptors; never copy OAuth tokens, MCP credentials, commands containing secrets, or provider secrets into automation tables or cloud payloads.

At run time:

1. Resolve every selected connector and verify current authorization/readiness.
2. Configure local MCP tool exposure so unselected local MCP servers are unavailable to the session.
3. For unified cloud connectors, obtain a short-lived run-bound MCP token/scope from `add-automation-sync-api`; that service filters capability search and execution to the definition's selected connection ids.
4. Fail preflight with a stable `connector_reauth_required`, `connector_unavailable`, or `connector_scope_unavailable` code when the allowlist cannot be enforced.

An instruction saying “only use selected connectors” was rejected as a security boundary because the unified Connect tool can otherwise discover and invoke another authorized connection. Wildcard OpenCode permission does not override the connector allowlist.

### 8. Expose global management and run-history surfaces

Add `/automations` and `/automations/runs` as global routes because one list spans workspaces. Extend every host of the shared `AppNavigationRail` with one `AlarmClock` rail button placed immediately after the existing `Cloud` workspace button and before Chat. It uses the existing 44-by-44 rail-button sizing, hover, tooltip, keyboard, focus, and selected-state treatment. Both Automation routes keep the button selected, and opening or switching between them does not change the task scope, selected workspace, selected session, or current Chat view.

The route opens `/automations` by default. Its top-left segmented tabs are `定时任务` and `运行记录`; selecting the latter navigates to `/automations/runs`, so refresh and deep links preserve the active tab. The scheduled-task tab shows name, workspace, human-readable schedule, active range, enabled/sync state, next run, manual play, and overflow actions. The run-history tab shows task, trigger, scheduled/start/end times, status, workspace, error summary, and a link to its session. Search is applied client-side to the current locally paginated result in V1.

When no non-deleted definitions exist, the scheduled-task tab matches the supplied landing reference: the tabs remain at the upper left; a centered muted alarm/check illustration, `开启你的第一个自动化任务吧` copy, and primary `+ 添加自动化` action occupy the main empty area; and an `自动化任务模板` section appears below. The empty-state action opens a blank create draft and performs no write. Search and row-only actions are hidden until a task exists. Run history has its own history-empty state and does not show the task-template catalog.

The template section is also retained below a non-empty scheduled-task list so it remains discoverable after the first task. It uses a three-column desktop grid, collapses to two and one columns at existing content breakpoints, and renders each card as a keyboard-focusable button with icon, title, and a maximum two-line ellipsized description. Initial localized cards cover the twelve supplied intents: `每日 AI 新闻推送`, `每日 5 个英语单词`, `每日儿童睡前故事`, `每周工作周报`, `经典电影推荐`, `历史上的今天`, `每日一个为什么`, `父母联系提醒`, `体检预约提醒`, `面试准备提醒`, `会议前准备`, and `可爱萌宠手机壁纸`.

Templates live in a versioned, bundled Desktop catalog with stable template id, localized title/description, icon key, durable prompt parts, optional supported schedule draft, and recommended connector ids. Selecting a template opens the normal create editor with those values prefilled; it never writes, confirms full access, or executes by itself. The required workspace remains empty, connectors are recommendations rather than granted authority, and all normal validation/authorization/acknowledgement applies. A template may intentionally leave time-sensitive or unsupported values incomplete: for example a one-time reminder requires a new future date, and a meeting-relative or workday-only phrase must not claim an unsupported trigger. The editor identifies missing fields before Save. The catalog contains no credentials, tokens, absolute local paths, or server-owned ids.

Applying a template is an editor-only transformation into the ordinary versioned automation definition. Template catalog/source metadata is not required in the saved task or cloud display projection. Consequently Desktop may add, remove, translate, or revise templates without changing the local persistence schema or requiring `jugglework-server` to understand a new field. If future clients choose to retain optional source metadata, it belongs only in the extension-preserving opaque definition document and older clients must preserve it under the existing compatibility rules.

The create/edit form is a controlled draft with the following ordered sections:

1. Local-execution warning, shown by default on every editor visit and dismissible for that visit only.
2. Name: trim on save, 1–100 Unicode characters, duplicates allowed because identity is UUID-based.
3. Workspace: exactly one existing local workspace, with name and path summary; remote workspaces are disabled with explanation.
4. Prompt composer: at least one non-empty durable text/reference part; model defaults to `Auto`, variant is shown only when supported, agent/expert and skills are optional, a fixed `完整访问权限` indicator replaces a downgradeable permission choice, and no Run task button exists.
5. Connectors: zero or more selected authorized/readiness-visible connectors, clearly described as the only connectors available to this automation. Selecting an unauthenticated connector reuses its existing connect/authorize flow; the task cannot be saved with a selected connector still requiring authorization.
6. Execution frequency: `周期 / 按间隔 / 单次` mode controls, explicit timezone, localized summary, and next-run preview.
7. Optional active date range: both dates or neither, inclusive in the selected timezone.

Create defaults to the system IANA timezone, `Auto` model, no connector, no active range, and enabled after successful full-access confirmation. Name uniqueness is not required. Save validates the whole draft before opening the permission dialog, disables repeated submission while the local transaction runs, and returns to the scheduled-task list after local success even when cloud sync is pending. Cancel makes no write; navigating away from a dirty draft requires discard confirmation.

The full-access dialog lists file write/modify/delete, Bash/network operations, selected-connector use without repeated confirmation, and responsibility for results. Its confirmation checkbox is mandatory and the confirm button remains disabled until checked. Because unattended execution requires full access, V1 does not offer a “run with default permissions” alternative; cancel returns to the editor unchanged. The acknowledgement records permission profile version and timestamp.

The scheduled-task tab groups non-deleted definitions into `当前` (enabled or paused tasks with a possible future occurrence) and `已结束` (consumed one-time tasks or tasks whose active range has expired). Current enabled tasks sort by next run ascending, paused tasks follow, and ended tasks sort by latest update descending. Each row shows name, workspace, human schedule, timezone when different from system timezone, active range or “always”, lifecycle status, sync status, next run or terminal reason, manual play, and overflow actions.

Task lifecycle is `enabled`, `paused`, `completed`, or tombstoned. Pausing creates no skipped records for paused occurrences. Resume calculates the next future occurrence from resume time and never catch-ups the paused period. Schedule edits behave the same from edit-save time. Manual run ignores paused/completed state and the active date range because it is an explicit user action, but still enforces no-overlap, workspace/dependency preflight, full-access acknowledgement, and connector allowlist; it never changes `next_run_at`.

The run-history tab defaults to newest scheduled/triggered time first and exposes task name, workspace, trigger source, scheduled time, actual start/end, duration, state, session link, sync state, and sanitized error. Search matches task name and workspace; status/trigger filters and bounded pagination are retained in the local API even if the first UI exposes only search.

Batch management remains absent in V1 rather than shipping an inactive control. Template creation is delivered through the inline scheduled-task catalog described above; there is no separate server-backed template API in V1.

### 9. Keep the current local-workspace release local-only

The current release only permits local workspaces. Definitions and run history therefore remain authoritative in runtime SQLite and do not call the remote automation definition/run mirror APIs. The UI does not show pending/synced/error cloud state because there is no cloud synchronization target for a local workspace automation.

The schema retains compatibility fields and the legacy outbox table so a later remote-workspace release can migrate forward without destructively rebuilding local history. New local writes do not enqueue outbox records, and the local-only migration clears previously queued records and normalizes existing compatible rows to local-complete state.

Remote-workspace automation, cross-device mirrors, stable-envelope upload, enrolled cloud executor identity, and run-bound cloud connector scope are deferred as one future capability. They MUST NOT be enabled merely because passive mirror endpoints exist; the product must first implement remote workspace selection and its execution ownership contract.

Document serialization is deterministic, but sync correctness uses the exact serialized bytes rather than a server reserialization. The local mirror cache/outbox retains raw accepted document/projection bytes. When a Desktop encounters a newer unsupported document schema, it keeps the task read-only and unscheduled and MUST NOT deserialize into an older DTO then overwrite it. When it supports the schema but sees unknown additive properties, edits preserve those properties through an extension/raw merge. An older server accepting the stable envelope can therefore store and return new fields without understanding them.

The task remains bound to the stable local installation id for local scheduling ownership. Cross-device transfer/editing remains a future explicit workflow.

## Risks / Trade-offs

- **Unattended full access can modify data outside the workspace** → Require explicit acknowledgement, show the exact risk, preserve organization/OS policy, deny interactive questions, and document that workspace selection is context rather than a sandbox.
- **Renderer authentication mediates cloud outbox delivery** → Persist every mutation first, resume delivery whenever an authenticated renderer is available, and keep scheduling independent of sync.
- **The client sleeps through due times** → Apply one bounded catch-up and record older misses instead of silently dropping or flooding executions.
- **OpenCode events are lost during restart** → Persist session id before dispatch and reconcile nonterminal runs through session status on startup.
- **A selected dependency expires or is removed** → Revalidate before every run, preserve the session/run audit trail, emit stable failure codes, and notify the user.
- **Composer extraction regresses interactive chat** → Keep session adapter behavior unchanged and cover both adapters with focused component tests before switching the live composer.
- **Local time rules surprise users near DST/month boundaries** → Show timezone in the editor/list and test gap, overlap, leap-year, and invalid-calendar cases with deterministic fixtures.
- **Full prompt cloud sync increases privacy exposure** → Encrypt at rest on the server, redact logs, expose sync state, and never include credentials or external absolute paths.
- **An older server does not understand new task fields** → Put client-owned fields only in the opaque document, keep envelope v1 stable, and use optional versioned projections for server semantics.
- **An older Desktop could erase newer fields** → Preserve raw/extension fields for supported schemas and make unsupported schemas read-only and unscheduled instead of down-converting.

## Migration Plan

1. Add runtime SQLite tables, pure schedule calculator, repository tests, and local CRUD APIs behind a disabled feature flag.
2. Add scheduler/run claiming and manual-run paths with a fake executor; verify restart, misfire, overlap, and clock-change behavior.
3. Extend local session creation and implement unattended execution/event reconciliation without exposing the UI.
4. Extract shared composer primitives, extend the navigation rail/global routes, add the scheduled-task landing page and bundled templates, then add management/history UI, connector selection, confirmation, i18n, and notifications.
5. Ship local-only automations without an outbox coordinator or cloud sync status presentation.
6. Add remote-workspace automation and its enrolled executor/sync contract together in a later change; only then enable cloud connectors after run-bound scope enforcement is available.

Rollback disables new UI and scheduler startup while retaining local tables and outbox rows. Existing sessions are ordinary OpenCode sessions and remain viewable. No rollback deletes definitions or run history; a later compatible build can resume from stored `next_run_at` and nonterminal reconciliation.

## Open Questions

- Whether a later release should expose the fixed ten-minute catch-up window and executor concurrency as user settings.
- Whether server-mirrored prompts should be optionally disabled for privacy-sensitive deployments; V1 synchronizes the full durable definition as requested.
- Windows/Linux tray/hide-on-close behavior: resolved — the desktop now ships an always-on tray (macOS status bar / Windows system tray) with close-to-hide on all platforms while the tray is active; see `apps/desktop/electron/app-tray.mjs`.
