# session-task-progress Specification

## Purpose

Provide dependable task-progress presentation for each conversation so users can trust whether planned work is active, incomplete, or finished across workspace and connection transitions.

## Requirements

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

### Requirement: New task submission resets previous progress
The system SHALL clear a session's displayed task progress when the user submits a new task in that session, before progress for the new run arrives.

#### Scenario: Submit after incomplete work
- **WHEN** a session still displays pending or in-progress items from an earlier task and the user submits a new task
- **THEN** the earlier task progress is removed from above the composer immediately

#### Scenario: Older snapshot returns after reset
- **WHEN** a snapshot request containing the earlier task progress started before the new task was submitted and returns after the reset
- **THEN** the older snapshot does not restore the cleared progress

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

### Requirement: Context compaction preserves task-output continuity
The system SHALL present context compaction as task activity without exposing the generated internal compaction summary.

#### Scenario: Automatic compaction during an active task
- **WHEN** automatic context compaction starts while a task is running
- **THEN** the current task's process output shows one compaction status marker instead of creating a separate task output
- **AND** the marker is collapsed with the rest of the process output when the task finishes

#### Scenario: Automatic compaction completes
- **WHEN** automatic context compaction completes and the task continues
- **THEN** the process marker changes to a completed automatic-compaction receipt
- **AND** the generated compaction summary text is absent from rendered and copied transcript output

#### Scenario: Manual compact command starts
- **WHEN** the user submits `/compact` with Enter or the run-task button
- **THEN** the composer is cleared immediately
- **AND** a standalone compaction task shows elapsed processing time and an in-progress compaction marker

#### Scenario: Manual compact command completes
- **WHEN** the standalone manual compaction finishes
- **THEN** its task output reduces to one completed compaction receipt without summary details

### Requirement: Tool-only runs have readable progress
The system SHALL derive a concise task-progress summary from observable tool activity when a running task has not produced model-authored progress text. The derived summary MUST remain presentation-only and MUST NOT be added to transcript copy, export, or model context.

#### Scenario: Consecutive tool calls without commentary
- **WHEN** an active task performs consecutive tool calls without assistant progress text
- **THEN** the process presentation shows the current tool action and the number of completed tool steps

#### Scenario: Raw tool details remain available
- **WHEN** tool activity is summarized into a readable progress line
- **THEN** the user can still expand the process to inspect the individual tool calls

#### Scenario: Progress summary is not transcript content
- **WHEN** the user copies or exports the conversation or the next model request is built
- **THEN** the locally derived progress summary is excluded
