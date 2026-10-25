## MODIFIED Requirements

### Requirement: Deferred external operations
The workbench SHALL expose private AI review, explicit comment/review publishing, pull-request lifecycle actions, and merge operations when supported by the organization connection.

#### Scenario: Review controls
- **WHEN** a real PR is selected
- **THEN** the header offers AI Review, Submit review, a status menu, local pin, copy URL, open in GitHub, and Merge, with remote writing enabled only for supported connector capabilities
- **AND** status and merge actions require a visible final confirmation before GitHub is changed
- **AND** opening either dialog does not start model execution or publish external content
- **AND** copying AI findings into a review draft remains private until the final Publish action
- **AND** a PR update while composing blocks publication of the outdated draft
- **AND** changing organization dismisses dialogs and prevents late task navigation for the previous organization
- **AND** the AI review dialog lists the review task and any linked fix task for the selected pull request without automatically navigating away

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

#### Scenario: Open a PR outside the Inbox
- **WHEN** a member pastes a GitHub pull request URL
- **THEN** the owning server validates the GitHub host and PR path, resolves it through the current organization connector, and opens its authenticated detail
- **AND** arbitrary hosts, non-HTTPS links, and non-PR paths are rejected without contacting the supplied host

#### Scenario: Organization gateway wraps a GitHub response
- **WHEN** the organization gateway forwards a downstream MCP result in structured or JSON text content
- **THEN** the workbench decodes the bounded nested result before reading the PR list, detail, files, checks, and discussion
- **AND** downstream tool errors are reported rather than displayed as an empty inbox or a successful publication
