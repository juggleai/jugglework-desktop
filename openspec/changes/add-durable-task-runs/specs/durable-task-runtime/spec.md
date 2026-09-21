## Purpose

Define durable, Server-owned task execution state so long-running work can be reconciled and safely resumed across lost events, stalled agent loops, and process restarts without blindly repeating side effects.

## ADDED Requirements

### Requirement: Accepted tasks have a durable execution identity
The system SHALL persist a Task Run before or atomically with accepting a managed session task, SHALL associate it with the workspace and session, and SHALL expose its current status, revision, generation, active attempt, and last meaningful progress time.

#### Scenario: Managed task is accepted
- **WHEN** Server accepts a new managed task for an idle session
- **THEN** it returns a durable Task Run and active Attempt identity together with the accepted session run
- **AND** the Task Run remains queryable independently of the originating renderer request

#### Scenario: Prompt dispatch fails before acceptance
- **WHEN** Server reserves a Task Run but OpenCode does not accept the initial prompt
- **THEN** the reservation reaches a terminal failure state without remaining active or eligible for automatic recovery

### Requirement: Task state follows a fenced state machine
The system SHALL permit only defined Task Run, Attempt, and Operation transitions, SHALL serialize mutations with revision and generation fences, and MUST reject delayed observations or commands that target a replaced attempt.

#### Scenario: Delayed completion targets an older generation
- **WHEN** a completion observation for generation N arrives after generation N+1 has become active
- **THEN** the system rejects or ignores the stale observation without changing generation N+1

#### Scenario: Concurrent recovery and cancellation
- **WHEN** recovery and cancellation contend for the same Task Run revision and active Attempt
- **THEN** only one transition succeeds and the losing command receives the current authoritative state

### Requirement: Tool and external operations have durable outcome evidence
The system SHALL record each observed tool or external operation with a stable identity, status, idempotency classification, progress timestamps, and non-secret result or verification evidence sufficient for recovery decisions. The ledger MUST NOT persist prompt text, tool arguments, tool output, credentials, hidden reasoning, or secret environment values.

#### Scenario: Tool completes before the model stops progressing
- **WHEN** OpenCode persists a completed or failed tool result with a terminal timestamp
- **THEN** the corresponding Operation records terminal outcome evidence and the Task Run can distinguish completed tool work from an executing tool

#### Scenario: Side-effect outcome is uncertain
- **WHEN** an operation may have reached an external system but no authoritative outcome or verification evidence is available
- **THEN** the Operation becomes `outcome_unknown` and the Task Run does not automatically retry that operation

### Requirement: Server reconciles every non-terminal task
The system SHALL reconcile non-terminal Task Runs against authoritative OpenCode session status, current messages or durable history, pending interactions, and recorded Operation evidence after Server startup and while progress deadlines are due.

#### Scenario: Server restarts while OpenCode is still busy
- **WHEN** Server starts with a persisted non-terminal Task Run whose OpenCode session is authoritatively busy
- **THEN** it restores an active or waiting state from current engine and Operation evidence without replaying the original prompt

#### Scenario: Server restarts after the engine became idle
- **WHEN** Server starts with a persisted non-terminal Task Run whose OpenCode session is authoritatively idle
- **THEN** it verifies recorded outcomes and settles the current Attempt instead of leaving the task permanently running

#### Scenario: Engine state is unavailable
- **WHEN** reconciliation cannot read authoritative OpenCode state
- **THEN** the Task Run becomes or remains `requires_attention` with a stable reason code and no destructive recovery is attempted

### Requirement: Stalled root attempts use bounded soft recovery
The system SHALL classify an active root Attempt as recoverable only after all observable tools in the current turn have persisted terminal outcomes, no model step, retry, compaction, interaction, or delegated child remains active, the OpenCode session remains busy, and a confirmation interval passes without meaningful progress.

#### Scenario: Long-running tool is still active
- **WHEN** a tool remains pending or running even though the task has exceeded its ordinary no-progress deadline
- **THEN** the system does not steer, abort, or replay the root Attempt

#### Scenario: Completed tool is followed by a lost continuation
- **WHEN** all current-turn tools are terminal, OpenCode remains busy, no blocking condition exists, and the same run generation and terminal fingerprint remain unchanged through confirmation
- **THEN** the system admits at most one idempotent, run-fenced soft-recovery steer for that fingerprint
- **AND** it does not replay the original user prompt or directly execute the completed tool again

#### Scenario: Recovery admission produces new progress
- **WHEN** a soft-recovery steer is followed by new authoritative model, tool, or terminal progress
- **THEN** the Attempt returns to the corresponding active or terminal state and records the recovery as progressed

#### Scenario: Recovery admission does not produce progress
- **WHEN** the recovery observation deadline expires without authoritative progress
- **THEN** the Task Run becomes `requires_attention`
- **AND** the system does not admit another recovery steer for the same fingerprint or automatically abort and replay the root task

### Requirement: Unsafe recovery fails closed
The system MUST require explicit human action before hard recovery or retry when an active Attempt cannot be safely continued, a non-idempotent Operation has an unknown outcome, or a replacement Attempt would risk repeating side effects.

#### Scenario: Unknown non-idempotent operation outcome
- **WHEN** a stalled Task Run contains an `outcome_unknown` non-idempotent Operation
- **THEN** it becomes `requires_attention` and presents the reason without automatically starting a replacement Attempt

#### Scenario: User resumes after reviewing evidence
- **WHEN** the user requests resume with the current Task Run revision after reviewing the attention reason
- **THEN** Server revalidates the active Attempt, engine state, and Operation evidence before performing any permitted recovery transition

### Requirement: Task status is observable without transcript dependence
The system SHALL provide queryable Task Run details and bounded content-free lifecycle events so clients can present active, waiting, recovering, attention, and terminal states without inferring them solely from transcript text.

#### Scenario: Client reconnects after missing lifecycle events
- **WHEN** a client reconnects after an event gap
- **THEN** it can read the current Task Run and replace stale local task state with the Server-owned revision

#### Scenario: Lifecycle diagnostics are retained
- **WHEN** Task Run, Attempt, Operation, or recovery state changes
- **THEN** the system records IDs, revisions, generations, status transitions, timestamps, and stable reason codes only
- **AND** the diagnostic event contains no prompt, tool payload, model output, file content, credential, or secret
