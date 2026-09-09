# session-runtime-observability Specification

## Purpose

Make long-running session activity understandable and recoverable by distinguishing provider retries, meaningful progress, stalled work, and child-session activity without exposing hidden reasoning.

## Requirements

### Requirement: Provider retries are visible
The system SHALL present provider retry activity for the active session with the retry attempt and a safe error summary whenever the runtime reports a retry part, retry event, or retry status.

#### Scenario: Retry event while session remains busy
- **WHEN** the runtime emits a provider retry event without changing the session's overall busy status
- **THEN** the active conversation shows that the provider request is retrying and identifies the current attempt

#### Scenario: Retry state restored from snapshot
- **WHEN** a session snapshot contains a retry part from the current run
- **THEN** reopening the session preserves a visible retry receipt or current retry activity

### Requirement: Retry liveness is distinct from meaningful progress
The system SHALL track provider retry liveness separately from user-meaningful progress and MUST NOT clear stalled evidence solely because another retry heartbeat arrived.

#### Scenario: Repeated retries without output
- **WHEN** provider retries continue without new assistant text, reasoning output, tool execution progress, or a completed tool result
- **THEN** the runtime retains stalled evidence and elapsed silence continues from the last meaningful progress without adding a speculative stuck warning to the UI

#### Scenario: Work resumes after retry
- **WHEN** assistant output or tool execution makes new progress after a retry
- **THEN** retry or stalled presentation clears and the session returns to the corresponding active state

### Requirement: Terminal errors settle active presentation
The system SHALL treat a session error or assistant-message error as terminal runtime evidence, clear stale active presentation, and keep manual stop idempotent when the authoritative run list confirms that no run remains.

#### Scenario: Provider quota ends a run
- **WHEN** a provider quota error terminates a session after the renderer previously observed busy or retry state
- **THEN** the conversation stops presenting the run as active without requiring the user to stop it manually

#### Scenario: Stop races with terminal error
- **WHEN** the user requests stop after the run has already ended and the authoritative active-run refresh confirms no run remains
- **THEN** the application treats stop as already complete and does not report a stop failure

#### Scenario: Stop cannot be confirmed
- **WHEN** the abort request is not accepted and the authoritative active-run refresh fails or still reports the run active
- **THEN** the application reports that the run could not be stopped

### Requirement: Stalled detection preserves neutral presentation
The system SHALL retain stalled activity as internal runtime evidence while preserving the existing neutral in-progress presentation in conversations and sidebars.

#### Scenario: Existing transcript becomes stalled
- **WHEN** an active session with existing messages exceeds the meaningful-progress deadline
- **THEN** the conversation continues to show the current live action or generic generating label without a possibly-stuck instruction

### Requirement: Child-session activity uses observable phases
The system SHALL distinguish preparation, execution, and approval-waiting phases for an in-flight child-session task using observable tool and interaction state.

#### Scenario: Child task input is still streaming
- **WHEN** the parent Task tool is still receiving its invocation input
- **THEN** the live activity says that the subtask is being prepared

#### Scenario: Child task is running
- **WHEN** the Task invocation input is available and no descendant interaction is pending
- **THEN** the live activity says that the subtask is running rather than still being delegated

#### Scenario: Child task needs approval
- **WHEN** an in-flight Task has a pending permission or question in its descendant session tree
- **THEN** the live activity says that the subtask is waiting for approval

### Requirement: Child-session retry propagates to its task
The system SHALL project a child session's retrying state onto the parent task activity without fabricating child completion or failure, while stalled state remains undecorated.

#### Scenario: Subagent provider retry
- **WHEN** a child session reports a provider retry while its parent task call remains in flight
- **THEN** the parent task presentation identifies that the delegated work is retrying

#### Scenario: Subagent stalls
- **WHEN** a child session becomes stalled while its parent task call remains in flight
- **THEN** the parent task remains in its original in-flight presentation without a possibly-stuck instruction

### Requirement: Manual compaction completion is event-backed
The system SHALL treat raw compaction parts as invisible context-boundary metadata and SHALL present a completed manual-compaction receipt only after authoritative completion evidence is available.

#### Scenario: Compaction boundary arrives while compression is running
- **WHEN** a raw compaction part arrives after manual compaction has started but before a completion event or completed summary message
- **THEN** the conversation continues to show elapsed time and the collapsible in-progress compaction state without showing “Context compacted”

#### Scenario: Manual compaction completes
- **WHEN** the runtime emits the compaction-ended event or a summary message contains a completion timestamp
- **THEN** the in-progress presentation is replaced by one completed compaction receipt

### Requirement: Automatic compaction remains inside the active task
The system SHALL treat an automatic context boundary, its summary receipt, and the resumed assistant output as one continuous task presentation.

#### Scenario: Lifecycle events omit the compaction reason
- **WHEN** a raw compaction part identifies an automatic boundary and its lifecycle events omit the reason
- **THEN** the live transcript retains the automatic mode for the following summary receipt and does not create a standalone task

#### Scenario: Only an unknown summary receipt survives reconciliation
- **WHEN** a completed summary receipt has unknown mode but is followed by a transparent continuation marker and more assistant output
- **THEN** the receipt and resumed output remain grouped with the assistant output before compaction
