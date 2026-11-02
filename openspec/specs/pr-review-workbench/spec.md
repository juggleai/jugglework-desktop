# pr-review-workbench Specification

## Purpose
Define the workspace pull-request Review surface, including navigation, Inbox and detail behavior, responsive layout, semantic context, and capability-aware actions.

## Requirements

### Requirement: Workspace Reviews navigation
The system SHALL provide a Reviews destination in the left vertical application navigation rail's More menu for workspace-scoped PR review work and SHALL let the user persist a pinned Reviews shortcut below that menu.

#### Scenario: Open Reviews from the rail
- **WHEN** a user selects Reviews from the left application rail's More menu while a workspace is active
- **THEN** the application navigates to that workspace's Reviews route and marks the More entry active when no pinned shortcut is present

#### Scenario: Pin Reviews to the rail
- **WHEN** the user activates the pin action for Reviews in the More menu
- **THEN** a persistent Reviews shortcut appears below More after a separator and remains available across app reloads

#### Scenario: Unpin Reviews from the rail
- **WHEN** the user activates the unpin action for Reviews
- **THEN** the dedicated shortcut is removed while Reviews remains available from the More menu

#### Scenario: Preserve the active session
- **WHEN** the user opens the Reviews surface from an active session
- **THEN** the active session surface remains mounted but hidden so returning to it preserves transient session state

### Requirement: Review Inbox preview
The Reviews surface SHALL present the active member's real GitHub pull request Inbox when a JuggleWork Connect GitHub account is ready, and SHALL use fixtures only in isolated development and tests.

#### Scenario: Filter the Inbox
- **WHEN** the user changes the relationship filter or enters search text
- **THEN** the workbench requests the corresponding bounded server-side query and displays matching GitHub pull requests

#### Scenario: Distinguish preview data
- **WHEN** isolated development or tests display fixture pull requests
- **THEN** the surface visibly identifies the content as preview data and does not imply that a provider is connected

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

#### Scenario: Open an unknown review ID
- **WHEN** a Reviews deep link contains an unknown review ID
- **THEN** the workbench presents a recoverable not-found state with an action to return to the Inbox

#### Scenario: Open an unavailable review ID
- **WHEN** a deep link is invalid, no longer authorized, or no longer exists
- **THEN** the workbench presents a recoverable not-found or access state without leaking target metadata

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
The workbench SHALL expose private AI review, explicit comment/review publishing, pull-request lifecycle actions, and merge operations when supported by the organization connection.

#### Scenario: Preview unavailable operations
- **WHEN** the organization connection does not support an AI review, comment, review, lifecycle, thread, or merge operation
- **THEN** the UI identifies that operation as unavailable and does not invoke a GitHub write capability

#### Scenario: Review controls
- **WHEN** a real PR is selected
- **THEN** the header offers AI Review, Submit review, a status menu, local pin, copy URL, open in GitHub, and Merge, with remote writing enabled only for supported connector capabilities
- **AND** status and merge actions require a visible final confirmation before GitHub is changed
- **AND** selecting AI Review opens a private right-side review conversation and starts analysis for a review that has not yet run, while opening the publish dialog never publishes external content
- **AND** the initial review uses the member's most recently selected global text model and a repeated visit to a completed review restores the existing conversation without starting duplicate analysis
- **AND** copying AI findings into a review draft remains private until the final Publish action
- **AND** a PR update while composing blocks publication of the outdated draft
- **AND** changing organization dismisses dialogs and prevents late task navigation for the previous organization
- **AND** the review conversation remains in the pull-request workbench, supports follow-up messages and explicit re-review, and does not automatically navigate away
- **AND** the conversation composer uses the same task controls as local workspace conversations for attachments, permission mode, model, reasoning strength, voice, send, and stop
- **AND** the same PR-bound conversation can move between a right pane, left pane, full workbench view, bottom-right quick composer, and minimized quick-conversation pill without mounting a duplicate session surface or losing its draft and running state
- **AND** opening a PR shows the bottom-right quick composer and prepares its private PR-bound conversation without starting AI review, so the member can immediately ask contextual follow-up questions
- **AND** selecting AI Review moves that same conversation to the right pane and starts the explicit review task

#### Scenario: A queued follow-up send fails
- **WHEN** sending a queued follow-up fails or its acknowledgement is uncertain
- **THEN** the queue pauses without automatic resubmission and retains the message text and attachments for explicit retry
- **AND** retry reuses the prepared command/message identities and checks whether the attempted message already exists before reposting
- **AND** a refresh failure after a successful acknowledgement does not requeue the message
- **AND** rapid repeated interactions and late completions from a previous session cannot dispatch duplicate or cross-session queued work

#### Scenario: Private review workspace isolation
- **WHEN** a member starts AI Review for a pull request
- **THEN** the server creates a private local workspace below the platform Documents directory at `JuggleWork/codereview/YYYY-MM-DD/<repository>-pr-<number>-<title>`
- **AND** unsafe path characters are normalized and a numeric suffix is used when a newly allocated name already exists
- **AND** the review workspace and session use pull-request-derived names and contain bounded non-secret review metadata
- **AND** subsequent visits and revisions reuse the durable private workspace and session while it remains available
- **AND** the saved workspace metadata is checked against the selected pull request before reuse, and the panel is keyed by pull-request identity so responses cannot cross between pull requests
- **AND** private review workspaces are addressable through their saved review-run reference but are omitted from normal workspace lists and cannot become the default managed workspace

#### Scenario: Match native layout
- **WHEN** review controls are displayed on compact or wide windows
- **THEN** they remain usable within the native layout and preserve the local-workspace sidebar color and full-height surface

#### Scenario: Opened pull request overview
- **WHEN** a member opens a pull request from the code-review Inbox
- **THEN** the workbench shows its status, repository, author, revision branches, and rendered description in the primary reading area
- **AND** a summary rail shows changed-file totals, discussion activity, reviewers, and check results without requiring the member to switch sections first
- **AND** the Changes, Checks, and Threads sections remain available for their complete views
- **AND** non-zero GitHub reactions on the pull request description are shown with their emoji and count next to the reaction control
- **AND** the Summary sidebar shows only published review-thread root comments as a compact count and author summary, while ordinary pull request comments remain in Activity
- **AND** expanding a review comment shows a compact preview and selecting it returns Activity to the complete timeline and locates the corresponding root comment
- **AND** replies do not increment the sidebar count and resolved review threads remain represented

#### Scenario: Use the compact pull request conversation
- **WHEN** a member opens a pull request
- **THEN** the associated conversation is prepared in the background and only a circular conversation button is shown in the lower-right corner
- **AND** selecting the button expands the floating compact conversation composer
- **AND** focusing the compact input reveals a joined control row above it with the private-review title, hide action, and a six-dot handle
- **AND** clicking outside the floating conversation and its portalled menus hides the control row while leaving the compact input available
- **AND** the joined card uses the compact typography, neutral icon colors, icon proportions, divider, rounded corners, and shadow of the reference quick-conversation treatment
- **AND** clicking the six-dot handle opens pop-out, left/right dock, full-view, and minimize actions, while a long press allows the floating composer to be dragged within the viewport
- **AND** minimizing a docked or floating conversation returns to that same circular button
- **WHEN** the pull request conversation is floating over the Summary
- **THEN** it presents a single compact rounded composer without a duplicate panel header or transcript chrome
- **AND** the docked and full layouts retain the conversation header, transcript, review status, and layout controls
- **AND** its model catalog and organization filtering match a normal task in the source workspace while prompts continue to execute in the isolated review workspace
- **AND** full view replaces only the pull request detail region and never covers the Code Review inbox
- **AND** left, right, and full layouts omit a close action and use minimize/layout controls to return to the pull request
- **AND** the divider beside a left or right conversation pane supports pointer dragging with bounded pane widths
- **AND** docked/full transcript rendering reuses the normal task message experience, including Markdown, tool/intermediate progress, elapsed task time, and completed-step collapsing

#### Scenario: Open a PR outside the Inbox
- **WHEN** a member pastes a GitHub pull request URL
- **THEN** the owning server validates the GitHub host and PR path, resolves it through the current organization connector, and opens its authenticated detail
- **AND** arbitrary hosts, non-HTTPS links, and non-PR paths are rejected without contacting the supplied host

#### Scenario: Organization gateway wraps a GitHub response
- **WHEN** the organization gateway forwards a downstream MCP result in structured or JSON text content
- **THEN** the workbench decodes the bounded nested result before reading the PR list, detail, files, checks, and discussion
- **AND** downstream tool errors are reported rather than displayed as an empty inbox or a successful publication
