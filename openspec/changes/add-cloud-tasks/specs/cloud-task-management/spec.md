## ADDED Requirements

### Requirement: Cloud-authoritative tasks
The system SHALL store tasks in JuggleWork Server as the sole write authority and SHALL NOT require an Agent or AI provider for core task operations. Collaboration is authorization on the same task model, not a different task type.

#### Scenario: Create a task without an Agent
- **WHEN** an authenticated organization member creates a task while no Agent is available
- **THEN** the server creates the task and returns its stable internal ID, organization-scoped display number, and version

### Requirement: Task fields and lifecycle
The system SHALL support a required title, optional description, priority, start time, due time, assignees, followers, visibility, list membership, reminders, and `todo`, `completed`, and `canceled` states. Tasks with multiple assignees SHALL default to `all_assignees` until a member manager explicitly selects a completion rule. The API SHALL report the effective rule and retain existing rules for zero or one assignee.

#### Scenario: Any assignee can finish the task
- **WHEN** the first current assignee completes their part under `any_assignee`
- **THEN** the task is completed

#### Scenario: Create an unassigned task
- **WHEN** a member creates a task without assignees
- **THEN** the task remains valid, appears in the creator's inbox, and does not appear in any assigned-to-me view

#### Scenario: Mark a shared task complete from List
- **WHEN** an authorized editor uses the task row’s whole-task completion control
- **THEN** the task changes to completed and records the actor and marks every outstanding assignee complete under the all-assignees rule

#### Scenario: Each assignee completes only their portion
- **WHEN** a current assignee completes a task using the effective `all_assignees` rule
- **THEN** the system records only that assignee's completion while keeping the task in `todo` until every current assignee has completed their portion
- **AND THEN** the final assignee completion changes the single task state to `completed`

#### Scenario: Prevent proxy or duplicate completion
- **WHEN** a non-assignee or an already-completed assignee tries to record individual completion on a multi-assignee task
- **THEN** the system rejects the operation without changing completion progress, even for the creator or a list editor who is not assigned

#### Scenario: Start a new completion round
- **WHEN** a task is reopened for everyone or an open task’s assignee set or effective completion policy changes
- **THEN** the system clears per-assignee progress; changing only a stored policy that does not affect the effective rule does not clear progress

### Requirement: Task visibility and authorization
The system SHALL support `private`, `members`, and `organization` as compatibility values for direct visibility and SHALL authorize every read and mutation using the current organization member identity and the direct and list-derived grants defined in `task-list-derived-access`.

#### Scenario: Private task isolation
- **WHEN** a member other than the creator, without a list grant, searches for or directly requests a task that has not been directly shared
- **THEN** the system denies access and does not disclose task fields

#### Scenario: Members visibility
- **WHEN** a task uses members visibility
- **THEN** only its creator, assignees, followers, viewers, and authorized list members can read it

### Requirement: Optimistic concurrency and idempotency
The system SHALL use task versions for mutations and idempotency keys for retryable writes.

#### Scenario: Reject stale update
- **WHEN** a client updates a task with an outdated expected version
- **THEN** the server rejects the update with a conflict result and preserves the newer data

#### Scenario: Retry task creation
- **WHEN** a client retries creation with the same idempotency key
- **THEN** the server returns the original task instead of creating a duplicate

### Requirement: System task views
The system SHALL provide permission-filtered queries for today, inbox, assigned-to-me, created-by-me, following, all, completed, and trash.

#### Scenario: Query today
- **WHEN** a member queries today in their timezone
- **THEN** the result contains accessible todo tasks that start today, are due today, or are overdue, ordered with overdue tasks first

### Requirement: Cloud reminders
The system SHALL schedule reminders in the cloud, allow at most one active reminder per task recipient in MVP, and cancel obsolete reminders when task state or timing changes.

#### Scenario: Reminder for unassigned task
- **WHEN** an unassigned task reminder becomes due
- **THEN** the system delivers it to the creator exactly once as a business event

### Requirement: Permanent deletion and legacy recovery
New deletes SHALL physically remove the task, without creating a tombstone, entering Trash or supporting restore. The existing `canDelete`, `expectedVersion` and `idempotencyKey` checks SHALL apply. Previously soft-deleted tasks SHALL retain their original 30-day window without a bulk purge. Only the original creator or an administrator with a retained legacy primary-list grant may read and restore those tombstones; an enabled filing alone grants no such access.

#### Scenario: Delete an active task
- **WHEN** an authorized member deletes the current version or replays that same successful request
- **THEN** the server returns an empty `204 No Content`; reads and restore cannot retrieve the task. Children and external attachment files survive the deletion

#### Scenario: Restore a legacy soft-deleted task
- **WHEN** an authorized restorer restores a legacy tombstone within its original 30-day window
- **THEN** the task retains its original ID, members, comments, list relationship, and activity history

### Requirement: Task activity
The system SHALL append immutable task events for creation, assignment, visibility, time, state, list, comment, reminder and legacy restoration changes. Permanent deletion SHALL NOT leave a readable task history or require a deletion event as a substitute for the scoped receipt.

#### Scenario: Record assignment
- **WHEN** a task administrator adds an assignee
- **THEN** the system records an assignment event with the actor, affected member, task version, and timestamp

The system SHALL expose an organization-scoped aggregate task activity timeline backed by recipient projections, opaque cursor pagination, stable event IDs, monotonic recipient sequences, and server-authoritative multi-device read state. Recipient projection SHALL include the union of the task creator, assignees, followers, explicit Viewers, and related task-list members, but SHALL NOT broadcast every event solely because a task has organization visibility. The system SHALL re-evaluate access when reading projected events and SHALL NOT disclose protected historical task, comment, list, actor, or timing content after access is lost.

#### Scenario: Page the aggregate activity timeline
- **WHEN** an authenticated member requests aggregate task activity with a limit and optional opaque cursor
- **THEN** the system returns accessible recipient events in descending sequence order
- **AND** returns the next cursor, whether more events exist, the authoritative unread count, and the latest visible sequence

#### Scenario: Mark activity through a stable sequence
- **WHEN** a member marks all activity read through a visible sequence
- **THEN** the system records that read boundary for the member across devices
- **AND** events arriving later with a greater sequence remain unread

#### Scenario: Avoid notifying the actor
- **WHEN** a member causes a task event for which they are also a recipient
- **THEN** the event may remain visible in their aggregate history
- **AND** the system does not count it unread or notify that same member
