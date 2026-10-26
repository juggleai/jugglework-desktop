## MODIFIED Requirements

### Requirement: Deferred external operations
The workbench SHALL expose private AI review, explicit comment/review publishing, pull-request lifecycle actions, and merge operations when supported by the organization connection.

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
