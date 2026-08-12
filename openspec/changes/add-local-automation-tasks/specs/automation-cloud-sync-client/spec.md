## ADDED Requirements

### Requirement: Local-workspace automation authority

While workspace selection only supports local workspaces, creating, editing, pausing, deleting, scheduling, and running an automation SHALL persist exclusively in local runtime SQLite. Cloud availability MUST NOT block local scheduling, local session creation, local MCP use, run-history updates, or completion notifications.

#### Scenario: Cloud is offline during task creation

- **WHEN** the user saves a valid local-workspace automation while the cloud cannot be reached
- **THEN** the task is created locally and becomes schedulable
- **AND** no cloud sync state is displayed

#### Scenario: A local-only task becomes due

- **WHEN** a local-workspace automation reaches its due time
- **THEN** the local run executes normally and its history is stored locally
- **AND** no remote automation request is required

### Requirement: No remote synchronization for local workspaces

The Desktop MUST NOT call remote automation capability, definition, run, or mirror-list APIs for local-workspace automations. Local definition and run mutations MUST NOT enqueue cloud outbox records. Upgrading from a build that queued such records SHALL clear the legacy queue and normalize compatible local rows without deleting definitions or run history.

#### Scenario: Create and execute a local-workspace automation

- **WHEN** a user creates or runs an automation associated with a local workspace
- **THEN** its definition and run history are persisted locally
- **AND** no remote automation synchronization request is made
- **AND** the outbox remains empty

#### Scenario: Upgrade with legacy pending mutations

- **WHEN** the local database contains automation outbox rows from an earlier build
- **THEN** migration removes those outbox rows
- **AND** preserves all task definitions and run history

### Requirement: No cloud synchronization presentation

The current local-workspace task and run lists MUST NOT display `pending`, `synced`, `error`, or cross-device mirror states. Execution errors and lifecycle states remain visible because they describe local behavior rather than cloud delivery.

#### Scenario: View local run history

- **WHEN** the user opens the run-history list
- **THEN** each item shows its execution state and any sanitized execution error
- **AND** no cloud synchronization label or warning appears

### Requirement: Stable local executor binding

Every local-workspace automation SHALL remain bound to a stable local Desktop installation id. The id MUST NOT be regenerated on ordinary restart or upgrade and SHALL continue to identify which local runtime owns scheduling.

#### Scenario: Restart the Desktop

- **WHEN** the application restarts or upgrades normally
- **THEN** existing local automations retain the same local executor installation id
- **AND** remain eligible for the same local scheduler

### Requirement: Remote automation is a deferred capability

Remote-workspace automation, enrolled cloud executor identity, stable-envelope upload, cross-device mirrors, remote sync health, and run-bound cloud connector scope SHALL be implemented together in a future change. The Desktop MUST NOT enable those behaviors merely because passive server endpoints exist.

#### Scenario: Server exposes automation mirror endpoints

- **WHEN** the current Desktop discovers that the server has automation mirror APIs
- **THEN** local-workspace automations remain local-only
- **AND** the Desktop does not start a cloud sync coordinator
