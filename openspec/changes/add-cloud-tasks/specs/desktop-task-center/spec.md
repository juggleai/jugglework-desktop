## ADDED Requirements

### Requirement: Independent task navigation
The Desktop SHALL provide a dedicated Tasks item in the left vertical navigation that opens `/tasks` regardless of Agent or AI provider availability.

#### Scenario: Open task center without AI provider
- **WHEN** a signed-in user clicks Tasks without a configured AI provider
- **THEN** the task center opens and supports core task interactions

### Requirement: Task information architecture
The Desktop SHALL provide task secondary navigation for Today, Inbox, Assigned to me, Created by me, Following, Activity, All tasks, Completed, Trash, archived lists, and task lists.

#### Scenario: Open inbox
- **WHEN** the user selects Inbox
- **THEN** the Desktop shows accessible todo tasks created by the user that do not belong to a list

### Requirement: Task list and detail surfaces
The Desktop SHALL provide a paginated task list, inline permitted actions, and a detail drawer or direct route for task fields, source, comments, activity, and lifecycle actions.

#### Scenario: Open task detail
- **WHEN** a user clicks an accessible task title
- **THEN** the Desktop opens the task detail and renders each field as editable or read-only according to server authorization

### Requirement: Multi-assignee completion confirmation
The Desktop SHALL explicitly warn that completing a task with multiple assignees completes it for everyone.

#### Scenario: Complete multi-assignee task
- **WHEN** an authorized user chooses to complete a task with more than one assignee
- **THEN** the Desktop requires confirmation before sending the completion mutation

### Requirement: Task creation surfaces
The Desktop SHALL support title-only quick creation, full creation, list-scoped creation, and IM-message creation, with no assignee required.

#### Scenario: Title-only creation
- **WHEN** a user submits a non-empty title from quick create
- **THEN** the Desktop creates a private unassigned task and displays it in the appropriate views

### Requirement: Conflict and connectivity states
The Desktop SHALL expose loading, empty, error, forbidden, offline, and optimistic-concurrency conflict states without silently overwriting cloud data.

#### Scenario: Concurrent edit conflict
- **WHEN** an update is rejected because the task version is stale
- **THEN** the Desktop preserves the user's draft and offers to load the latest task before reapplying changes
