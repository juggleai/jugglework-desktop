## ADDED Requirements

### Requirement: Global automation management surface
The Desktop SHALL provide global `/automations` and `/automations/runs` routes with separate `定时任务` and `运行记录` tabs. The scheduled-task list SHALL display each task's name, required workspace, schedule summary, active range, enabled state, next run, and cloud sync state, and SHALL support search without requiring a workspace to be open. The tab selection SHALL be route-backed so refresh and deep linking preserve it.

#### Scenario: User opens Automation from another workspace
- **WHEN** the user opens the global Automation route while any workspace or session is active
- **THEN** the route lists automations from all local workspaces without changing the active session

#### Scenario: User switches to run history
- **WHEN** the user selects the Run history tab
- **THEN** the Desktop navigates to `/automations/runs` and lists locally recorded runs independently of the scheduled-task list

### Requirement: Automation navigation rail entry
Every full-shell surface using the shared left `AppNavigationRail` SHALL show an alarm-clock Automation button immediately below the existing `Cloud workspace` button and immediately above Chat. It SHALL use the existing rail button's size, spacing, hover, tooltip, focus, keyboard, and active-state behavior, SHALL have a localized Automation accessible label, and SHALL remain active for both Automation routes.

Opening Automation MUST NOT change the local/remote task scope, selected workspace, selected session, or current Chat subview. The active session SHALL still be available when the user navigates back.

#### Scenario: User opens Automation from the rail
- **WHEN** the user activates the alarm-clock button while a workspace session is selected
- **THEN** the Desktop navigates to `/automations`, selects the Automation rail item, and preserves the selected workspace/session state

#### Scenario: User views run history from the rail surface
- **WHEN** the current route is `/automations/runs`
- **THEN** the same Automation rail item remains selected and no workspace rail item is selected as the active surface

#### Scenario: User reaches the rail with a keyboard
- **WHEN** keyboard focus reaches the Automation rail item
- **THEN** its localized label and focus indicator are available and Enter or Space opens `/automations`

### Requirement: Scheduled-task landing and empty state
The `定时任务` route SHALL always render the two top-left segmented tabs. When no non-deleted automation exists, it SHALL render a centered muted alarm/check illustration, `开启你的第一个自动化任务吧` copy, a primary `+ 添加自动化` action, and the built-in `自动化任务模板` section below the main empty area as shown in the supplied reference. Search and task-row actions SHALL be hidden in this state.

The Add action SHALL open a blank create draft without writing a task. When tasks exist, the empty-state illustration/copy SHALL be replaced by the scheduled-task controls/list while the template section remains available below the list. The `运行记录` route SHALL use its own history empty state and SHALL NOT render task templates.

#### Scenario: First-time user opens Scheduled tasks
- **WHEN** the local repository contains no non-deleted automation definition
- **THEN** the user sees the first-task empty state, Add automation action, and template catalog without search or row actions

#### Scenario: User starts without a template
- **WHEN** the user activates `+ 添加自动化` in the empty state
- **THEN** a blank create editor opens and no definition, run, or cloud outbox mutation exists until Save succeeds

#### Scenario: First task has been created
- **WHEN** at least one non-deleted task exists
- **THEN** the scheduled-task list replaces the first-task empty state and the template catalog remains below the list

#### Scenario: Run history is empty
- **WHEN** the user opens `运行记录` and no runs exist
- **THEN** a run-history-specific empty state is shown without the automation-template catalog

### Requirement: Built-in automation template catalog
The template catalog SHALL be shown inline only while no automation exists. Once the list has at least one automation the catalog SHALL move behind an `Add from template` entry that opens a dedicated `/automations/templates` page, keeping the list page to the tasks themselves. That page and the editor SHALL both render an `Automation / <page>` breadcrumb whose root segment returns to the list, subject to the editor's unsaved-draft confirmation.

The Desktop SHALL ship a versioned local template catalog with stable template ids, localized title/description, an icon key, durable prompt parts, an optional supported schedule draft, and optional recommended connector ids. Its initial Chinese catalog SHALL contain cards for `每日 AI 新闻推送`, `每日 5 个英语单词`, `每日儿童睡前故事`, `每周工作周报`, `经典电影推荐`, `历史上的今天`, `每日一个为什么`, `父母联系提醒`, `体检预约提醒`, `面试准备提醒`, `会议前准备`, and `可爱萌宠手机壁纸`.

Cards SHALL form a three-column desktop grid and collapse to two or one columns at the application's existing content breakpoints. Each card SHALL be a keyboard-operable button with its icon, title, and at most two visible description lines with overflow ellipsis.

Activating a template SHALL open the ordinary create editor and prefill only fields represented by the template. It MUST NOT create, save, schedule, synchronize, acknowledge full access, authorize a connector, or execute a task. Workspace SHALL remain unselected. Recommended connectors SHALL be suggestions requiring explicit user selection and the existing authorization flow. Missing or time-sensitive schedule values, including a future date for a one-time reminder, SHALL remain invalid until the user supplies them. Template copy MUST NOT promise event-relative, workday-only, or other trigger semantics that the supported schedule model cannot encode.

Template application SHALL produce an ordinary automation draft; saved definitions and server display projections MUST NOT require the server to know the template catalog. Adding, removing, reordering, translating, or revising bundled templates MUST therefore require no local database migration and no `jugglework-server` upgrade. Template data MUST NOT contain credentials, tokens, connector grants, absolute local paths, or server-owned resource ids.

#### Scenario: User chooses a complete recurring template
- **WHEN** the user activates a template whose durable prompt and supported schedule draft are complete
- **THEN** the create editor shows those values but still requires a local workspace and current full-access confirmation before Save can succeed

#### Scenario: Template needs a future date
- **WHEN** the user activates a one-time reminder template without a valid future date
- **THEN** the create editor highlights the missing date and blocks Save until a strictly future instant is configured

#### Scenario: Template recommends a connector
- **WHEN** a template recommends a connector such as the source-code provider used by a weekly report
- **THEN** the connector is presented as a recommendation and is not selected, authorized, or available to execution until the user explicitly chooses it

#### Scenario: Desktop adds a template while the server stays old
- **WHEN** a newer Desktop build adds or changes a bundled template and synchronizes a task created from it to an older envelope-compatible server
- **THEN** the server stores the resulting ordinary opaque task definition without needing a template API, schema migration, or release

#### Scenario: User activates a template with the keyboard
- **WHEN** keyboard focus is on a template card and the user presses Enter or Space
- **THEN** the corresponding prefilled create editor opens with a visible focus transition and no task write

### Requirement: Valid local automation definition
Creating or saving an automation MUST require a trimmed name of 1–100 Unicode characters, exactly one existing local workspace, at least one non-empty durable prompt part, a supported schedule with an explicit IANA timezone, and a current acknowledgement of one of the supported permission profiles. Names need not be unique because definitions use stable UUID identities. Remote workspaces MUST NOT be selectable in the initial release.

A new draft SHALL default to the current system IANA timezone, `Auto` model, no selected connector, no active date range, and enabled state after successful save and permission confirmation. The stored timezone MUST remain unchanged if the system timezone later changes.

#### Scenario: Required workspace is missing
- **WHEN** the user attempts to save an automation without selecting one local workspace
- **THEN** saving is blocked and the workspace field displays a validation error

#### Scenario: Remote workspace appears in inventory
- **WHEN** the workspace inventory contains a remote worker workspace
- **THEN** that workspace is unavailable for selection and explains that V1 automations execute only on this device

#### Scenario: Duplicate display name is used
- **WHEN** the user saves two valid automations with the same name
- **THEN** both are accepted with different ids and remain independently editable and schedulable

#### Scenario: New draft opens
- **WHEN** the user selects Add automation
- **THEN** the form uses `Auto`, the current IANA timezone, no connector, no active range, and an empty required workspace/prompt without creating a persisted task

### Requirement: Session-style durable prompt composer
The automation editor SHALL reuse the current session composer's editor and mirror its toolbar for model, variant, agent, skill, connector, and workspace-file selection — including the tool menu and the selected-item tags — but MUST NOT display or invoke the session “Run task” action. It MUST store a versioned durable prompt template and reject blob-backed attachments, clipboard images, external absolute paths, running-application references, and commands that execute immediately.

#### Scenario: User composes a scheduled prompt
- **WHEN** the user enters text, selects an installed skill, and references a workspace-relative file
- **THEN** the editor preserves those structured parts in the automation definition without starting a session

#### Scenario: User adds an ephemeral attachment
- **WHEN** the user attempts to add a clipboard image or blob-backed file attachment
- **THEN** the editor refuses the part and explains that scheduled prompts must survive application restart

### Requirement: Multiple selected connectors
The automation editor SHALL reuse the existing connector inventory and SHALL allow zero or more currently visible connectors to be selected, displayed as removable selected items/chips. It MUST persist only stable connection identifiers and display metadata, MUST NOT persist credentials, and SHALL present the selection as a hard execution allowlist.

Connected/authorized connectors SHALL be directly selectable. Selecting a connector that requires connection or member authorization SHALL reuse the existing connect/authorize flow, and Save MUST remain blocked while any selected connector is not ready. Authorization that expires after creation SHALL be handled by run preflight rather than silently removing the selection.

#### Scenario: User selects several connectors
- **WHEN** the user selects two authorized connectors and saves the automation
- **THEN** both stable connector identifiers are stored and shown when the definition is reopened

#### Scenario: Connector contains a credential
- **WHEN** connector inventory data includes OAuth or MCP credential material
- **THEN** the saved local and cloud-sync automation payloads omit that material

#### Scenario: User selects a connector requiring authorization
- **WHEN** the user selects a disconnected or unauthenticated connector
- **THEN** the existing connection/authorization flow opens and the connector cannot be saved as selected until it becomes ready

#### Scenario: User removes one of several connectors
- **WHEN** the user removes a selected connector chip
- **THEN** only that stable connector id is removed and the remaining selections keep their order and readiness state

### Requirement: Explicit unattended full-access acknowledgement
The editor SHALL show by default on every create/edit visit a warning that automations execute locally without attendance and require the computer and client runtime to remain active. The warning MAY be dismissed for the current editor visit but MUST return on the next visit. Before first save, the user MUST confirm a versioned risk acknowledgement explaining file mutation/deletion, Bash/network operations, selected-connector calls, and responsibility for the result.

The workspace selection SHALL NOT be described as an OS security sandbox. A changed permission-profile version MUST require renewed acknowledgement.

The confirmation dialog MUST list file write/modify/delete, Bash and network operations, selected-connector calls without repeated confirmation, and user responsibility. It MUST require a dedicated risk checkbox, keep Confirm disabled until checked, and record acknowledgement timestamp plus permission-profile version. Because V1 unattended execution requires full access, it MUST NOT offer a default-permission execution alternative.

#### Scenario: User has not acknowledged risk
- **WHEN** a valid automation form is saved before its current full-access profile is acknowledged
- **THEN** the confirmation dialog opens and the definition is not created until the user explicitly accepts

#### Scenario: Permission profile changes after creation
- **WHEN** a newer client requires a different unattended permission-profile version
- **THEN** editing or re-enabling the automation requires acknowledgement of the new profile

#### Scenario: User opens confirmation but has not checked risk
- **WHEN** the full-access dialog is open and its risk checkbox is unchecked
- **THEN** Confirm remains disabled and no automation write occurs

#### Scenario: User cancels full-access confirmation
- **WHEN** the user cancels the full-access dialog
- **THEN** the dialog closes, the populated editor remains unchanged, and no local or cloud task is created

### Requirement: Automation lifecycle actions
The scheduled-task list SHALL support manual run, edit, pause/resume, and delete actions; duplicate is reachable from the editor entry point rather than the row.

The list SHALL also offer a batch mode that reveals a per-row checkbox, a select-all toggle, a selected count, and a confirmed batch delete. Batch delete SHALL apply each deletion with its own base revision so a conflict stops the batch instead of silently overwriting, and the list SHALL reflect whatever was already removed. Pausing MUST preserve the definition and history while preventing new scheduled runs. Duplicating MUST assign a new identity, start paused, and require a fresh full-access acknowledgement before enablement. Deletion MUST be locally recoverable until its tombstone is synchronized or the user confirms permanent local removal.

#### Scenario: User batch deletes several tasks
- **WHEN** the user enters batch mode, selects several automations and confirms deletion
- **THEN** each selected automation is deleted with its own base revision and the run history of each is kept

#### Scenario: User pauses an enabled task
- **WHEN** the user pauses an enabled automation
- **THEN** its future due times are not dispatched and its prior run history remains visible

#### Scenario: User duplicates a task
- **WHEN** the user duplicates an automation
- **THEN** a new paused draft is created with copied durable configuration but a new id and no inherited acknowledgement

#### Scenario: User deletes a task with history
- **WHEN** the user confirms deletion of an automation that has run records
- **THEN** the task disappears from the active list, its cloud tombstone is queued, and existing session links remain usable from retained history according to retention policy

### Requirement: Complete create and edit form
The automation editor SHALL present, in order, the local-runtime warning, name, required single workspace, session-style prompt composer, connector multi-select, execution-frequency controls, and — for recurring modes only — the optional active date range. The header SHALL provide Cancel and Save actions, and edit mode SHALL display the task identity/name without changing it until save.

Model, variant, agent, and skill selection SHALL live in the prompt composer's toolbar rather than in separate page sections, matching the session composer's placement, with the skill entry leftmost. Selecting a skill SHALL insert it as an inline tag at the caret inside the prompt editor — the same node the session composer uses — and the stored skill list SHALL be derived from those inline tags rather than a parallel form field.

Connectors SHALL be a dedicated multi-select field below the prompt composer: a collapsed summary of the checked connector names, an expanded checkbox list, and a link to manage connectors. A cloud connector that is not yet authorized SHALL offer connect in place of a checkbox.

Model, agent, skill, and connector lists SHALL be readable before a workspace is chosen, falling back to the first local workspace; choosing a workspace SHALL refresh them so workspace-installed skills and connectors appear. A new draft SHALL preselect the application's default model rather than `Auto`, and models SHALL be listed grouped by provider.

The agent list SHALL match the session composer's: hidden agents, subagents, and the built-in default agent are excluded from the options, and the built-in default is offered once as `默认智能体`.

Create mode SHALL identify the page as `Automation / New automation`; edit mode SHALL identify it as `Automation / <saved name>`. The connector field helper SHALL explain that checked connectors are authorized for unattended use without repeated confirmation. The frequency helper SHALL recommend avoiding peak periods because globally bounded local execution can queue. The active-range helper SHALL state that leaving the range blank means always active.

Variant controls SHALL appear only when supported by the selected model. Agent/expert and skills SHALL be optional and multiple skill references MAY be stored. The prompt area MUST NOT contain a Run task action.

The prompt toolbar SHALL expose the permission mode next to the model control, rendering only its warning glyph in a warning color while the label matches the neighbouring toolbar controls. It SHALL offer two versioned profiles: full access (default, recommended) and interactive default permissions. Each option MUST state its consequence — full access runs unattended and may take sensitive actions, while default permissions ask for confirmation and leave an unattended run waiting.

Choosing full access SHALL still require the explicit risk acknowledgement before save. Choosing default permissions SHALL skip that dialog, because that mode asks the user per action at run time instead.

#### Scenario: Model has no variants
- **WHEN** the selected explicit model exposes no supported variant
- **THEN** the variant control is hidden or disabled and no stale variant is persisted

#### Scenario: User reopens a saved task
- **WHEN** the user edits an existing automation
- **THEN** every persisted field, structured prompt part, selected connector, schedule value, timezone, active range, lifecycle state, and sync state is restored accurately

#### Scenario: User reviews scheduling guidance
- **WHEN** the create/edit form renders
- **THEN** connector, frequency, and active-range helper text explains unattended authorization, peak-period queueing, and blank-range always-active behavior

### Requirement: Atomic save and dirty-draft behavior
Save SHALL validate all fields before requesting full-access confirmation. After confirmation, it MUST perform one local definition/outbox transaction, disable duplicate submission while pending, and return to the task list after local success even when cloud synchronization is pending. A local failure MUST keep the draft open with field/form error and MUST NOT show a created task.

Cancel SHALL write nothing. Leaving a dirty create/edit form through Cancel, route navigation, or window-close navigation MUST request discard confirmation; a pristine form SHALL leave immediately.

Editing schedule, timezone, active range, model, agent, skills, prompt, workspace, or connectors SHALL create a new definition revision. A queued or running run MUST retain the prior captured revision.

#### Scenario: Cloud is offline after valid save
- **WHEN** the local definition/outbox transaction succeeds but cloud upload cannot start
- **THEN** the editor returns to the list and the task appears enabled with pending sync state

#### Scenario: User double-clicks Save
- **WHEN** a save transaction is already pending
- **THEN** further Save actions are disabled and at most one definition revision is committed

#### Scenario: User abandons a dirty edit
- **WHEN** the user attempts to leave after changing the schedule without saving
- **THEN** the Desktop asks whether to discard changes and preserves the stored definition unless discard is confirmed

### Requirement: Scheduled-task list grouping and row details
The Scheduled tasks tab SHALL group definitions into `Current` for enabled or paused tasks with a possible future occurrence and `Ended` for consumed one-time tasks or expired active ranges. Enabled current tasks SHALL sort by next run ascending, paused tasks SHALL follow, and ended tasks SHALL sort by latest update descending.

Each row MUST show name, workspace, localized schedule summary, and active range when present, with the next run rendered as a relative time (for example `12天后执行`). The schedule timezone MUST NOT appear in the row — the schedule always runs on this host. Paused and completed tasks show their lifecycle state in place of the relative time.

Row actions SHALL stay hidden until the row is hovered or its menu is open, at which point a manual-run action and an overflow menu (pause/resume, delete) replace the relative time. A sync failure or terminal error MUST remain visible without hovering. Search SHALL match task name and workspace without changing scheduler state.

#### Scenario: Enabled and paused tasks coexist
- **WHEN** the list contains enabled tasks with future runs and paused tasks
- **THEN** enabled tasks are ordered by next run and paused tasks appear afterward with a visible paused state

#### Scenario: One-time task was consumed
- **WHEN** a one-time task has accepted its only scheduled occurrence
- **THEN** it appears under Ended with no next run while its manual-run and history access remain available

### Requirement: Run-history presentation
The Run history tab SHALL order rows by scheduled/triggered time descending and show automation name, workspace, trigger source, scheduled time, actual start/end, duration, state, session link when available, sync state, and sanitized error. Search SHALL match automation name and workspace. The local API MUST additionally support bounded status, trigger-source, and time-range filters with cursor pagination.

#### Scenario: Failed run has an audit session
- **WHEN** a failed run contains a session id and sanitized error
- **THEN** history displays the failure and allows navigation to both run details and its workspace session

### Requirement: Batch management remains out of V1
Batch management SHALL NOT be rendered as an active control in V1. Its absence MUST NOT block direct or template-assisted Add automation, editing, scheduling, or run history.

#### Scenario: User opens V1 task list
- **WHEN** the Automation surface renders with the V1 feature flag
- **THEN** direct Add automation and the functional inline template catalog are available while batch management is absent rather than present as a nonfunctional action
