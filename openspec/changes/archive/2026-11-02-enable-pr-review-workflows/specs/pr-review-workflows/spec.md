## ADDED Requirements

### Requirement: Private AI review
The application SHALL analyze the selected PR revision with a workspace model, persist findings privately, and expose the related task without publishing GitHub content.

#### Scenario: Run AI analysis
- **WHEN** the member chooses a model and starts AI review
- **THEN** the server reads bounded PR context through the authorized organization connector and executes a tool-denied review session
- **AND** the result includes validated findings and an explicit partial-coverage indicator when applicable
- **AND** navigation does not cancel the run, explicit cancellation stops it, and interrupted runs can be restarted after a server restart
- **AND** starting a review immediately persists and returns a queued run before provider, diff, repository-context, workspace, or model preparation completes
- **AND** the PR conversation immediately shows the readable review request and starts the normal task timer while background preparation continues
- **AND** transient snapshot read timeouts during an active review do not replace the running transcript with a request-timeout error

#### Scenario: Create or reuse the PR review task
- **WHEN** a member starts the first AI review for a pull request
- **THEN** the current workspace creates a root task named `Review <repo> #<number>: <PR title>`, truncating only the title when necessary
- **AND** rerunning the same pull request, including after its head revision changes, appends a new review turn to the existing task rather than creating another review task
- **AND** prior run snapshots remain revision-scoped and related review/fix tasks remain discoverable from the pull request

#### Scenario: Concurrent starts and late cancellation writes
- **WHEN** multiple requests start review for the same PR execution key before preparation finishes
- **THEN** they share one reserved run and do not launch duplicate analyses
- **AND** failed initialization releases its reservation so a later explicit retry can start
- **AND** cancellation cannot be overwritten by a late conversation preparation write, including when cancellation races with its final state read or write
- **AND** state serialization for one PR does not block another PR key

#### Scenario: Enrich from a matching local repository
- **WHEN** the current local workspace Git remote matches the pull request repository and contains the selected head revision
- **THEN** the server supplies bounded changed-file snapshots and applicable root/nested `AGENTS.md` guidance from that exact revision
- **AND** the model receives no write, shell, commit, push, or GitHub publication tools
- **AND** a remote mismatch, missing revision, remote workspace, oversized file, or binary file degrades to connector diff-only review and is reported as partial coverage instead of reading unrelated local code
- **AND** exact-revision reads work in the Desktop embedded Node runtime with bounded subprocess time and output, without requiring Bun globals or shell interpolation

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
