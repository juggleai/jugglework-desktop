## ADDED Requirements

### Requirement: Completion hints require current execution evidence
The server SHALL verify renderer idle/completed hints against current root and delegated-descendant activity and a non-summary final assistant message created after the current run reservation. A completed tool-call step or an earlier turn's final message SHALL NOT prove success. Idle polling SHALL require separated samples after all such evidence is available. Existing run identity fences and accepted abort behavior SHALL remain enforced.

#### Scenario: Startup races with idle
- **WHEN** a new run receives progress followed by idle before its assistant final response
- **THEN** the coordinator retains that run and rejects premature completion hints

#### Scenario: Delegated work remains active
- **WHEN** a parent is idle while a delegated descendant is busy
- **THEN** the parent run remains active

#### Scenario: Current final response is verified
- **WHEN** the current run has a final assistant receipt and all checked engine activity is idle
- **THEN** separated idle samples may settle the run, or a verified explicit completion hint may settle it

### Requirement: Session surfaces agree on active task ownership
The renderer SHALL preserve server-owned active task presentation across temporary idle and unordered workspace snapshots. Explicit failures and incomplete work SHALL display attention and SHALL NOT create green completion markers.

#### Scenario: Open a temporarily idle parent
- **WHEN** the server still owns the active task after the root reports idle
- **THEN** the session surface retains its running controls

#### Scenario: Task fails
- **WHEN** active work transitions to error or incomplete
- **THEN** the sidebar shows attention rather than a green success marker
