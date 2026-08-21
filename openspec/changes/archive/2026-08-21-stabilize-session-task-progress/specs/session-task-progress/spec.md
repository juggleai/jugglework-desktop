## Purpose

Provide dependable task-progress presentation for each conversation so users can trust whether planned work is active, incomplete, or finished across workspace and connection transitions.

## ADDED Requirements

### Requirement: Active task progress remains available
The system SHALL keep a session's non-empty task progress visible while that session has an active run, unless a higher-priority interaction temporarily occupies the same presentation area.

#### Scenario: Long-running task without todo updates
- **WHEN** a session remains active for longer than the task-progress cache lifetime without emitting another todo update
- **THEN** its existing task progress remains available and visible

#### Scenario: Remote workspace progress
- **WHEN** a remote workspace emits progress for its runtime session identity
- **THEN** the corresponding session surface displays that progress

### Requirement: Progress is scoped to the rendered session
The system SHALL resolve progress independently for every rendered session surface.

#### Scenario: Split panes show independent progress
- **WHEN** primary and secondary panes render different sessions with different todo state
- **THEN** each pane displays only its own session's progress

### Requirement: Newer progress wins over stale reads
The system SHALL NOT replace progress received from a newer live event with an older snapshot response.

#### Scenario: Snapshot overlaps live update
- **WHEN** a snapshot request starts before a live todo update and returns after that update
- **THEN** the live todo state remains authoritative

### Requirement: Terminal task progress has clear semantics
The system SHALL distinguish active or incomplete work from successfully terminal progress.

#### Scenario: Successful completion
- **WHEN** a run becomes idle and every non-empty todo is completed or cancelled
- **THEN** the system briefly acknowledges final progress and then hides the progress panel

#### Scenario: Incomplete termination
- **WHEN** a run becomes idle with at least one pending or in-progress todo
- **THEN** the progress remains visible as incomplete work rather than appearing active

#### Scenario: New run after terminal state
- **WHEN** a new run starts in a session whose prior progress was hidden after successful completion
- **THEN** new or reset todo progress can become visible normally

### Requirement: Terminal events cannot be undone by prompt acceptance
The system SHALL NOT mark a session active solely because a prompt-acceptance response arrives after authoritative evidence that the submitted run already ended.

#### Scenario: Fast task completes before acceptance response
- **WHEN** a task emits its final response and idle state before the send request resolves
- **THEN** processing the successful send response does not restore a busy or waiting state
