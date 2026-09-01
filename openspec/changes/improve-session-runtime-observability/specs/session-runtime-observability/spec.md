## Purpose

Make long-running session activity understandable and recoverable by distinguishing provider retries, meaningful progress, stalled work, and child-session activity without exposing hidden reasoning.

## ADDED Requirements

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
- **THEN** the session remains visibly degraded and elapsed silence continues from the last meaningful progress

#### Scenario: Work resumes after retry
- **WHEN** assistant output or tool execution makes new progress after a retry
- **THEN** retry or stalled presentation clears and the session returns to the corresponding active state

### Requirement: Stalled activity is visible in the conversation
The system SHALL present stalled activity inside an active conversation even when that conversation already contains transcript messages.

#### Scenario: Existing transcript becomes stalled
- **WHEN** an active session with existing messages exceeds the meaningful-progress deadline
- **THEN** the conversation shows an explicit possibly-stuck status instead of continuing to show a generic generating label

### Requirement: Child-session degradation propagates to its task
The system SHALL project a child session's retrying or stalled state onto the parent task activity without fabricating child completion or failure.

#### Scenario: Subagent provider retry
- **WHEN** a child session reports a provider retry while its parent task call remains in flight
- **THEN** the parent task presentation identifies that the delegated work is retrying

#### Scenario: Subagent stalls
- **WHEN** a child session becomes stalled while its parent task call remains in flight
- **THEN** the parent task presentation identifies the delegated work as possibly stuck

