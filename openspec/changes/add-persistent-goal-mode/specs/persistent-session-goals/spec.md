## Purpose

Define a durable, session-scoped goal that preserves user intent, success criteria, progress evidence, and explicit lifecycle control across multiple model runs, context compaction, and application restarts.

## ADDED Requirements

### Requirement: Goal creation requires explicit user intent

The system SHALL create a persistent goal only when the user explicitly selects goal creation or explicitly requests that the current objective be tracked as a continuing goal. The system SHALL NOT infer a persistent goal from an ordinary task submission.

#### Scenario: User creates a goal from the composer

- **WHEN** the user selects `目标`, provides an objective and success criteria, and confirms creation
- **THEN** the system creates an active goal scoped to the current workspace and session
- **AND** the first goal run uses that durable goal identity

#### Scenario: User submits an ordinary long-running task

- **WHEN** the user submits a task without explicitly requesting a persistent goal
- **THEN** the system runs it as an ordinary session task
- **AND** no persistent goal is created automatically

### Requirement: A session has at most one unfinished goal

The system SHALL allow at most one goal whose lifecycle is not completed or cancelled in a session.

#### Scenario: Another unfinished goal already exists

- **WHEN** goal creation is requested for a session with an active, paused, or blocked goal
- **THEN** the system rejects replacement and returns the existing goal
- **AND** the user is offered controls to edit, complete, or cancel that goal

#### Scenario: Prior goal is terminal

- **WHEN** the previous goal is completed or cancelled and the user explicitly creates another goal
- **THEN** the system creates the new goal without altering the terminal history of the previous goal

### Requirement: Goal state survives run and process boundaries

The system SHALL persist the goal objective, criteria, lifecycle, execution state, checkpoint, run history, optional budget, observed usage, and timestamps independently of the current transcript context and renderer memory.

#### Scenario: Automatic context compaction occurs

- **WHEN** a goal run undergoes automatic context compaction
- **THEN** the goal identity, objective, success criteria, checkpoint, and lifecycle remain unchanged
- **AND** subsequent work continues the same goal rather than creating a new visible task

#### Scenario: Application restarts with an unfinished goal

- **WHEN** JuggleWork is restarted and the owning session is reopened
- **THEN** the same unfinished goal and its latest confirmed checkpoint are restored
- **AND** stale renderer state is reconciled against server-owned goal state

### Requirement: Goal lifecycle is distinct from run execution

The system SHALL represent the goal lifecycle independently from whether an individual run is idle, queued, running, waiting for the user, retrying, or limited by budget or account usage.

#### Scenario: A run ends before the goal is complete

- **WHEN** a goal-linked run becomes idle without satisfying every required criterion
- **THEN** the goal remains active unless another explicit terminal or blocking condition applies
- **AND** run idleness alone does not mark the goal completed

#### Scenario: Goal waits for a user decision

- **WHEN** continued work requires a permission, credential, destructive confirmation, or material scope choice
- **THEN** the goal remains unfinished and its execution state becomes waiting for the user
- **AND** automatic continuation stops until the interaction is resolved

### Requirement: Structured operations update goal progress

The system SHALL expose structured goal operations that let an authorized goal run read the current goal, report criterion-level progress and evidence, report a blocker, and request completion. Natural-language assistant output alone SHALL NOT mutate goal lifecycle.

#### Scenario: Model reports meaningful progress

- **WHEN** a goal run reports completed criteria, concise evidence, and a bounded next action through the progress operation
- **THEN** the server atomically updates the durable checkpoint and progress timestamp
- **AND** the update is associated with that goal and run generation

#### Scenario: Stale run reports progress

- **WHEN** an older run generation reports progress after a newer goal run has been admitted
- **THEN** the server rejects or ignores the stale update
- **AND** the newer checkpoint remains authoritative

### Requirement: Terminal goal transitions are explicit and truthful

The system SHALL mark a goal completed only after an explicit completion operation or explicit user override, and SHALL reject model-requested completion while required success criteria remain unresolved. Pause SHALL require explicit user action. Completed and cancelled goals SHALL be terminal.

#### Scenario: Model requests completion with evidence

- **WHEN** the active run requests completion and every required criterion has supporting progress evidence
- **THEN** the goal becomes completed
- **AND** no further automatic continuation is admitted

#### Scenario: Model requests premature completion

- **WHEN** the active run requests completion while a required criterion is unresolved
- **THEN** the completion request is rejected
- **AND** the goal remains unfinished with the unresolved criterion visible

#### Scenario: User pauses a goal

- **WHEN** the user explicitly pauses an active goal
- **THEN** queued continuation is revoked and the lifecycle becomes paused
- **AND** neither the model nor an idle event resumes it automatically

### Requirement: Goal mode preserves existing authority boundaries

Creating or continuing a goal SHALL NOT grant filesystem, network, credential, connector, publishing, deployment, purchase, deletion, or other external authority beyond the session's current permission policy and explicit user approvals.

#### Scenario: Continued work needs a new permission

- **WHEN** an active goal reaches an operation that requires approval under the current session permission mode
- **THEN** the normal approval flow is shown
- **AND** the goal does not bypass, broaden, or persist that permission beyond its existing scope

### Requirement: Goal presentation remains available while unfinished

The session SHALL present an unfinished goal independently of the current run's todo panel, including objective, lifecycle and execution state, criterion progress, latest confirmed action or blocker, last progress time, optional budget state, and applicable user controls.

#### Scenario: Goal is active between runs

- **WHEN** an active goal has no currently running turn
- **THEN** the goal card remains visible as unfinished
- **AND** the ordinary session running indicator remains idle

#### Scenario: Goal and run todos are both available

- **WHEN** a goal-linked run publishes OpenCode todos
- **THEN** the goal card shows durable objective progress
- **AND** the todo presentation may show the current run's detailed plan without becoming the goal's source of truth

### Requirement: User follow-ups do not silently replace the goal

The system SHALL preserve the current goal objective and criteria when the user sends ordinary guidance or an unrelated question. Material edits to objective or criteria SHALL require an explicit goal edit action.

#### Scenario: User guides the active work

- **WHEN** the user steers or queues a follow-up that does not explicitly edit the goal
- **THEN** the message uses the normal session submission path
- **AND** the persisted goal definition remains unchanged

#### Scenario: User edits success criteria

- **WHEN** the user explicitly edits the goal criteria
- **THEN** the update is versioned and recorded
- **AND** the next goal run receives the revised criteria
