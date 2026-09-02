## MODIFIED Requirements

### Requirement: Context compaction preserves task-output continuity
The system SHALL present context compaction as task activity without exposing the generated internal compaction summary, and SHALL exclude context-boundary-only messages from task grouping after retaining their compaction mode.

#### Scenario: Automatic compaction during an active task
- **WHEN** automatic context compaction starts while a task is running
- **THEN** the current task's process output shows one compaction status marker instead of creating a separate task output
- **AND** the marker is collapsed with the rest of the process output when the task finishes

#### Scenario: Automatic compaction completes
- **WHEN** automatic context compaction completes and the task continues
- **THEN** the process marker changes to a completed automatic-compaction receipt
- **AND** the output before compaction, the receipt, and the continued output remain in one task output
- **AND** the generated compaction summary text is absent from rendered and copied transcript output

#### Scenario: Snapshot contains a compaction-boundary-only message
- **WHEN** a session snapshot contains a user message whose only part is an automatic compaction boundary followed by its summary message
- **THEN** the system retains the automatic mode for the summary receipt
- **AND** the boundary-only message does not create a task-output boundary

#### Scenario: Manual compact command starts
- **WHEN** the user submits `/compact` with Enter or the run-task button
- **THEN** the composer is cleared immediately
- **AND** a standalone compaction task shows elapsed processing time and an in-progress compaction marker

#### Scenario: Manual compact command completes
- **WHEN** the standalone manual compaction finishes
- **THEN** its task output reduces to one completed compaction receipt without summary details
