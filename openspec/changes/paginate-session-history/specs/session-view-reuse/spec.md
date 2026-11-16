## ADDED Requirements

### Requirement: Retained session history pages remain session-scoped
Retained and embedded session surfaces SHALL keep explicitly loaded older-history pages scoped to their workspace and session, SHALL preserve them across bounded snapshot refreshes, and SHALL cancel in-flight page reads when navigation supersedes that session.

#### Scenario: User returns to a retained session
- **WHEN** the user loads older pages, temporarily opens another retained app surface and returns before the session cache expires
- **THEN** the same session may reuse its loaded older pages and saved reading position
- **AND** another session cannot observe those pages

#### Scenario: Embedded session target changes
- **WHEN** an embedded session changes to a different workspace or session while an older-page request is pending
- **THEN** the previous request is cancelled or ignored
- **AND** only pages keyed to the new target may render
