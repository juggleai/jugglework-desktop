## MODIFIED Requirements

### Requirement: Review Inbox preview
The Reviews surface SHALL present the active member's real GitHub pull request Inbox when a JuggleWork Connect GitHub account is ready, and SHALL use fixtures only in isolated development and tests.

#### Scenario: Filter the Inbox
- **WHEN** the user changes the relationship filter or enters search text
- **THEN** the workbench requests the corresponding bounded server-side query and displays matching GitHub pull requests

#### Scenario: GitHub is not ready
- **WHEN** the active member's GitHub connection is missing, needs authorization, needs administrator action, or is disabled for the workspace
- **THEN** the Inbox displays the matching recovery state and does not show preview pull requests as if they were live data

#### Scenario: Refresh existing data
- **WHEN** the user refreshes or cached Inbox data becomes stale while Reviews is visible
- **THEN** the workbench preserves current data during revalidation and marks it as refreshing rather than flashing an empty page

### Requirement: Pull request detail workbench
The system SHALL provide a selected real GitHub pull request workbench with independently loaded Summary, Changes, Checks, and Threads views.

#### Scenario: Select a pull request
- **WHEN** the user selects a GitHub pull request from the Inbox
- **THEN** the opaque review ID enters the route and the workbench loads normalized metadata for that currently authorized target

#### Scenario: Switch detail views
- **WHEN** the user selects Summary, Changes, Checks, or Threads
- **THEN** the corresponding subresource loads lazily while the selected pull request and already loaded tabs remain available

#### Scenario: Open an unavailable review ID
- **WHEN** a deep link is invalid, no longer authorized, or no longer exists
- **THEN** the workbench presents a recoverable not-found or access state without leaking target metadata

### Requirement: Deferred external operations
The first connected Review workbench MUST remain read-only and MUST NOT execute external provider mutations or AI Review jobs.

#### Scenario: Preview unavailable operations
- **WHEN** the user views actions associated with AI review, commenting, approval, request changes, thread mutation, or merge
- **THEN** the UI identifies them as unavailable and no GitHub write capability is invoked
