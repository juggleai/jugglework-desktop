## ADDED Requirements

### Requirement: Create task from IM message
The system SHALL allow an authorized IM user to create a task from a text message without using an Agent and SHALL preserve a source reference independent of the task lifecycle.

#### Scenario: Create from text message
- **WHEN** a user selects Create task on an accessible text message and confirms the form
- **THEN** the system creates a members-visible task with no default assignee and links the source conversation and message IDs

### Requirement: Source permission isolation
The system SHALL authorize Task access and source IM message access independently.

#### Scenario: User leaves source group
- **WHEN** a task member no longer has access to the source group
- **THEN** the user can continue using the task but sees an inaccessible-source state and cannot retrieve the original message

#### Scenario: Source message is deleted
- **WHEN** the source message is deleted or recalled
- **THEN** the task remains and the source reports deleted without returning protected message content

### Requirement: Source-owned and task-owned content
The system SHALL retain user-confirmed task title, description, and explicitly added attachments as task-owned content while treating message previews and context as source-owned data.

#### Scenario: Delete source after task creation
- **WHEN** a source message is deleted after the user confirmed a task title
- **THEN** the confirmed task title remains while source preview content stops being returned

### Requirement: Permission-safe task cards
The system SHALL prevent task cards from exposing task fields to unauthorized chat recipients.

#### Scenario: Send to mixed-permission group
- **WHEN** a task is sent to a conversation containing unauthorized members without expanding access
- **THEN** the system sends a restricted card that contains no title, assignee, due time, list, or description

### Requirement: Viewer access requests
The system SHALL allow recipients of restricted cards to request access and SHALL allow the creator or list administrator to approve the requester as a Viewer.

#### Scenario: Approve access request
- **WHEN** a task administrator approves a valid access request
- **THEN** the requester becomes a read-only Viewer and receives a result notification

### Requirement: Task assistant notifications
The system SHALL emit permission-safe task assistant messages for assignment, following, mentions, due-time changes, reminders, overdue tasks, completion, reopening, and cancellation according to notification policy.

#### Scenario: Notify new assignee
- **WHEN** a member is assigned to a task
- **THEN** the task assistant sends one deduplicated notification with an authorized open-task action
