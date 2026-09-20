## Purpose

Define safe, durable, and bounded automatic continuation for unfinished session goals so work can span multiple runs without duplicate execution, uncontrolled loops, or accidental completion.

## ADDED Requirements

### Requirement: Eligible unfinished goals continue automatically

The system SHALL evaluate an active unfinished goal for continuation after a goal-linked run reaches an authoritative terminal or idle state and after startup reconciliation. It SHALL admit continuation only when no user interaction, permission decision, budget limit, usage limit, active root run, or terminal goal state prevents execution.

#### Scenario: Active goal has remaining criteria

- **WHEN** a goal-linked run ends, required criteria remain, and every continuation gate is satisfied
- **THEN** the system durably queues the next continuation run
- **AND** the continuation receives the latest goal checkpoint

#### Scenario: Goal is paused or cancelled

- **WHEN** a run ends for a paused or cancelled goal
- **THEN** no automatic continuation is queued

### Requirement: Continuation admission is durable and idempotent

Every goal run SHALL have a persisted ordinal, state, and idempotency identity before dispatch. Reconciliation, duplicate terminal events, reconnects, or process restarts SHALL NOT admit the same continuation more than once.

#### Scenario: Duplicate idle observations arrive

- **WHEN** multiple terminal or idle observations evaluate the same active goal checkpoint
- **THEN** at most one continuation for the next ordinal is created and dispatched
- **AND** duplicate observations resolve to the existing goal run record

#### Scenario: Server exits after queueing but before dispatch

- **WHEN** the Server restarts with a persisted queued or dispatching goal run
- **THEN** it reconciles that record with authoritative session state
- **AND** it either resumes safe admission or records the existing accepted run without creating a duplicate

### Requirement: Goal runs respect authoritative session serialization

The system SHALL route automatic continuation through the same authoritative mutation boundary as user-started root runs and SHALL NOT start a second root run while the session is busy.

#### Scenario: Another root run is active

- **WHEN** a continuation is eligible but the authoritative session has an active root run
- **THEN** the continuation remains queued or is reevaluated later
- **AND** no concurrent goal run is started

#### Scenario: Delayed completion belongs to an older generation

- **WHEN** an older run's delayed event arrives after a newer generation became active
- **THEN** it cannot terminate, advance, or duplicate the newer goal run

### Requirement: Every continuation receives a compact durable goal envelope

Before dispatching a goal run, the system SHALL construct context from the current goal objective, criteria and status, latest durable checkpoint, next-action summary, continuation ordinal, blocker state, and remaining optional budget. It SHALL instruct the run to inspect authoritative workspace state and avoid repeating confirmed work.

#### Scenario: Continuation follows context compaction

- **WHEN** the prior run compacted or discarded older conversation context
- **THEN** the next run still receives the complete durable goal envelope
- **AND** it can distinguish confirmed work from remaining criteria without relying on the compacted transcript

#### Scenario: Internal continuation is presented

- **WHEN** the coordinator submits an internal continuation request
- **THEN** the session UI groups it under the existing goal activity
- **AND** it does not appear as a new user-authored task bubble

### Requirement: No-progress and repeated blockers stop autonomous loops

The system SHALL distinguish provider or tool activity from meaningful goal progress. It SHALL track checkpoint and blocker fingerprints across turns, and SHALL stop automatic continuation when bounded no-progress policy is exhausted. The same blocker repeated in three consecutive goal turns without intervening progress SHALL transition the goal to blocked.

#### Scenario: Tools run without advancing the goal

- **WHEN** consecutive runs emit tool activity but produce the same checkpoint with no criterion progress
- **THEN** the no-progress counter advances
- **AND** the system eventually waits for the user instead of continuing indefinitely

#### Scenario: Same blocker repeats three times

- **WHEN** three consecutive goal turns report the same normalized blocker without meaningful progress
- **THEN** the goal becomes blocked with that reason
- **AND** automatic continuation stops

#### Scenario: User resumes a blocked goal

- **WHEN** the user explicitly resumes a blocked goal after changing guidance or external state
- **THEN** the blocker audit resets
- **AND** continuation eligibility is evaluated as a fresh resumed run

### Requirement: Automatic continuation is capped

The system SHALL apply a finite maximum to consecutive automatic continuations and SHALL require explicit user continuation after the cap is reached. Reaching the cap SHALL NOT complete, cancel, or block the goal.

#### Scenario: Continuation cap is reached

- **WHEN** an unfinished goal reaches the configured consecutive automatic-continuation limit
- **THEN** execution changes to waiting for the user
- **AND** the UI offers an explicit continue action with the goal and checkpoint preserved

### Requirement: Optional goal budgets stop but do not complete work

The system SHALL enforce a positive token budget only when the user explicitly supplies one, SHALL accumulate available usage for goal-linked runs monotonically, and SHALL stop admission when the budget is exhausted. Budget or account usage limits SHALL NOT be treated as completion or a model-declared blocker.

#### Scenario: Goal has no explicit budget

- **WHEN** the user creates a goal without a token budget
- **THEN** the system does not invent one
- **AND** continuation remains governed by usage availability and other safety gates

#### Scenario: Explicit budget is exhausted

- **WHEN** observed goal usage reaches the user-specified budget while criteria remain
- **THEN** execution becomes budget-limited and no continuation is admitted
- **AND** the goal remains unfinished

#### Scenario: Account usage is unavailable

- **WHEN** the account cannot admit another model run because of an external usage limit
- **THEN** execution becomes usage-limited
- **AND** only an external reset or user-controlled change can make it eligible again

### Requirement: Pending interaction suspends the continuation pump

The system SHALL suspend goal continuation while the session has an unresolved permission, question, credential request, destructive confirmation, or material scope decision. Resolving that interaction SHALL trigger reevaluation without duplicating the preceding run.

#### Scenario: Run requests approval

- **WHEN** a goal-linked run produces a permission request requiring user input
- **THEN** execution becomes waiting for the user
- **AND** the coordinator does not dispatch another run behind the approval

#### Scenario: User resolves the interaction

- **WHEN** the user answers the pending interaction and the session returns to authoritative idle
- **THEN** the coordinator reevaluates the same goal checkpoint
- **AND** at most one eligible continuation is admitted

### Requirement: Failed and orphaned runs remain recoverable

The system SHALL record failed, aborted, stalled, and orphaned goal-run outcomes without deleting the goal or claiming completion. Recovery SHALL use authoritative session and child-run reconciliation and SHALL preserve successful prior checkpoint evidence.

#### Scenario: Goal run loses its terminal event

- **WHEN** persisted goal execution appears running but authoritative reconciliation confirms that no corresponding active run exists
- **THEN** the goal run is terminalized with an orphaned outcome
- **AND** the coordinator applies bounded retry or waits for the user according to policy

#### Scenario: Delegated child stalls

- **WHEN** a goal-linked parent is waiting for a confirmed stalled delegated child
- **THEN** existing child-only recovery rules apply
- **AND** the goal coordinator does not abort or duplicate the root run merely because the parent is quiet

### Requirement: User control atomically fences continuation

Pause and cancellation SHALL revoke queued goal continuations atomically. Cancellation of an admitted running turn SHALL use the existing abort path, while delayed dispatch or completion events SHALL NOT reactivate the goal.

#### Scenario: User pauses while continuation is queued

- **WHEN** the user pauses before the queued continuation is accepted by the engine
- **THEN** the queued admission is revoked
- **AND** no delayed pump action starts it

#### Scenario: User cancels during a running goal turn

- **WHEN** the user cancels the goal while its run is active
- **THEN** the existing session abort path is requested and the goal becomes cancelled
- **AND** delayed terminal events cannot enqueue another continuation
