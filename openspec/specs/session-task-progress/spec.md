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

#### Scenario: Automatic continuation arrives through the live event stream
- **WHEN** automatic compaction injects a synthetic continuation user message while the session remains active
- **THEN** the synchronization layer excludes that implementation-only message from the canonical transcript
- **AND** the exclusion works whether the message event or its synthetic text part arrives first
- **AND** a stale snapshot completing after suppression cannot resurrect the excluded message
- **AND** exclusion is scoped to that session, so an identical message id in another session remains a real user turn
- **AND** output after compaction remains in the same task output as output before compaction
- **AND** real user messages remain task-output boundaries

#### Scenario: A user message carries both visible content and the continuation marker
- **WHEN** a message contains a synthetic continuation marker together with other visible UI parts
- **THEN** the visible parts are preserved and the message keeps its normal lifecycle
- **AND** the marker part itself does not appear in the transcript

#### Scenario: A snapshot window excludes the compaction boundary
- **WHEN** a snapshot reconciles a summary receipt whose boundary is outside the snapshot window while the live stream already observed the compaction mode
- **THEN** the reconciled receipt keeps the live-observed mode instead of downgrading it to unknown
- **AND** the pre-compaction output, receipt, and post-compaction output remain one task output

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

### Requirement: Queued follow-ups use compact rows
The system SHALL present each follow-up queued during an active task as a compact single-line row without a separate visible queue-count heading.

#### Scenario: Queued text exceeds the available width
- **WHEN** a queued follow-up is wider than the composer accessory area
- **THEN** its visible text is truncated to one line with an ellipsis
- **AND** edit and remove actions remain visible

#### Scenario: Multiple follow-ups are queued
- **WHEN** more than one follow-up is waiting
- **THEN** each follow-up has its own compact row in queue order

### Requirement: Queued follow-ups can steer the active task
The system SHALL let the user promote a specific queued follow-up into the active task without waiting for the automatic FIFO drain. Promotion MUST be mutually exclusive with automatic queue draining and MUST preserve the queued draft when the immediate submission is not accepted.

#### Scenario: User steers with a queued follow-up
- **WHEN** the user activates the steer action on a queued follow-up while the task is running
- **THEN** that exact follow-up is removed from the queue and submitted through the active session's immediate steer path
- **AND** the remaining follow-ups retain their relative queue order

#### Scenario: Steer submission is not accepted
- **WHEN** the promoted follow-up is blocked, cancelled, or fails before acceptance
- **THEN** the follow-up is restored to its original queue position
- **AND** it remains available for editing, removal, or a later steer attempt

#### Scenario: Automatic drain races with steer
- **WHEN** the active task becomes idle while a queued follow-up is being promoted
- **THEN** only one path may claim and submit that follow-up
- **AND** the application does not create a duplicate user message

### Requirement: Long task sessions provide quick turn navigation
The system SHALL provide a compact navigation rail for scrollable task sessions with multiple user-authored turns, while preserving the conversation's reading width and normal scroll behavior.

#### Scenario: User reviews a long task session
- **WHEN** a task session has multiple visible user-authored turns and its transcript overflows the available viewport
- **THEN** the session shows one navigation marker for each user-authored turn
- **AND** every marker whose task-turn content intersects the current viewport is visually distinct
- **AND** the markers form a compact, vertically centered group rather than stretching across the full viewport

#### Scenario: User previews and selects a navigation marker
- **WHEN** the user hovers or focuses a navigation marker
- **THEN** a bounded preview identifies the corresponding task turn
- **AND** that marker reaches the longest width while nearby markers lengthen progressively according to proximity
- **WHEN** the user activates that marker
- **THEN** the transcript scrolls smoothly to the corresponding user message
- **AND** subsequent transcript growth does not force the view back to the latest message

#### Scenario: Session pane is narrow or does not scroll
- **WHEN** the space to the left of the transcript cannot fit the navigation rail without crowding the transcript, or the transcript does not overflow
- **THEN** the navigation rail remains hidden

### Requirement: Immediate task submission preparation feedback

The system SHALL present a session-scoped preparation state synchronously when the user submits an idle composer draft, before asynchronous resume, connector, attachment, environment, or server-acceptance work completes. The presentation MUST distinguish preparation from an accepted running task and MUST prevent duplicate submission of the same draft.

#### Scenario: Submission starts asynchronous preflight

- **WHEN** the user submits a valid idle composer draft
- **THEN** the active session immediately shows that the task is being prepared
- **AND** the submit control is disabled until the attempt is accepted, blocked, cancelled, or fails
- **AND** no running state is claimed before server acceptance

#### Scenario: Preparation does not accept the task

- **WHEN** preparation is blocked, cancelled, or fails before server acceptance
- **THEN** the preparation state clears
- **AND** the original draft text and attachments remain available for correction or retry

### Requirement: Reuse recent Cloud MCP readiness evidence

The system SHALL submit an ordinary draft that does not explicitly select a Cloud skill, extension, or Cloud MCP capability without blocking on Connect readiness. For an explicit Cloud capability draft, the system SHALL reuse only recent successful Cloud MCP readiness evidence for an unchanged account, organization, workspace, provider, and model scope. It SHALL revalidate aging evidence in the background without blocking the current submission, and SHALL return to blocking verification after expiry, scope change, or failed revalidation.

#### Scenario: Ordinary task uses the non-Connect fast path

- **WHEN** a valid draft contains no explicitly selected Cloud capability
- **THEN** submission does not wait for Cloud MCP health probing or repair
- **AND** failures from another session's readiness coordinator cannot block or duplicate this task

#### Scenario: Closely spaced submission uses positive evidence

- **WHEN** Cloud MCP readiness was successfully verified recently for the same submission scope
- **AND** a new task is submitted before that evidence expires
- **THEN** the task proceeds without waiting for another full readiness probe

#### Scenario: Aging evidence is refreshed without delaying the task

- **WHEN** cached readiness is still valid but has reached its background-refresh age
- **THEN** the current task proceeds using the cached positive evidence
- **AND** one deduplicated background revalidation refreshes or invalidates that evidence

#### Scenario: Readiness evidence is not reusable

- **WHEN** no successful evidence exists, the evidence expired, the scope changed, or background revalidation invalidated it
- **THEN** the next task uses the existing blocking readiness and repair flow
