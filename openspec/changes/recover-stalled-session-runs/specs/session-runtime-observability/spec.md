# Delta: Session runtime observability

## ADDED Requirements

### Requirement: Authoritative idle terminalizes stale tool projections

When an authoritative snapshot reports a session as idle, the client SHALL NOT
render any input-streaming or input-available tool part as actively running.
Such parts SHALL be projected as interrupted and included in completion
diagnostics without modifying the stored OpenCode transcript.

#### Scenario: Child task loses its terminal event

- **GIVEN** a parent message contains a running task tool part
- **AND** the authoritative session snapshot reports idle
- **WHEN** the snapshot is projected into UI messages
- **THEN** the task tool is shown as interrupted rather than running
- **AND** the run is diagnosed as incomplete

### Requirement: Reconnect performs authoritative reconciliation

After an event stream reconnects, the client SHALL fetch a fresh session
snapshot and active-run state before relying on further incremental events.

#### Scenario: Idle event was lost during disconnect

- **GIVEN** the event stream disconnects while a run appears active
- **AND** the engine becomes idle before reconnection
- **WHEN** the event stream reconnects
- **THEN** the client refreshes the authoritative snapshot and active-run state
- **AND** stale running projections are terminalized

### Requirement: Lifecycle journal excludes user content

The server SHALL persist bounded run lifecycle events containing correlation
metadata and timestamps, and SHALL NOT persist prompt text, tool input, file
contents, credentials, or model output in that journal.

#### Scenario: Run lifecycle is recorded

- **GIVEN** a session run starts, makes progress, and reaches a terminal state
- **WHEN** the lifecycle journal is inspected
- **THEN** it contains the run identity, generation, event names, and timestamps
- **AND** it contains no prompt, tool input, file content, credential, or model output

### Requirement: Delegated child activity preserves the parent run

While a parent task tool waits for delegated child sessions, recent child model
or tool activity SHALL count as progress for the parent and SHALL NOT cause the
root session to be aborted.

#### Scenario: Parent is quiet while a child is active

- **GIVEN** a parent contains an in-flight task tool with a child session ID
- **AND** the parent has produced no direct output for the stall threshold
- **AND** the child has recent model or tool activity
- **WHEN** the stall watchdog runs
- **THEN** the parent progress clock is refreshed from the child activity
- **AND** neither the parent nor the child is aborted

### Requirement: Confirmed delegated stalls recover only the child

The watchdog SHALL target only a delegated child whose own no-progress threshold
and grace period have expired. It SHALL verify the child belongs to the parent
and SHALL NOT abort the root session.

#### Scenario: One sibling stalls while another completes

- **GIVEN** a parent is waiting for multiple delegated children
- **AND** one child completed successfully
- **AND** another verified child remains busy without progress beyond both thresholds
- **WHEN** recovery runs
- **THEN** only the stalled child receives an abort request
- **AND** the parent remains active to consume completed results and the child cancellation

#### Scenario: Child identity or ownership is uncertain

- **GIVEN** an in-flight task lacks a child session ID or names a child owned by another parent
- **WHEN** recovery runs
- **THEN** no destructive recovery is performed
