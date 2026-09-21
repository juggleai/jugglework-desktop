## ADDED Requirements

### Requirement: Stalled evidence drives authoritative recovery state
The system SHALL submit stalled evidence to the Server-owned Task Run reconciler and SHALL distinguish suspicion, confirmed stall, recovery in progress, and attention required without treating renderer silence alone as proof that a task is stuck.

#### Scenario: Renderer progress deadline expires
- **WHEN** a renderer observes no meaningful progress before its local deadline
- **THEN** it requests authoritative Task Run reconciliation rather than directly aborting, replaying, or declaring the root task failed

#### Scenario: Authoritative evidence disproves the stall
- **WHEN** reconciliation finds an active tool, provider retry, model step, interaction, compaction, external wait, or delegated child
- **THEN** the Task Run reflects the corresponding active or waiting state and does not perform root recovery

### Requirement: Recovery progress is separately observable
The system SHALL expose whether a soft recovery is suspected, admitted, progressing, exhausted, or no longer applicable while keeping recovery instructions and internal fingerprints out of normal transcript content.

#### Scenario: Soft recovery is admitted
- **WHEN** Server admits a fenced recovery steer for a confirmed stalled Attempt
- **THEN** clients can present a neutral recovering state tied to the same Task Run without adding the internal recovery instruction as a visible user task

#### Scenario: Recovery requires attention
- **WHEN** recovery cannot be proven safe or does not produce progress within its deadline
- **THEN** clients receive a stable attention reason and available user actions instead of continuing to present ordinary generation forever
