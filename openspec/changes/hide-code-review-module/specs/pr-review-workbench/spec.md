## MODIFIED Requirements

### Requirement: Workspace Reviews navigation
The system SHALL provide a Reviews destination in the left vertical application navigation rail's More menu for workspace-scoped PR review work and SHALL let the user persist a pinned Reviews shortcut below that menu, only when the Code Review module is enabled by the `CODE_REVIEW_ENABLED` build flag. The flag SHALL default to disabled.

#### Scenario: Open Reviews from the rail
- **WHEN** the Code Review module is enabled and a user selects Reviews from the left application rail's More menu while a workspace is active
- **THEN** the application navigates to that workspace's Reviews route and marks the More entry active when no pinned shortcut is present

#### Scenario: Pin Reviews to the rail
- **WHEN** the Code Review module is enabled and the user activates the pin action for Reviews in the More menu
- **THEN** a persistent Reviews shortcut appears below More after a separator and remains available across app reloads

#### Scenario: Unpin Reviews from the rail
- **WHEN** the Code Review module is enabled and the user activates the unpin action for Reviews
- **THEN** the dedicated shortcut is removed while Reviews remains available from the More menu

#### Scenario: Preserve the active session
- **WHEN** the Code Review module is enabled and the user opens the Reviews surface from an active session
- **THEN** the active session surface remains mounted but hidden so returning to it preserves transient session state

#### Scenario: Code Review module disabled
- **WHEN** the Code Review module is disabled
- **THEN** the More menu shows no Reviews entry or pin action
- **AND** a Reviews pin stored by an earlier version is not shown on the rail
- **AND** opening a `/workspace/:id/reviews` route redirects to that workspace's last session without mounting the Review surface
