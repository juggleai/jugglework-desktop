## ADDED Requirements

### Requirement: Workspace Reviews navigation
The system SHALL provide a Reviews destination in the left vertical application navigation rail for workspace-scoped PR review work.

#### Scenario: Open Reviews from the rail
- **WHEN** a user selects Reviews from the left application rail while a workspace is active
- **THEN** the application navigates to that workspace's Reviews route and marks the Reviews rail item active

#### Scenario: Preserve the active session
- **WHEN** the user opens the Reviews surface from an active session
- **THEN** the active session surface remains mounted but hidden so returning to it preserves transient session state

### Requirement: Review Inbox preview
The first-version Reviews surface SHALL present an explicit preview-data Inbox with searchable and filterable pull request fixtures.

#### Scenario: Filter the Inbox
- **WHEN** the user changes the relationship filter or enters search text
- **THEN** the Inbox shows only preview pull requests matching the selected filter and search text

#### Scenario: Distinguish preview data
- **WHEN** the Reviews surface displays fixture pull requests
- **THEN** the surface visibly identifies the content as preview data and does not imply that a provider is connected

### Requirement: Pull request detail workbench
The system SHALL provide a selected pull request workbench with Summary, Changes, Checks, and Threads views.

#### Scenario: Select a pull request
- **WHEN** the user selects a pull request from the Inbox
- **THEN** the route includes its opaque review ID and the workbench displays its repository, number, title, author, revision summary, and review content

#### Scenario: Switch detail views
- **WHEN** the user selects Summary, Changes, Checks, or Threads
- **THEN** the selected pull request remains active and the corresponding preview content is displayed

#### Scenario: Open an unknown review ID
- **WHEN** a Reviews deep link contains an unknown review ID
- **THEN** the workbench presents a recoverable not-found state with an action to return to the Inbox

### Requirement: Responsive review layout
The Reviews workbench SHALL remain usable at wide and compact desktop widths.

#### Scenario: Wide master-detail layout
- **WHEN** sufficient horizontal space is available
- **THEN** the Inbox and selected pull request details are visible as a master-detail layout

#### Scenario: Compact detail navigation
- **WHEN** the workbench is compact and a pull request is selected
- **THEN** the detail view is prioritized and provides an explicit action to return to the Inbox

### Requirement: Review semantic context
The system SHALL publish the active Reviews route as a first-class semantic review screen and resource.

#### Scenario: Publish the Inbox context
- **WHEN** the workspace Reviews Inbox is active without a selected pull request
- **THEN** JuggleWork context identifies a review screen with the workspace ID and no review ID

#### Scenario: Publish selected review context
- **WHEN** a pull request detail route is active
- **THEN** JuggleWork context identifies the review screen and includes a review resource containing the workspace ID and opaque review ID

### Requirement: Deferred external operations
The first-version Review workbench MUST NOT execute external provider mutations or AI Review jobs.

#### Scenario: Preview unavailable operations
- **WHEN** the user views actions associated with AI review, commenting, approval, request changes, or merge
- **THEN** the UI identifies them as future or unavailable preview capabilities and does not report a successful external operation
