## Purpose

Provide a timely, honest view of the conversation context that distinguishes local estimates from provider-reported usage and remains meaningful across streaming, model changes, and compaction.

## ADDED Requirements

### Requirement: Context is available before the next provider result
The system SHALL estimate the selected model's current context from the available active conversation when no matching provider-reported call is available.

#### Scenario: Existing conversation opens
- **WHEN** a session with loaded conversation history is opened before another model response completes
- **THEN** the context meter displays an estimated usage instead of an empty meter

#### Scenario: Empty conversation opens
- **WHEN** a session has no content that can be estimated
- **THEN** the context meter displays zero estimated usage rather than claiming provider-reported data

### Requirement: Streaming context remains current
The system SHALL update the current-context estimate while a response is streaming and SHALL identify that value as an estimate.

#### Scenario: Assistant output streams
- **WHEN** additional assistant or tool-result content is received during an active run
- **THEN** the context meter updates without waiting for the run to finish

#### Scenario: Run is interrupted before provider usage arrives
- **WHEN** an active run is cancelled or fails without usable provider-reported usage
- **THEN** the meter keeps an estimated value derived from the conversation that remains after the interruption

### Requirement: Provider usage calibrates the active context
The system SHALL prefer the latest usable provider-reported usage for the selected model when that report represents the latest active context boundary.

#### Scenario: Matching call completes
- **WHEN** the selected model completes a call with usable token usage
- **THEN** the meter identifies the current value as provider reported and uses that report as its calibrated basis

#### Scenario: Selected model changes
- **WHEN** the user selects a different model than the model associated with the latest provider report
- **THEN** the meter re-estimates the current context for the newly selected model instead of presenting the old model's report as current

### Requirement: Compaction establishes a new active-context boundary
The system SHALL exclude pre-compaction conversation content from the current local estimate once a completed compaction summary is available, while retaining loaded-history diagnostics separately.

#### Scenario: Completed compaction is loaded
- **WHEN** the loaded conversation contains a completed compaction summary followed by later messages
- **THEN** the current estimate is based on the compaction summary and subsequent content rather than all pre-compaction content

#### Scenario: Compaction is still running
- **WHEN** context compaction has started but its replacement summary is not complete
- **THEN** the meter does not discard the previous active-context basis prematurely

### Requirement: Provider diagnostics do not imply unsupported precision
The system SHALL separate current-context usage from latest-call and loaded-history diagnostics and SHALL NOT present an unreported provider-specific field as a known exact value.

#### Scenario: Provider-specific field is unavailable
- **WHEN** no positive value for a provider-specific token category is present in the loaded provider reports
- **THEN** the detail view hides that category instead of presenting it as unavailable or as a confirmed zero

#### Scenario: Loaded-history totals are displayed
- **WHEN** loaded provider diagnostics are shown
- **THEN** the view explains that those totals are not the current active context and may cover only the loaded history window
