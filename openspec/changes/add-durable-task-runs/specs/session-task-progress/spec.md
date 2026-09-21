## ADDED Requirements

### Requirement: Durable task state qualifies progress presentation
The system SHALL use the Server-owned Task Run as the authoritative lifecycle for managed task progress while continuing to use todos and observable tool activity as presentation details.

#### Scenario: Client reconnects during active work
- **WHEN** a session surface reconnects while its durable Task Run is active, waiting, or recovering
- **THEN** the progress presentation restores the Server-owned state and current progress details without requiring a new todo event

#### Scenario: Attempt ends but task requires attention
- **WHEN** an OpenCode Attempt can no longer progress but the Task Run has unsafe or incomplete work
- **THEN** progress remains visible as requiring attention rather than appearing successfully complete or ordinarily active

#### Scenario: Task completion is verified
- **WHEN** the durable Task Run reaches `succeeded` after its current outcomes are reconciled
- **THEN** the UI may acknowledge and hide completed progress according to existing terminal presentation rules
- **AND** model narration or prompt acceptance alone cannot produce that state

### Requirement: Recovery actions use current task revisions
The system SHALL offer resume or cancel actions only against the current durable Task Run revision and SHALL refresh presentation when another client or reconciler wins the transition.

#### Scenario: User resumes stale attention state
- **WHEN** a user requests resume using a revision older than the current Task Run
- **THEN** the request does not mutate execution and the client refreshes to the current state

#### Scenario: Recovery is unsafe
- **WHEN** a Task Run requires attention because an operation outcome is unknown or non-idempotent
- **THEN** the progress surface identifies that review is required and does not label the action as an automatic retry
