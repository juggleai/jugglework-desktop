## Purpose

Allow users to change the model of an already-running JuggleWork session so subsequent model requests use the new selection without aborting the task, while preserving truthful execution status and task continuity.

## ADDED Requirements

### Requirement: An active session accepts a model steer
The system SHALL allow a collaborator to steer an active JuggleWork-managed session to an available provider, model, and compatible model behavior without aborting or restarting the active task.

#### Scenario: Switch while a provider request is in flight
- **WHEN** the user selects a different model while the current provider request is already in flight
- **THEN** the in-flight request completes or fails under its original model
- **AND** the next provider request that has not yet started uses the newly selected model

#### Scenario: Switch between tool rounds
- **WHEN** the user selects a different model while the active task is executing tools
- **THEN** tool execution is not interrupted solely because of the model change
- **AND** the model request following the tool result uses the newly selected model

#### Scenario: Continue the same task after switching
- **WHEN** a model steer is accepted during an active task
- **THEN** the session continues the existing task with its current transcript, tool state, permissions, and run identity
- **AND** the system does not require the user to resubmit the task prompt

### Requirement: Model steering does not create concurrent or orphan runs
The system MUST apply a model steer through the existing active session loop and MUST NOT create a second concurrent run or an unsolicited continuation after the targeted run has ended.

#### Scenario: Run remains active through steer admission
- **WHEN** the targeted run is still active after the model steer marker is recorded
- **THEN** the existing run observes the marker and continues from the next model round
- **AND** no second run loop is created

#### Scenario: Run ends during steer admission
- **WHEN** the targeted run becomes idle before it can observe the model steer marker
- **THEN** the marker does not start a new assistant response by itself
- **AND** the selected model remains available for the next user-submitted task

#### Scenario: Stale run fence
- **WHEN** a model steer names a run or generation that is no longer the active run for the session
- **THEN** the system rejects the steer as stale without modifying the replacement run

#### Scenario: Rapid model changes
- **WHEN** multiple model changes are accepted before another provider request starts
- **THEN** the most recently accepted change is authoritative for that next request
- **AND** duplicate selections do not produce duplicate visible task boundaries

### Requirement: Model steering is validated and safely degradable
The system MUST validate the requested model before recording a steer and SHALL preserve the user's local selection while silently degrading to next-task behavior when the active run could not be changed.

#### Scenario: Requested model is unavailable
- **WHEN** the requested provider or model is not available to the target workspace runtime
- **THEN** the system rejects the active-run steer before it becomes the latest model instruction
- **AND** the current run continues using its previous model

#### Scenario: Steer transport fails
- **WHEN** the desktop records the new selection but Server cannot record the active-run steer
- **THEN** the new selection is retained for the next user-submitted task
- **AND** the model selection UI remains in its normal selected state without adding a steering error or pending state

#### Scenario: Session is already idle
- **WHEN** the user changes the selected model after the session has become idle
- **THEN** the system does not generate an assistant response solely for the model change
- **AND** the next user-submitted task uses the new selection

### Requirement: Model behavior follows the target model
The system SHALL apply only model behavior supported by the newly selected model and MUST NOT carry an incompatible variant or reasoning setting across a model change.

#### Scenario: Variant is supported by the new model
- **WHEN** a model steer includes a variant supported by the selected model
- **THEN** the first new-model request and its subsequent continuation requests use that variant

#### Scenario: Prior variant is incompatible
- **WHEN** the user changes to a model that does not support the prior variant or reasoning setting
- **THEN** the system resets or translates that setting using the same rules as a normal new prompt for the selected model
- **AND** it does not send the incompatible prior setting

### Requirement: Model steering is invisible in the normal user experience
The system SHALL preserve the existing model picker and conversation presentation without exposing model-steer admission, pending, application, fallback, or actual-execution states.

#### Scenario: Active run accepts a steer
- **WHEN** the user selects a model while a task is running and the steer is accepted
- **THEN** the picker continues to display the selected model using its existing presentation
- **AND** the conversation does not show a steer receipt, pending badge, applied badge, toast, or actual-model indicator

#### Scenario: Active run cannot be steered
- **WHEN** the user selects a model while a task is running and the steer is rejected or cannot be delivered
- **THEN** the picker continues to display the selected model using its existing presentation
- **AND** the conversation does not show a steering failure or fallback state

#### Scenario: Run ends before the steer affects a request
- **WHEN** the targeted run ends without starting a request under the newly selected model
- **THEN** no additional UI state is created or cleared visibly
- **AND** the next user-submitted task uses the selected model

### Requirement: Internal model steer markers are transcript-transparent
The system SHALL preserve model steer markers in engine context and diagnostic evidence while excluding them from ordinary conversation presentation, task grouping, copied transcript, and user exports.

#### Scenario: Active task receives a steer marker
- **WHEN** Server records an internal model steer marker in a session
- **THEN** the marker supplies a continuation instruction and target model to the engine
- **AND** it does not create a visible user message or split the current task presentation

#### Scenario: Transcript is copied or exported
- **WHEN** the user copies or exports a conversation containing model steer markers
- **THEN** those markers and their internal metadata are excluded from the user-facing output

#### Scenario: Diagnostics inspect a model change
- **WHEN** an authorized diagnostic path inspects the session after a model steer
- **THEN** it can identify the requested provider/model, target run, acceptance time, and whether a matching assistant round was observed without exposing credentials

### Requirement: Engine compatibility is guarded
The release process MUST verify the OpenCode sidecar semantics required for model steering before shipping a sidecar update.

#### Scenario: Compatible sidecar
- **WHEN** compatibility tests run against the packaged OpenCode sidecar
- **THEN** they prove that a no-reply prompt can record a modeled user marker while busy, that the active loop re-reads the latest user model, and that the next assistant round uses it without a concurrent loop

#### Scenario: Sidecar semantics change
- **WHEN** a sidecar update no longer satisfies the model-steering compatibility contract
- **THEN** the release verification fails or active-run steering is disabled with silent fallback to next-task behavior
- **AND** the normal model selection UI remains unchanged
