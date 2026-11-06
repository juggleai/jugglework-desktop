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
The Desktop SHALL render a rich workbench only for Assigned to me with exactly List and Board tabs persisted per ProductTask scope. List SHALL default to Task title, Assignee, Start time, Due time, Creator, Created time, Task ID, Priority, and Task list, with Priority immediately before Task list, title mandatory, and the remaining fields configurable. Board SHALL group loaded tasks into To do, Completed, and Canceled lanes with accessible complete, reopen, and cancel actions.

When the user activates an editable Assignee cell, the List SHALL open a people picker with organization-member search, current-assignee indicators, multi-select add/remove operations, and completion-rule choices for any-assignee or all-assignees completion. Each member or completion-rule change SHALL load the current task version and permissions, use optimistic concurrency, preserve unrelated task fields and member roles, and remain visually unchanged when persistence fails.

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

#### Scenario: Inspect a task number
- **WHEN** the Task number field is visible and the Server provides `displayNumber=100134`
- **THEN** the Desktop displays selectable monospaced text `t100134`, exposes the full immutable internal ID as context, and provides an exact copy action for that internal ID

#### Scenario: Read an older task without a display number
- **WHEN** an otherwise valid older Server response omits `displayNumber`
- **THEN** the Desktop keeps the task usable, displays a shortened internal ID as a temporary fallback, and still copies the complete immutable internal ID

#### Scenario: Sort loaded tasks by start time
- **WHEN** the user chooses Start sorting
- **THEN** the Desktop sorts the currently loaded tasks client-side and does not send unsupported `sort=start_at`

### Requirement: Assigned workbench creation menu
The Assigned to me tool area SHALL expose exactly New task and New task list. New task SHALL open full creation. New task list SHALL open a dialog with name, description, marker, and private visibility default and SHALL expose mutation errors without leaking late results across scope changes.

#### Scenario: Open the task creation menu
- **WHEN** the user opens the Assigned to me creation menu
- **THEN** the Desktop offers exactly New task and New task list

### Requirement: Multi-assignee completion behavior
The Desktop SHALL explicitly warn that completing a multi-assignee `any_assignee` task completes it for everyone. For `all_assignees`, completion SHALL submit only the current assignee's portion, keep the task visibly incomplete while other assignees remain, and prevent duplicate completion by an assignee whose portion is already complete.

#### Scenario: Complete multi-assignee task
- **WHEN** an authorized user chooses to complete a task with more than one assignee
- **AND** the task uses `any_assignee`
- **THEN** the Desktop requires confirmation before sending the completion mutation

#### Scenario: Complete one portion of an all-assignees task
- **WHEN** the current assignee completes an `all_assignees` task while another assignee remains incomplete
- **THEN** the Desktop displays that the current assignee's portion is complete, leaves the task in the todo presentation, and does not send the same completion again

### Requirement: Task creation surfaces
The Desktop SHALL support full creation with title, description, assignees, start time, due time, priority, visibility, and task list. Assignees remain optional outside contextual defaults.

Assigned to me List SHALL also support title-only inline creation. Activating New task in the list toolbar SHALL insert and focus an input row before the first task row, while activating New task in the final list row SHALL insert and focus an input row immediately below that trigger row.

When an inline title input loses focus, the Desktop SHALL cancel the draft if its trimmed title is empty, or submit it as if Enter had been pressed when the trimmed title is non-empty. Enter and blur handling SHALL not create the same draft more than once.

Changing the Assigned to me status filter SHALL preserve the mounted workbench and currently rendered task rows while the replacement query is pending. The Desktop SHALL use a local, non-blocking loading indicator instead of replacing the page with a loading state.

The Assigned to me sort menu SHALL present each supported sort field as its own row with ascending and descending controls on that row. Choosing a field without an explicit direction SHALL default that field to descending order, while the active field and direction remain visually identifiable.

The sort menu SHALL expose start time, due time, created time, updated time, and completed time. Priority remains a task property and filter but SHALL NOT appear as a sort-menu field. Start-time and completed-time sorting SHALL remain compatible with servers that do not accept those sort tokens by requesting the supported updated-time order and sorting the currently loaded tasks locally with null values last.

The active sort field label and only its currently applied direction control SHALL use the accent color without a checkmark or persistent row background. The active field's opposite direction control SHALL remain hidden until that row is pointer-hovered. Inactive fields SHALL hide both direction controls until their row is pointer-hovered, including when the menu automatically focuses its first item, and row backgrounds SHALL appear only on hover.

The List grouping menu SHALL support Custom group, Start time, and Due time in addition to no grouping, task list, and creator. Custom grouping SHALL place every loaded task in a stable Default group, including an empty Default group when no tasks are loaded. The Default group SHALL expose hover/focus actions for renaming and a visible but disabled delete action; its renamed display label SHALL persist in the current ProductTask scope. Custom grouping SHALL also expose a trailing New group action that creates persisted empty display groups through an inline title input. Additional custom groups SHALL support rename and delete actions. A task created from an additional custom group's header or trailing action SHALL remain assigned to that display group after creation and refresh; deleting the group SHALL clear its display assignments so those tasks return to Default group. Start-time grouping SHALL present Started, Today, Tomorrow, Next 7 days, Later, and Unscheduled in that order. Due-time grouping SHALL present Overdue, Today, Tomorrow, Next 7 days, Later, and Unscheduled in that order. Today and future buckets SHALL use the user's local calendar-day boundaries; Next 7 days includes local dates from the day after Tomorrow through seven days after Today.

Every visible group SHALL render a header with its task count and an independent disclosure control. Groups with tasks start expanded, empty time groups start collapsed, and the user MAY expand or collapse any group without changing filters or task data. Expanding an empty group SHALL reveal its body rather than immediately collapsing it again.

Every expanded group SHALL end with an inline New task action. A task created from a task-list group SHALL inherit that list; a task created from a start-time or due-time group SHALL inherit a representative local timestamp that remains in that bucket, while Unscheduled SHALL leave the corresponding timestamp empty. Creator grouping SHALL preserve the authoritative current creator rather than impersonating the displayed creator group.

Each group header SHALL reveal a plus action on pointer hover or keyboard focus. Activating it SHALL expand the group if needed and open that group's inline task draft as the first row before existing tasks. The trailing New task action SHALL continue to open the draft after existing tasks. When Start time or Due time grouping is active, the workbench toolbar's New task action SHALL open a draft in the Today group with a corresponding Today start or due time.

When Task list grouping is active, the workbench toolbar's New task action SHALL open its draft in the No task list group without a list assignment.

The Assigned to me filter control SHALL open a wide condition-builder panel with a header, clear action, ordered When/And condition rows, removable rows, and an Add condition action. Its field selector SHALL list assignee, start time, due time, completed time, assigner, follower, creator, created time, and updated time in that order. Assignee, assigner, follower, and creator conditions SHALL support contains, does not contain, is empty, and is not empty operators. Contains and does-not-contain SHALL select one or more people from the current organization's member directory and display member avatars and names; empty operators SHALL not display a value selector. Active conditions SHALL contribute to the filter badge and SHALL map to the corresponding server list-query parameters.

Creator group headers SHALL display the creator avatar and display name with the task count. Creator groups SHALL NOT expose header plus actions or per-group trailing New task rows because creator identity is authoritative. The toolbar New task action SHALL instead open its draft in the signed-in member's creator group, creating that group header when the loaded page has no current task from that member.

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
