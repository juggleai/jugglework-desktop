## ADDED Requirements

### Requirement: Toon Factory is discoverable from the More menu
The application SHALL show a localized Toon Factory item immediately after Code Review in the left navigation rail's More menu.

#### Scenario: User opens the More menu
- **WHEN** the user opens the left navigation rail's More menu
- **THEN** Code Review is listed before Toon Factory
- **AND** selecting Toon Factory opens the current workspace's Toon Factory route

### Requirement: Toon Factory can be pinned to the navigation rail
The application SHALL let the user pin and unpin Toon Factory using the same persistence and interaction contract as Code Review.

#### Scenario: User pins Toon Factory
- **WHEN** the user activates the pin control on the Toon Factory menu row
- **THEN** a Toon Factory rail button appears below the More menu's pinned-item separator
- **AND** the pinned state survives application reload

#### Scenario: User unpins Toon Factory
- **WHEN** Toon Factory is pinned and the user activates its unpin control
- **THEN** its dedicated rail button is removed
- **AND** Toon Factory remains available in the More menu

#### Scenario: Multiple destinations are pinned
- **WHEN** both Code Review and Toon Factory are pinned
- **THEN** the pinned region renders Code Review before Toon Factory in stable order

### Requirement: Toon Factory uses a workspace-scoped retained route
The application SHALL expose Toon Factory at a workspace-scoped route and SHALL preserve in-progress workbench state after its first mount while the user visits another application surface.

#### Scenario: User opens a Toon Factory project
- **WHEN** the user navigates to `/workspace/:workspaceId/toon-factory/:projectId`
- **THEN** the application opens that project in the addressed workspace

#### Scenario: User temporarily leaves the workbench
- **WHEN** the user opens Settings, Chat, Apps, Reviews, or another retained surface and then returns
- **THEN** the active project, selected stage, canvas viewport, and unsaved editor draft remain available
- **AND** hidden Toon Factory views do not continue unnecessary polling or graph rendering

### Requirement: Navigation active state follows pin state
The application SHALL represent Toon Factory activity on the More button when unpinned and on its dedicated rail button when pinned.

#### Scenario: Active Toon Factory is not pinned
- **WHEN** the Toon Factory route is active and Toon Factory is not pinned
- **THEN** the More rail button is visually active

#### Scenario: Active Toon Factory is pinned
- **WHEN** the Toon Factory route is active and Toon Factory is pinned
- **THEN** the Toon Factory rail button is visually active
- **AND** the More button is not activated solely by the Toon Factory route
