## ADDED Requirements

### Requirement: Restored task outcomes retain interruption semantics
Conversation and pet presentation SHALL share a current-user-turn outcome classification for both live events and restored snapshots. Persisted stopped/error metadata, finish information, todo state and authoritative run results SHALL distinguish cancelled, failed, incomplete, completed and unknown outcomes. In-memory activity state or a default provider finish value of stop SHALL not alone prove successful completion. Older failed turns SHALL not override a newer successful turn.

#### Scenario: An interrupted turn has no todos
- **WHEN** a snapshot restores the current turn with MessageAbortedError-derived stopped metadata and no todo items
- **THEN** it retains the interruption or cancellation outcome rather than being classified as successful idle
- **AND** conversation and pet presentation agree without marking the run active

#### Scenario: Outcome evidence is unavailable
- **WHEN** a restored current turn lacks sufficient evidence to determine whether its run ended
- **THEN** it is presented as awaiting status reconciliation
- **AND** pet continuation remains disabled until the existing run reconciliation resolves it
