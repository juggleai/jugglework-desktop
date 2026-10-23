## MODIFIED Requirements

### Requirement: Review Inbox preview
The Reviews surface SHALL present the active member's real GitHub pull request Inbox when a JuggleWork Connect GitHub account is ready, and SHALL use fixtures only in isolated development and tests.

#### Scenario: Filter the Inbox
- **WHEN** the user changes the relationship filter or enters search text
- **THEN** the workbench requests the corresponding bounded server-side query and displays matching GitHub pull requests

#### Scenario: Match the workspace sidebar surface
- **WHEN** the Code Review Inbox is visible, including an empty result list
- **THEN** its sidebar background and divider extend through the full available height
- **AND** its background uses the same secondary-sidebar color token as the local workspace in both light and dark themes

#### Scenario: GitHub is not ready
- **WHEN** the active member's GitHub connection is missing, needs authorization, needs administrator action, or is disabled for the workspace
- **THEN** the Inbox displays the matching recovery state and does not show preview pull requests as if they were live data

#### Scenario: Use the organization GitHub connection
- **WHEN** Code Review discovers GitHub capabilities
- **THEN** it uses the GitHub connection provided by the active organization through JuggleWork Connect
- **AND** pull-request search and read capabilities MUST resolve to the same organization connection
- **AND** the desktop provides no Public connector fallback; organization provisioning remains authoritative

#### Scenario: Organization GitHub connection is missing
- **WHEN** valid capability discovery returns neither GitHub pull request search nor read capabilities
- **THEN** the owning server returns `organization_admin_action_required`
- **AND** the review surface explains that Code Review only uses organization-provided GitHub connections
- **AND** only after a fresh usable-connection lookup and, for owners, a manageable-connection lookup confirm that GitHub is absent, selecting Open Connect settings opens the active organization's server console with the Add GitHub dialog for an organization owner
- **AND** a non-owner sees a dialog asking the organization owner to add and configure GitHub
- **AND** malformed discovery, partial capabilities, and ambiguous capabilities remain distinguishable as integration errors

#### Scenario: Authorize an organization GitHub connector
- **WHEN** the organization already provides a GitHub connector and the member selects Open Connect settings from Code Review
- **THEN** Desktop first shows the GitHub consent dialog and does not start authorization or open the browser automatically
- **AND** only selecting the bottom Continue connecting to GitHub button starts the existing organization connector OAuth flow in the external browser, including unconnected shared connectors for authorized owners
- **AND** dismissing the dialog does not start authorization
- **AND** the review connection ID takes precedence over endpoint matching, and member-safe records without endpoint URLs remain available for authorization
- **AND** the desktop does not open the Add GitHub console flow for an existing connector based on cached review recovery states or credential mode
- **AND** the consent dialog remains available to show progress, retry authorization, and continue after owner provisioning
- **AND** completing authorization refreshes the Code Review connection without navigating to general settings
- **AND** changing organizations closes the dialog and prevents the previous organization's pending lookup from opening authorization

#### Scenario: Owner creates GitHub from Code Review
- **WHEN** an owner opens server setup from Code Review
- **THEN** the console selects the explicitly requested organization before opening Add GitHub
- **AND** an existing GitHub connector is configured or reauthorized rather than duplicated
- **AND** saving valid OAuth credentials continues browser authorization for the creating member, including per-member credential mode

#### Scenario: Refresh existing data
- **WHEN** the user refreshes or cached Inbox data becomes stale while Reviews is visible
- **THEN** the workbench preserves current data during revalidation and marks it as refreshing rather than flashing an empty page

#### Scenario: Recover an unavailable Connect transport
- **WHEN** the review connection check reports an unavailable provider while the member is signed in
- **THEN** Desktop attempts the existing bounded, workspace-scoped Connect transport repair and reads the review connection again once
- **AND** expired or revoked transport credentials can refresh without repeating GitHub OAuth authorization
- **AND** disabled connections and member or administrator authorization states do not trigger transport repair
- **AND** cancellation or a change of account or organization prevents stale recovery from continuing

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
