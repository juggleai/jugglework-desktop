## ADDED Requirements

### Requirement: Private AI review
The application SHALL analyze the selected PR revision with a workspace model, persist findings privately, and expose the related task without publishing GitHub content.

#### Scenario: Run AI analysis
- **WHEN** the member chooses a model and starts AI review
- **THEN** the server reads bounded PR context through the authorized organization connector and executes a tool-denied review session
- **AND** the result includes validated findings and an explicit partial-coverage indicator when applicable
- **AND** navigation does not cancel the run, explicit cancellation stops it, and interrupted runs can be restarted after a server restart

#### Scenario: Stale or invalid findings
- **WHEN** the PR head changed or AI locations do not match the supplied changed-file context
- **THEN** old findings cannot be used to publish or create fixes for the new revision, and invalid results are shown as failed rather than valid findings

### Requirement: Explicit GitHub publishing
The application SHALL publish discussion comments or COMMENT, APPROVE, and REQUEST_CHANGES reviews only after the member confirms the visible draft.

#### Scenario: Submit a review
- **WHEN** a member confirms publication with a current SHA and an allowed write capability
- **THEN** the server executes only the matching fixed operation on the same organization connection as reads
- **AND** GitHub repository permissions remain authoritative
- **AND** a changed head, closed PR, unavailable capability, or insufficient client scope prevents the write

### Requirement: Explicit pull request lifecycle actions
The application SHALL change draft/readiness/open state, merge, or enable auto-merge only through fixed same-connection capabilities after member confirmation.

#### Scenario: Change or merge a pull request
- **WHEN** a member confirms an available header action for the current PR revision
- **THEN** the server re-reads the PR, verifies the expected head SHA, and maps the fixed action to the organization GitHub connection
- **AND** operation IDs prevent a lost response or retry from silently duplicating an external mutation
- **AND** renderer-supplied capability names or unsupported actions are rejected

#### Scenario: Publish response is lost
- **WHEN** an acknowledged operation is submitted again with the same ID and content
- **THEN** the server replays the stored success without another GitHub mutation, including after restart
- **AND** an unconfirmed outcome cannot be automatically retried, and reusing the ID with different content is rejected

### Requirement: Finding repair tasks
The application SHALL create ordinary workspace tasks from selected server-owned findings for the current PR revision.

#### Scenario: Fix findings
- **WHEN** the member selects findings and chooses Fix
- **THEN** the server verifies the saved run and PR head, creates a task containing those findings, and the desktop opens it
- **AND** the task verifies the repository/revision, protects local changes, investigates false positives, and performs relevant validation before reporting results
- **AND** the task does not automatically commit, push, or publish a review
- **AND** reopening the same finding selection reuses its linked task

#### Scenario: Read-only connector
- **WHEN** the organization GitHub connector exposes only read operations
- **THEN** PR inspection and private AI review remain available while external publication is disabled with an explanation
