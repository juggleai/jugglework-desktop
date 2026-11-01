## ADDED Requirements

### Requirement: Cloud-authoritative tasks
The system SHALL store private and collaborative tasks in JuggleWork Server as the sole write authority and SHALL NOT require an Agent or AI provider for core task operations.

#### Scenario: Create a task without an Agent
- **WHEN** an authenticated organization member creates a task while no Agent is available
- **THEN** the server creates the task and returns its stable ID and version

### Requirement: Task fields and lifecycle
The system SHALL support a required title, optional description, priority, start time, due time, assignees, followers, visibility, list membership, reminder, and `todo`, `completed`, and `canceled` states.

#### Scenario: Create an unassigned task
- **WHEN** a member creates a task without assignees
- **THEN** the task remains valid, appears in the creator's inbox, and does not appear in any assigned-to-me view

#### Scenario: Complete a multi-assignee task
- **WHEN** any assignee completes a task with multiple assignees
- **THEN** the single task state becomes completed for every assignee and the system records the actor and completion time

### Requirement: Task visibility and authorization
The system SHALL support `private`, `members`, and `organization` visibility and SHALL authorize every read and mutation using the current organization member identity and task/list roles.

#### Scenario: Private task isolation
- **WHEN** a member other than the creator searches for or directly requests a private task
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

### Requirement: Soft deletion and recovery
The system SHALL soft-delete tasks for 30 days and SHALL allow only the original creator or current list administrator to read the tombstone and restore it.

#### Scenario: Restore task
- **WHEN** an authorized restorer restores a task within 30 days
- **THEN** the task retains its original ID, members, comments, links, and activity history

### Requirement: Task activity
The system SHALL append immutable task events for creation, assignment, visibility, time, state, list, comment, reminder, deletion, and restoration changes.

#### Scenario: Record assignment
- **WHEN** a task administrator adds an assignee
- **THEN** the system records an assignment event with the actor, affected member, task version, and timestamp
