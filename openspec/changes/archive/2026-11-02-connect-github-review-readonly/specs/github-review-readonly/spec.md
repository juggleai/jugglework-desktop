## ADDED Requirements

### Requirement: Member-authorized GitHub readiness
The system SHALL resolve GitHub Review access through the active member's JuggleWork Connect authorization and current workspace connection policy.

#### Scenario: Member GitHub connection is ready
- **WHEN** the active member has an authorized GitHub connection enabled for the workspace
- **THEN** the Review API reports ready and permits the fixed read-only Review operations

#### Scenario: Member authorization is required
- **WHEN** GitHub is published to the member but the member has not authorized their account
- **THEN** the workbench shows a member sign-in action that directs the user to Settings > Connect

#### Scenario: GitHub is disabled for the workspace
- **WHEN** the GitHub connection is disabled by workspace policy
- **THEN** the Review API denies data access and reports the workspace-disabled state without bypassing Connect through another credential source

### Requirement: Typed read-only Review API
The local JuggleWork Server SHALL expose versioned, workspace-scoped, GET-only APIs for Review Inbox, detail, files, checks, and threads.

#### Scenario: Renderer requests Review data
- **WHEN** the renderer requests Review data for an authorized workspace
- **THEN** it receives normalized Review DTOs rather than raw MCP content or GitHub credentials

#### Scenario: Renderer attempts to select a capability
- **WHEN** renderer-controlled input contains an MCP capability or arbitrary GitHub API operation
- **THEN** the server rejects or ignores that input because capability selection is fixed by server-owned domain operations

### Requirement: Fixed GitHub read allowlist
The GitHub Review provider MUST execute only pull request search, listing, and read methods required by the workbench.

#### Scenario: Load workbench tabs
- **WHEN** the workbench loads Summary, Changes, Checks, or Threads
- **THEN** the provider maps the request only to approved read methods and never exposes a write tool

#### Scenario: Write capability is present in Connect
- **WHEN** the connected GitHub server also exposes comment, review, file, branch, or merge writes
- **THEN** the Review service does not advertise or execute those capabilities

### Requirement: Bounded provider data
The system SHALL bound capability discovery, pagination, text fields, patches, file lists, threads, checks, and total response sizes.

#### Scenario: Provider returns an oversized patch
- **WHEN** a pull request patch exceeds the configured bound
- **THEN** the API returns bounded data with explicit truncation metadata or a structured response-too-large error

#### Scenario: Provider pagination repeats
- **WHEN** a provider repeats a cursor or page beyond configured limits
- **THEN** the service stops traversal and reports a structured provider-contract error

### Requirement: Request isolation and cancellation
The system SHALL isolate Review reads by workspace, member-authorized connection, query identity, and selected PR.

#### Scenario: Workspace or query changes during a request
- **WHEN** an older Review request completes after the active workspace, connection, filter, or review changes
- **THEN** the older response does not replace the current query state

#### Scenario: Review surface is hidden
- **WHEN** the retained Review surface is not visible
- **THEN** background Inbox, detail, and checks polling stops

### Requirement: Structured Review failures
The Review API SHALL translate connection, authorization, workspace policy, rate-limit, timeout, provider, contract, and not-found failures into stable Review error codes and safe recovery metadata.

#### Scenario: GitHub rate limit is reached
- **WHEN** GitHub or Connect returns rate-limit information
- **THEN** the workbench preserves available data and displays a retry time without exposing raw provider responses or credentials

#### Scenario: One detail tab fails
- **WHEN** Checks or Threads fails after PR Summary loaded
- **THEN** the failed tab presents its own retry state while the remaining PR data stays available

### Requirement: Credential and content boundary
The system MUST NOT return GitHub provider credentials, Cloud MCP bearer values, raw runtime MCP configuration, or unbounded provider error content through Review APIs, logs, or renderer state.

#### Scenario: Review request is logged
- **WHEN** a Review read completes or fails
- **THEN** diagnostics contain only safe operation, workspace, connection reference, target reference, timing, count, and sanitized request identifiers
