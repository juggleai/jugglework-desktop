## ADDED Requirements

### Requirement: Task lists
The system SHALL allow organization members to create task lists with a name, description, visual marker, visibility, administrators, members, and archived state.

#### Scenario: Create private list
- **WHEN** a member creates a list without sharing it
- **THEN** the list is private and the creator becomes its administrator

### Requirement: Single list membership
The system SHALL allow a task to belong to at most one task list in MVP.

#### Scenario: Move task between lists
- **WHEN** an authorized member moves a task to a different list
- **THEN** the previous list relationship is replaced and a task event is recorded

### Requirement: List-derived authorization
The system SHALL grant task access from current list membership and SHALL revoke only that derived access when a member leaves the list or the task leaves the list.

#### Scenario: Remove list member
- **WHEN** an administrator removes a list member who has no other task role
- **THEN** that member immediately loses access to member-visible tasks in the list

### Requirement: Private task sharing confirmation
The system SHALL prevent a private task from entering a shared list until an authorized administrator confirms changing the task to members or organization visibility.

#### Scenario: Add private task to shared list
- **WHEN** a user selects a shared list for a private task
- **THEN** the system requires explicit visibility confirmation before moving the task

### Requirement: Archive and restore lists
The system SHALL allow list administrators to archive and restore lists without deleting their tasks.

#### Scenario: Archive list
- **WHEN** an administrator archives a list
- **THEN** the list disappears from default navigation while its tasks and permissions remain intact
