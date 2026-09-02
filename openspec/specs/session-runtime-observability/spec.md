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

### Requirement: Stalled detection preserves neutral presentation
The system SHALL retain stalled activity as internal runtime evidence while preserving the existing neutral in-progress presentation in conversations and sidebars.

#### Scenario: Existing transcript becomes stalled
- **WHEN** an active session with existing messages exceeds the meaningful-progress deadline
- **THEN** the conversation continues to show the current live action or generic generating label without a possibly-stuck instruction

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
