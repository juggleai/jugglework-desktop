## ADDED Requirements

### Requirement: Session navigation cancels superseded reads

The desktop SHALL cancel obsolete session-list, route-detail, and bounded transcript-snapshot reads when a newer refresh or session navigation supersedes them. A cancelled read SHALL NOT replace current session state, surface a connection error, or gate the newer navigation after cancellation is observed.

#### Scenario: User switches sessions while a large snapshot is loading
- **GIVEN** the selected session snapshot is still loading
- **WHEN** the user selects another session
- **THEN** the previous snapshot request is aborted
- **AND** the newly selected session can load without waiting for the obsolete request

#### Scenario: Reconnect refresh supersedes an older list request
- **GIVEN** a workspace session-list request is still pending
- **WHEN** a newer forced refresh starts for the same workspace endpoint
- **THEN** the older request is aborted
- **AND** only the newer response may update the sidebar

