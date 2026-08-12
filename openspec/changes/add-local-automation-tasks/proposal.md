## Why

JuggleWork Desktop can execute an AI task only after the user opens a workspace and submits a live session. Users need unattended, repeatable tasks that run locally at a configured time, create an auditable session in a chosen workspace, and remain usable when cloud synchronization is temporarily unavailable.

## What Changes

- Add a global Automation surface reached from an alarm-clock item directly below `Cloud workspace` in the shared left navigation rail, with separate scheduled-task and run-history views, search, manual run, pause/resume, edit, duplicate, and delete actions.
- Add the supplied scheduled-task landing experience: a first-task empty state with a direct Add automation action and a responsive built-in automation-template catalog that opens a validated prefilled draft without creating or executing a task.
- Add a fully specified automation editor for name, required single local workspace, a reusable session-style prompt composer without a submit action, model/variant/agent/skill settings, a hard allowlist of multiple connectors, full-access acknowledgement, and exact `周期 / 按间隔 / 单次` controls with timezone, next-run preview, and optional inclusive active dates.
- Define create/edit defaults and validation, atomic local save with pending cloud sync, dirty-draft discard protection, task list grouping/row fields, pause/resume/manual-run semantics, and detailed run-history presentation.
- Persist automation definitions, run records, scheduler state, and a durable cloud-sync outbox in the local JuggleWork runtime database.
- Run a restart-safe scheduler inside the embedded local JuggleWork server so hidden renderer windows do not stop dispatch; explicit application exit, device shutdown, or unavailable local runtime prevents execution as communicated in the UI.
- Create a new OpenCode session for every accepted trigger, attach automation/run metadata, apply unattended full-access rules, dispatch the stored prompt asynchronously, and derive the final run state from OpenCode session events plus restart reconciliation.
- Enforce non-overlap, deterministic missed-run handling, idempotent scheduled dispatch, connector/model/workspace preflight, and native failure notification.
- Synchronize task definitions and run records to the cloud through an idempotent, retryable client without making cloud availability part of the local execution path.
- Serialize cloud mirrors through a stable envelope containing an opaque versioned task document plus independent display/security projections, so additive client fields can be stored and round-tripped by an older server without a server upgrade or SQL migration.
- Restrict the initial release to local workspaces and durable prompt parts; ephemeral attachments and running-application references are not schedulable.

## Capabilities

### New Capabilities

- `automation-management`: Global automation navigation/landing UI, built-in templates, definition validation, reusable prompt composition, workspace/model/agent/skill/connector selection, full-access acknowledgement, and lifecycle actions.
- `local-automation-scheduling`: Durable local schedules, due-time calculation, missed-run and overlap policy, manual dispatch, restart recovery, and client-lifecycle behavior.
- `automation-session-execution`: New-session creation, unattended permissions, prompt dispatch, connector preflight and scoping, event-based completion, run history, notifications, and session navigation.
- `automation-cloud-sync-client`: Device-bound, idempotent synchronization of automation definitions and run records through a persistent outbox while local execution remains authoritative.

### Modified Capabilities

None.

## Impact

- **Renderer:** extends the shared `AppNavigationRail` and global route parser, adds Automation landing/list/history/editor surfaces and a local versioned template catalog, extracts reusable prompt-composer primitives from the current session composer, and reuses existing workspace, model, skill, agent, and connector inventories.
- **Embedded server:** adds automation CRUD/run APIs, runtime SQLite schema, scheduler/executor services, OpenCode session-event reconciliation, and cloud-sync coordination endpoints.
- **Electron lifecycle:** keeps scheduling active while the application runtime remains alive and makes platform-specific close/quit behavior explicit to users.
- **OpenCode integration:** extends session creation to pass metadata, model/agent selection, and session-scoped permission rules; automated prompts never wait for permission or question responses.
- **Cloud contract:** depends on the separate `jugglework-server` change `add-automation-sync-api`; no cloud response is required to create or execute a local automation.
- **Template/server compatibility:** applying a template produces an ordinary client-owned automation draft; the server does not store or interpret the template catalog, so adding or changing Desktop templates requires no server upgrade.
- **Security/privacy:** selected connectors are a hard allowlist, credentials remain in their existing stores, and cloud payloads exclude tokens, local absolute paths, and attachment bytes.
