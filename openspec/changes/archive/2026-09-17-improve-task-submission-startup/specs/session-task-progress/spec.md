## ADDED Requirements

### Requirement: Immediate task submission preparation feedback

The system SHALL present a session-scoped preparation state synchronously when the user submits an idle composer draft, before asynchronous resume, connector, attachment, environment, or server-acceptance work completes. The presentation MUST distinguish preparation from an accepted running task and MUST prevent duplicate submission of the same draft.

#### Scenario: Submission starts asynchronous preflight

- **WHEN** the user submits a valid idle composer draft
- **THEN** the active session immediately shows that the task is being prepared
- **AND** the submit control is disabled until the attempt is accepted, blocked, cancelled, or fails
- **AND** no running state is claimed before server acceptance

#### Scenario: Preparation does not accept the task

- **WHEN** preparation is blocked, cancelled, or fails before server acceptance
- **THEN** the preparation state clears
- **AND** the original draft text and attachments remain available for correction or retry

### Requirement: Reuse recent Cloud MCP readiness evidence

The system SHALL submit an ordinary draft that does not explicitly select a Cloud skill, extension, or Cloud MCP capability without blocking on Connect readiness. For an explicit Cloud capability draft, the system SHALL reuse only recent successful Cloud MCP readiness evidence for an unchanged account, organization, workspace, provider, and model scope. It SHALL revalidate aging evidence in the background without blocking the current submission, and SHALL return to blocking verification after expiry, scope change, or failed revalidation.

#### Scenario: Ordinary task uses the non-Connect fast path

- **WHEN** a valid draft contains no explicitly selected Cloud capability
- **THEN** submission does not wait for Cloud MCP health probing or repair
- **AND** failures from another session's readiness coordinator cannot block or duplicate this task

#### Scenario: Closely spaced submission uses positive evidence

- **WHEN** Cloud MCP readiness was successfully verified recently for the same submission scope
- **AND** a new task is submitted before that evidence expires
- **THEN** the task proceeds without waiting for another full readiness probe

#### Scenario: Aging evidence is refreshed without delaying the task

- **WHEN** cached readiness is still valid but has reached its background-refresh age
- **THEN** the current task proceeds using the cached positive evidence
- **AND** one deduplicated background revalidation refreshes or invalidates that evidence

#### Scenario: Readiness evidence is not reusable

- **WHEN** no successful evidence exists, the evidence expired, the scope changed, or background revalidation invalidated it
- **THEN** the next task uses the existing blocking readiness and repair flow
