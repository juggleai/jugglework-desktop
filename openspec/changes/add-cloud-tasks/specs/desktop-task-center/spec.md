## ADDED Requirements

### Requirement: Independent task navigation
The Desktop SHALL provide Tasks in the More navigation menu, allow the user to pin it to the left vertical navigation, and open `/tasks` regardless of Agent or AI provider availability.

#### Scenario: Open task center without AI provider
- **WHEN** a signed-in user clicks Tasks without a configured AI provider
- **THEN** the task center opens and supports core task interactions

#### Scenario: Pin Tasks to the navigation rail
- **WHEN** the user pins Tasks from its navigation menu action
- **THEN** Tasks appears in the left vertical navigation and remains available after restart

### Requirement: Task information architecture
The Desktop SHALL provide primary task secondary navigation for Today, Assigned to me, Following, and Activity. It SHALL provide an initially expanded, collapsible Quick access section for All tasks, Created by me, Assigned by me, and Completed, followed by task lists and their create/archive actions. Inbox, Trash, and Archived lists SHALL NOT be visible sidebar destinations.

#### Scenario: Open tasks assigned by the current user
- **WHEN** the user selects Assigned by me from Quick access
- **THEN** the Desktop requests the `delegated` system view and shows accessible todo tasks assigned by the current user

#### Scenario: Restore a removed persisted destination
- **WHEN** persisted Desktop state contains Inbox, Trash, Archived lists, or an unknown section
- **THEN** the Desktop safely restores Today rather than rendering a hidden destination

### Requirement: Task list and detail surfaces
The Desktop SHALL provide a paginated task list, inline permitted actions, and a detail drawer or direct route for task fields, comments, activity, and lifecycle actions.

#### Scenario: Open task detail
- **WHEN** a user clicks an accessible task title
- **THEN** the Desktop opens the task detail and renders each field as editable or read-only according to server authorization

### Requirement: Assigned-to-me workbench
The Desktop SHALL render a rich workbench only for Assigned to me with exactly List and Board tabs persisted per ProductTask scope. List SHALL default to Task title, Assignee, Start time, Due time, Creator, Created time, Task ID, and Task list, with title mandatory and the remaining fields configurable. Board SHALL group loaded tasks into To do, Completed, and Canceled lanes with accessible complete, reopen, and cancel actions.

#### Scenario: Enrich loaded task pages
- **WHEN** Assigned to me pages are loaded
- **THEN** the Desktop joins `membersByTaskId` to the paged organization member directory and task-list map without issuing per-task detail requests

#### Scenario: Read an older task page response
- **WHEN** a valid task page omits `membersByTaskId` or omits a loaded task key from that map
- **THEN** the Desktop treats the missing member data as an empty array while rejecting malformed present member values

#### Scenario: Personal directory is unavailable
- **WHEN** the organization member endpoint is forbidden or unavailable for a personal workspace
- **THEN** the workbench remains usable and falls back to the current organization member ID/current user summary or shortened IDs

#### Scenario: Configure workbench data
- **WHEN** the user changes status, priority, task-list, overdue, supported sort, grouping, or fields
- **THEN** the settings persist for the current scope and all server requests use only supported query parameters

#### Scenario: Select completed tasks after filtering overdue
- **WHEN** the user changes status to Completed while Overdue only is active, or restores that persisted combination
- **THEN** the Desktop clears and disables Overdue only and does not send the incompatible overdue query

#### Scenario: Task-list join is unavailable
- **WHEN** task-list loading fails after Assigned to me tasks load
- **THEN** the Desktop keeps tasks rendered and shows a visible degraded-state banner with Retry

#### Scenario: Inspect a task identifier
- **WHEN** the Task ID field is visible
- **THEN** the Desktop displays the full exact identifier in selectable monospaced text and provides an exact copy action

#### Scenario: Sort loaded tasks by start time
- **WHEN** the user chooses Start sorting
- **THEN** the Desktop sorts the currently loaded tasks client-side and does not send unsupported `sort=start_at`

### Requirement: Assigned workbench creation menu
The Assigned to me tool area SHALL expose exactly New task and New task list. New task SHALL open full creation. New task list SHALL open a dialog with name, description, marker, and private visibility default and SHALL expose mutation errors without leaking late results across scope changes.

### Requirement: Multi-assignee completion confirmation
The Desktop SHALL explicitly warn that completing a task with multiple assignees completes it for everyone.

#### Scenario: Complete multi-assignee task
- **WHEN** an authorized user chooses to complete a task with more than one assignee
- **THEN** the Desktop requires confirmation before sending the completion mutation

### Requirement: Task creation surfaces
The Desktop SHALL support full creation with title, description, assignees, start time, due time, priority, visibility, and task list. Assignees remain optional outside contextual defaults.

#### Scenario: Create from Assigned to me
- **WHEN** the current organization member can be identified and the user opens New task from Assigned to me
- **THEN** the Desktop defaults that member as an assignee and defaults the selected sidebar task list when present

#### Scenario: Assign another member to a private task
- **WHEN** the user selects an assignee other than themselves while visibility is Private
- **THEN** the Desktop switches visibility to Members or presents clear validation that prevents submission

### Requirement: Conflict and connectivity states
The Desktop SHALL expose loading, empty, error, forbidden, offline, and optimistic-concurrency conflict states without silently overwriting cloud data.

#### Scenario: Concurrent edit conflict
- **WHEN** an update is rejected because the task version is stale
- **THEN** the Desktop preserves the user's draft for that Task and offers to load the latest version before retrying with a new idempotency key

#### Scenario: Dismiss conflict feedback
- **WHEN** the user dismisses a conflict banner without closing the Task
- **THEN** the Desktop hides the banner but keeps the edit buffer applied until a successful save or explicit Task close

#### Scenario: Switch Task during conflict recovery
- **WHEN** the user selects another Task while a conflict draft is buffered
- **THEN** the Desktop hides recovery actions for the previous Task, does not apply its draft or version to the new Task, and reapplies the buffered draft if the previous Task is selected again

#### Scenario: Organization changes during mutation
- **WHEN** a Task mutation settles after the active deployment, user, or organization scope changed
- **THEN** the prior scope result does not navigate, show an alert, or restore a conflict in the new scope
