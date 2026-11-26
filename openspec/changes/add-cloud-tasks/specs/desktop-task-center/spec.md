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

Sidebar task-list rows SHALL display a consistent task-list icon followed by the list name. The sidebar, Today task cards, and Activity list links SHALL NOT prepend the list marker as visible text. Today SHALL show only resolved list names, not raw list IDs.

The task-list section add action and the workbench New task list menu SHALL open the same auto-focused inline name input above the existing task lists instead of opening a task-list dialog. If the sidebar is collapsed, the workbench menu action SHALL expand it first. The input SHALL prefill and select a localized `Task list N` name so typing replaces it while immediate submission accepts the default. Enter or focus loss SHALL create a private list with an empty description and a marker derived from the first name character, then open the created list. Escape SHALL cancel without a mutation. A failed create SHALL preserve the entered name for retry.

#### Scenario: Resolve a newly shared task list without leaving Tasks
- **WHEN** loaded task data references a list missing from the current member's active list directory
- **THEN** Desktop refreshes the directory through the normal permission-filtered query, combining missing references and attempting at most once per missing list per page visit and account scope
- **AND** workbench and detail list labels show a syncing state while loading, the name when resolved, or an unavailable state if unresolved; they do not show raw IDs or imply the task has no list

#### Scenario: Create a task list from the sidebar
- **WHEN** the member activates the task-list section add action, enters a non-empty name, and presses Enter or moves focus away
- **THEN** the Desktop creates a private task list inline and opens its workbench without showing the full creation dialog

#### Scenario: Cancel sidebar task-list creation
- **WHEN** the member presses Escape in the sidebar task-list name input
- **THEN** the draft input closes and no task-list mutation is sent

#### Scenario: Open tasks assigned by the current user
- **WHEN** the user selects Assigned by me from Quick access
- **THEN** the Desktop shows accessible tasks whose current assignees exclude the current member and whose current assignment provenance includes the current member

#### Scenario: Restore a removed persisted destination
- **WHEN** persisted Desktop state contains Inbox, Trash, Archived lists, or an unknown section
- **THEN** the Desktop safely restores Today rather than rendering a hidden destination

#### Scenario: Keep Today and Activity headers focused
- **WHEN** the user opens Today or Activity
- **THEN** the Desktop does not show task creation actions in the page header
- **AND** Today does not show the priority or sort controls in that header

#### Scenario: Organize the Today action view
- **WHEN** the Today query returns accessible todo tasks that are overdue, due today, or start today
- **THEN** the Desktop renders a dedicated action view with mutually exclusive Overdue, Due today, and Starts today groups in that order
- **AND** a task matching multiple groups appears only in the first matching group
- **AND** the view shows loaded pending and overdue counts, task-list context, the current member's primary task relationship, assignees, and the relevant task time

#### Scenario: Complete a task from Today
- **WHEN** the user activates a Today task's completion control
- **THEN** the Desktop loads authoritative task permissions and membership before applying the existing multi-assignee completion behavior
- **AND** refreshes the Today query after a successful transition

### Requirement: Task priority single selection
The full task creation form, task detail, and enabled workbench priority column SHALL offer Low, Medium, and High as single-select choices. Existing unset priorities SHALL remain unset until a choice is made. Changing a saved task's priority SHALL require current task content-edit permission.

#### Scenario: Set an existing task's priority
- **WHEN** an authorized user selects a priority on an existing task
- **THEN** the Desktop saves the selected value and updates the task detail and workbench from server data

### Requirement: Group tasks by priority
The workbench grouping menu SHALL offer Priority in List and Board. It SHALL show High, Medium, Low, and No priority in that order without changing filters. Tasks SHALL appear in their current priority group, and quick creation within a group SHALL inherit its priority. The grouping choice SHALL persist with the workbench settings.

#### Scenario: Open the priority-grouped task list
- **WHEN** a user selects Priority grouping
- **THEN** each loaded task appears once under its current priority, including unset tasks in No priority
- **AND** the List toolbar's unguided New task action opens a draft in No priority

### Requirement: Aggregate task activity
The Desktop SHALL consume the server aggregate task-activity endpoint as one cursor-paginated timeline, SHALL keep server unread state authoritative, and SHALL NOT synthesize the timeline by issuing per-task activity requests. It SHALL present All and Unread filters, local-calendar time groups, an authoritative unread badge in the Tasks sidebar, single-event read actions, mark-all-through-sequence, task and task-list navigation, loading, empty, error, retry, and load-more states.

#### Scenario: Read and navigate an attention event
- **WHEN** an accessible unread attention event is shown and the user opens it
- **THEN** the Desktop marks the stable event ID read through the server
- **AND** opens the existing task detail using the immutable internal task ID
- **AND** refreshes both aggregate feed filters and the sidebar unread count

#### Scenario: Mark all currently visible activity read
- **WHEN** the user chooses Mark all as read
- **THEN** the Desktop sends the latest server sequence from the aggregate page
- **AND** does not locally mark a concurrently arriving greater sequence as read

#### Scenario: Open the event task list
- **WHEN** an accessible activity event contains task-list context and the user opens the list name
- **THEN** the Desktop opens that task list's existing workbench without treating it as a second task membership

#### Scenario: Read an activity timestamp
- **WHEN** the Desktop displays an activity event timestamp in local time
- **THEN** events on the current calendar day show hours and minutes only, and events on other days also show the date
- **AND** dates outside the current calendar year include the year

#### Scenario: Aggregate activity is unavailable
- **WHEN** the aggregate endpoint is unavailable or returns an invalid response
- **THEN** the Desktop displays the real error and Retry
- **AND** does not render a fabricated empty timeline or issue an N+1 fallback over tasks

#### Scenario: Activity target is no longer accessible
- **WHEN** the server returns a redacted event whose task is no longer accessible
- **THEN** the Desktop renders an unavailable placeholder without protected task or list content
- **AND** disables task and list navigation for that event

### Requirement: Task list and detail surfaces
The Desktop SHALL provide a paginated task list, inline permitted actions, and a detail drawer or direct route for task fields, comments, activity, and lifecycle actions.

#### Scenario: Open task detail
- **WHEN** a user clicks an accessible task title
- **THEN** the Desktop opens the task detail and renders each field as editable or read-only according to server authorization

### Requirement: Task collection workbenches
The Desktop SHALL render the same rich workbench for Assigned to me, Following, All tasks, Created by me, Assigned by me, and Completed, with exactly List and Board tabs persisted independently per ProductTask scope and section. List SHALL default to Task title, Assignee, Start time, Due time, Creator, Created time, Task ID, Priority, and Task list, with Priority immediately before Task list, title mandatory, and the remaining fields configurable. Board SHALL render horizontal lanes from the active workbench grouping and retain accessible complete and reopen actions without a task-card cancel action. Entering Board from No grouping SHALL select Custom in Assigned to me, Following, and specific task lists. The other system collections SHALL select Priority. Board grouping options SHALL include Task list, Creator, Start time, Due time, and Priority. Assigned to me, Following, and specific task lists SHALL offer Custom as the last option. Status, person, property, list, and time filters and sorting SHALL remain active in Board. Custom-group Board SHALL append a New group action that opens an inline name input and directly creates the group on Enter or blur; all other Board groupings SHALL hide this action.

Every Board lane SHALL end with a New task action. Activating it SHALL open an inline card with a title input and the same Due time picker used by List cells; Enter SHALL create the task with the lane's representable defaults and persist a custom-group assignment when applicable.

Each time a collection is opened, the Desktop SHALL populate its page semantics as ordinary editable initial filters. Assigned to me SHALL initially filter Assignee contains the current member. Following SHALL initially filter Follower contains the current member, Creator does not contain the current member, and Assignee does not contain the current member. All tasks SHALL initially have no person filter and all statuses. Created by me SHALL initially filter Creator contains the current member. Assigned by me SHALL initially filter Assignee does not contain the current member and Assigner contains the current member. Completed SHALL initially have no person filter and Completed status. The user MAY modify, remove, or clear any populated condition, and every change SHALL immediately affect the query until the collection is opened again.

#### Scenario: Open each task collection
- **WHEN** the user opens Assigned to me, Following, All tasks, Created by me, Assigned by me, or Completed
- **THEN** the Desktop shows the same List/Board workbench and visibly populates that collection's editable initial filters

When the user activates an editable Assignee cell, the List SHALL open a people picker with organization-member search, current-assignee indicators, and multi-select add/remove operations. For tasks and subtasks on a capable server, the footer SHALL show the current completion rule and let an authorized member manager switch between any-assignee and all-assignees completion. Member and permitted completion-rule changes SHALL use the latest version and permissions and preserve unrelated task fields and roles.

#### Scenario: Scan assignees in the task list
- **WHEN** a task row has assignees
- **THEN** the Assignee cell shows an avatar and nickname for one assignee, overlapping avatars for two to four assignees, or the first three avatars followed by a `+N` count for the rest when there are five or more assignees
- **AND** a tooltip on hover or keyboard focus shows every assignee nickname, including those represented by `+N`
- **AND** an assignee's avatar shows a completion badge only when that member has an individual completion record or is the sole assignee and recorded completion actor under `any_assignee`

#### Scenario: The creator completes a task assigned to someone else
- **WHEN** the creator has permission to complete an `any_assignee` task assigned to another member and marks it complete
- **THEN** the task shows as completed in the list and detail
- **AND** the assignee's avatar does not show a completion badge without their own completion record

Editable Start time and Due time cells SHALL open one calendar picker containing editable Start date and Due date rows. A date MAY be stored without a specific time and SHALL then render each date as a full-width row at day precision. Enabling Specific time SHALL split each populated row into date and time columns and render at minute precision. Clicking either date input SHALL make it the active calendar target, so the next calendar selection updates that field. Time selection SHALL use a compact single-column menu in 30-minute intervals. Start date SHALL remain optional. Due reminder SHALL default to empty. For a specific due time, reminder choices SHALL be 5, 15, or 30 minutes, 1 or 2 hours, or 1 day before due. For a date-only due value, reminder choices SHALL be 18:00 on the due date, 09:00 one day before, or 09:00 two days before. Time changes SHALL load the latest task and permission, use the latest optimistic version, and persist reminder changes through the task reminder API.

The Task list cell SHALL open a searchable multi-select list picker. Checking or unchecking a list SHALL change only its own filing. Inline list creation SHALL append the new list without replacing previous filings; failure SHALL preserve the displayed selection.

#### Scenario: Open a task list from the sidebar
- **WHEN** the user selects an active task list in the Tasks sidebar
- **THEN** the Desktop opens an independent shared-workbench page titled with the task-list name, constrains its task query to that selected list, and initially uses Custom grouping with Default group and New group affordances

Each task-list page SHALL persist its workbench settings independently from system collections and from every other task list.

While a task-list page is active, no system collection navigation item SHALL remain selected. The active task-list item SHALL use the same selected background, text color, and font emphasis as selected system navigation items.

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
The Assigned to me tool area SHALL expose exactly New task and New task list. New task SHALL open full creation. New task list SHALL expand the sidebar when needed and open the shared inline task-list name input with private defaults. It SHALL expose mutation errors without leaking late results across scope changes.

#### Scenario: Open the task creation menu
- **WHEN** the user opens the Assigned to me creation menu
- **THEN** the Desktop offers exactly New task and New task list

### Requirement: Multi-assignee completion behavior
The leading completion control in a List row, including expanded subtasks, SHALL reflect the task status. For multiple assignees under the any-assignee rule the control SHALL toggle the task status directly, with no avatar checkmarks. Under the all-assignees rule it SHALL offer personal completion or personal reopening according to the caller’s progress, and a whole-task action. Completing for everyone while assignees remain unfinished and reopening for everyone SHALL require confirmation. Canceling SHALL leave all progress intact. Personal progress appears on assignee avatars. The task detail’s Complete my part action SHALL use the signed-in assignee’s own completion record and the authoritative version.

#### Scenario: Old server reports whole-task completion for a multi-assignee task
- **WHEN** a personal completion action reads an authoritative task response reporting `any_assignee` for a task with multiple assignees without the `multiAssigneePolicySupported` capability
- **THEN** the Desktop explains that individual completion is not supported for the task and sends no completion mutation

#### Scenario: Complete one portion of an all-assignees task
- **WHEN** the current assignee completes an `all_assignees` task while another assignee remains incomplete
- **THEN** the Desktop displays that the current assignee's portion is complete, leaves the task in the todo presentation, and does not send the same completion again
- **AND** the menu offers Reopen my part to the assignee who completed their part while others are still working

### Requirement: Task creation surfaces
The Desktop SHALL support full creation in a compact dialog with a fixed, viewport-bounded height with a borderless title, assignees, a custom group for the selected task list, Today/Tomorrow/Other-time due-date actions, a searchable or creatable task list, description, and followers. The description editor SHALL be expanded by default at a fixed 168px height without changing the fixed 460px outer dialog height. Top and bottom dialog padding SHALL remain compact. Hovering or keyboard-focusing the leading assignee, due-time, task-list, or description icon in either the creation dialog or task detail panel SHALL show a tooltip identifying that field. Activating description SHALL expand an editor with a bottom toolbar for bold, strikethrough, italic, underline, numbered list, bulleted list, quote, link, emoji, mention, and image markup; applied markup SHALL be included in the submitted description. The follower affordance SHALL remain left-aligned at the bottom-left of the dialog across responsive breakpoints, with its leading icon adjacent to its label or selected-member summary and without a trailing dropdown arrow. The primary submit button SHALL be labeled Create. New tasks SHALL leave assignees and followers empty until the user explicitly selects them. Selecting any member other than the signed-in member SHALL automatically use members visibility; otherwise creation SHALL remain private. Creating a list in the dialog SHALL persist the list before submitting its returned ID with the task. Creating or choosing a non-default custom group SHALL persist that group in the selected task list settings and assign the created task through `customGroupAssignments`. Empty assignee cells SHALL present an add-person affordance, while empty start-time and due-time cells SHALL present muted calendar affordances instead of textual unavailable values.

#### Scenario: Create a fully attributed task
- **WHEN** the user chooses assignees, followers, a non-default custom group, a due time, and a task list in the full creation dialog
- **THEN** the Desktop submits the selected member roles, due time, and list ID with the task
- **AND** stores the created task ID under the selected custom group

### Requirement: Task detail work panel
The detail title and description SHALL autosave when the title loses focus or focus leaves the complete description editor. Activating another field selector SHALL therefore save pending content first. The detail description SHALL reuse the creation dialog’s 168px rich-text editor and toolbar. Moving focus within that editor, including to a formatting action, SHALL NOT save prematurely. The panel SHALL NOT show a separate Save button.

The Desktop SHALL open a fixed right-side task detail panel. The panel SHALL render as an opaque isolated surface above workbench sticky headers and rows so underlying borders and content cannot overlap or show through it. Its top-left control SHALL complete a todo task or reopen a completed task, and its top-right Follow control SHALL add or remove the signed-in member as a follower. The detail body SHALL expose the title, assignees, due time, and visible list filings. The detail SHALL keep system collection grouping separate from the groups shown for individual filings. Subtasks and attachments are out of scope for this requirement.

Task-row separators in List view SHALL be inset from both the title-side content boundary and the right table edge. While the detail panel is open, clicking outside the panel SHALL close it and SHALL NOT activate an underlying task or workbench control.

The panel SHALL separate task fields from comments with a divider, render comment author, timestamp, and body, and keep a comment composer near the panel bottom. The composer SHALL offer simple bold, emoji, mention, and image markup actions and submit the resulting text through the existing task comment API. Enter SHALL submit a non-empty comment, Shift+Enter SHALL insert a line break, and Enter during IME composition SHALL NOT submit. The bottom row SHALL display follower avatars and count plus an add control that supports adding and removing organization members. Adding another member to a private task SHALL use members visibility when authorized.

#### Scenario: File a task into multiple lists from detail
- **WHEN** the user opens task detail
- **THEN** each visible filing has its own row with the list name and, for active resolved lists, a list-scoped local group selector and a remove action
- **AND** the separate add-list picker searches or creates lists without offering existing filings or archived lists as destinations
- **AND** adding or removing a filing uses existing permissions and audience confirmation, affects only that list, and preserves the task and all other filings
- **AND** choosing or creating a local group in one list does not change another list's group or send a task mutation

#### Scenario: Scan assignee counts and completion in task detail
- **WHEN** a user opens a task with assignees
- **THEN** the detail uses the same avatar, nickname, overlap, overflow and completion-badge rules as the List cell
- **AND** for multiple assignees the avatar group shows the total assigned or, once there is completion progress, the completed count out of the total, including assignees represented by `+N`
- **AND** hovering or focusing the group shows all assignee nicknames, including in read-only detail, without exposing the edit picker to users who cannot assign

#### Scenario: Edit formatted descriptions and comments
- **WHEN** a user opens task detail
- **THEN** the description starts as a formatted preview or an add-description prompt, and an authorized user can activate it to edit in place
- **AND** the comment composer starts on one row and its Aa toggle shows or hides formatting tools without losing the draft or selection
- **AND** both editors display formatting directly and support links, emoji selection, and searchable organization-member mentions without selecting the same member twice in one draft

#### Scenario: Follow and manage task followers
- **WHEN** the signed-in member activates Follow or changes the bottom follower selection
- **THEN** the Desktop persists the complete follower relationship set while retaining non-follower task members
- **AND** refreshes the visible follower avatars and count from the authoritative task result

#### Scenario: Comment from the task detail panel
- **WHEN** the user enters a comment, optionally applies simple markup, and submits it
- **THEN** the Desktop sends the resulting body through the task comment API
- **AND** refreshes the task activity query without allowing a late result from another task to clear the current input

Assigned to me List SHALL also support title-only inline creation. Activating New task in the list toolbar SHALL insert and focus an input row before the first task row, while activating New task in the final list row SHALL insert and focus an input row immediately below that trigger row.

When an inline title input loses focus, the Desktop SHALL cancel the draft if its trimmed title is empty, or submit it as if Enter had been pressed when the trimmed title is non-empty. Enter and blur handling SHALL not create the same draft more than once.

Changing the Assigned to me status filter SHALL preserve the mounted workbench and currently rendered task rows while the replacement query is pending. The Desktop SHALL use a local, non-blocking loading indicator instead of replacing the page with a loading state.

The Assigned to me sort menu SHALL present each supported sort field as its own row with ascending and descending controls on that row. Choosing a field without an explicit direction SHALL default that field to descending order, while the active field and direction remain visually identifiable.

The sort menu SHALL expose start time, due time, created time, updated time, and completed time. Priority remains a task property and filter but SHALL NOT appear as a sort-menu field. Start-time sorting SHALL request updated-time order and sort the currently loaded tasks locally with null values last. Completed-time sorting SHALL request server order across cursor pages; if a legacy server rejects the sort on the first page, the Desktop SHALL paginate in updated-time order and sort the loaded tasks locally with null values last.

Without a saved sort preference, All tasks, Created by me, and Assigned by me SHALL default to due time descending, and Completed SHALL default to completion time descending. These defaults SHALL sort outer rows only and SHALL NOT override a saved sort preference or change the order of expanded subtasks.

The active sort field label and only its currently applied direction control SHALL use the accent color without a checkmark or persistent row background. The active field's opposite direction control SHALL remain hidden until that row is pointer-hovered. Inactive fields SHALL hide both direction controls until their row is pointer-hovered, including when the menu automatically focuses its first item, and row backgrounds SHALL appear only on hover.

The List grouping menu SHALL support no grouping, creator, start time, due time, and priority. Opening List with a saved Task list grouping SHALL select No grouping and retain the saved filters. Assigned to me, Following, and workbenches opened from a specific task list SHALL offer Custom group as the last grouping option. Custom grouping SHALL place every loaded task in a stable Default group, including an empty Default group when no tasks are loaded. The Default group SHALL expose hover/focus actions for renaming and a visible but disabled delete action; its renamed display label SHALL persist in the current ProductTask scope. Custom grouping SHALL also expose a trailing New group action that creates persisted empty display groups through an inline title input. Additional custom groups SHALL support rename and delete actions. A task created from an additional custom group's header or trailing action SHALL remain assigned to that display group after creation and refresh; deleting the group SHALL clear its display assignments so those tasks return to Default group. Start-time grouping SHALL present Started, Today, Tomorrow, Next 7 days, Later, and Unscheduled in that order. Due-time grouping SHALL present Overdue, Today, Tomorrow, Next 7 days, Later, and Unscheduled in that order. Today and future buckets SHALL use the user's local calendar-day boundaries; Next 7 days includes local dates from the day after Tomorrow through seven days after Today.

Every visible group SHALL render a header with its task count and an independent disclosure control. Groups with tasks start expanded, empty time groups start collapsed, and the user MAY expand or collapse any group without changing filters or task data. Expanding an empty group SHALL reveal its body rather than immediately collapsing it again.

Every expanded group SHALL end with an inline New task action. A task created from a start-time or due-time group SHALL inherit a representative local timestamp that remains in that bucket, while Unscheduled SHALL leave the corresponding timestamp empty. Creator grouping SHALL preserve the authoritative current creator rather than impersonating the displayed creator group.

Each group header SHALL reveal a plus action on pointer hover or keyboard focus. Activating it SHALL expand the group if needed and open that group's inline task draft as the first row before existing tasks. The trailing New task action SHALL continue to open the draft after existing tasks. When Start time or Due time grouping is active, the workbench toolbar's New task action SHALL open a draft in the Today group with a corresponding Today start or due time.


The Assigned to me filter control SHALL open a wide condition-builder panel with a header, clear action, ordered When/And condition rows, removable rows, and an Add condition action. Its field selector SHALL list assignee, start time, due time, completed time, assigner, follower, creator, created time, and updated time in that order. Assignee, assigner, follower, and creator conditions SHALL support contains, does not contain, is empty, and is not empty operators. Contains and does-not-contain SHALL select one or more people from the current organization's member directory and display member avatars and names; empty operators SHALL not display a value selector. Active conditions SHALL contribute to the filter badge and SHALL map to the corresponding server list-query parameters.

Creator group headers SHALL display the creator avatar and display name with the task count. Creator groups SHALL NOT expose header plus actions or per-group trailing New task rows because creator identity is authoritative. The toolbar New task action SHALL instead open its draft in the signed-in member's creator group, creating that group header when the loaded page has no current task from that member.

#### Scenario: Create from Assigned to me
- **WHEN** the user opens New task from Assigned to me
- **THEN** the Desktop leaves the assignee empty and defaults the selected sidebar task list when present

#### Scenario: Assign another member to a private task
- **WHEN** the user selects an assignee other than themselves while visibility is Private
- **THEN** the Desktop switches visibility to Members or presents clear validation that prevents submission

### Requirement: Personal manual task ordering
Assigned to me, Following, and specific task lists SHALL show Custom drag order first in the sort menu. Desktop SHALL remember this order locally per user, organization, server and workbench without changing the tasks themselves.

#### Scenario: Reorder outer task rows
- **WHEN** a user has selected Custom drag order and hovers an outer task row in an eligible List or focuses its handle with the keyboard
- **THEN** Desktop reveals the row-leading handle without shifting adjacent controls
- **AND** a drop or arrow-key move within the same group changes only the manual order without changing group membership or nested subtask order

#### Scenario: Keep the selected sort within a group
- **WHEN** the selected sort is not Custom drag order
- **THEN** a same-group drop or arrow-key action SHALL NOT change task order or switch the sort
- **AND** List SHALL expose the hover/focus drag handle only if another group is available as a valid destination

#### Scenario: Move a task to another custom group
- **WHEN** a user drops an outer task on a different custom group's header or outer row in List, or drops a card in a different custom lane in Board
- **THEN** Desktop SHALL persist only the local custom-group assignment and order tasks in the destination by the current sort
- **AND** returning a task to Default SHALL clear the assignment without changing the selected sort, direction, saved manual order, task data, or nested subtask order

#### Scenario: Filter and load more with a saved order
- **WHEN** the user filters or loads more tasks while using custom order
- **THEN** ranked tasks keep their saved relative order and unranked loaded tasks follow them in server order
- **AND** filtering out a task does not discard its saved rank

### Requirement: Move tasks between editable groups
List and Board SHALL accept an outer task from a different group on the destination header, outer row, or lane, including empty groups. A successful move SHALL keep the selected sort, direction, and saved manual ranks. Creator groups SHALL NOT allow cross-group moves.

#### Scenario: Move to a priority, start-time, or due-time group
- **WHEN** the user drops a task into a different priority or time group
- **THEN** Desktop SHALL change only the corresponding field using existing permission checks and optimistic versioning; No priority and Unscheduled SHALL clear the corresponding field
- **AND** Desktop SHALL NOT move the task if the change is rejected, including an invalid start/due combination

#### Scenario: Move a task between list groups
- **WHEN** the task server supports atomic filing moves and both affected lists, if any, are active and writable
- **THEN** Desktop SHALL move only the filing from which the task was dragged, preserving other filings, and ask for confirmation if adding the destination would grant shared access
- **AND** Desktop SHALL NOT drop into No task list while any other visible filing would remain, and SHALL NOT replace the move with separate add/remove calls on an older server

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
