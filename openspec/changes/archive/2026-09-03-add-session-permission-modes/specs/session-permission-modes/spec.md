## Purpose

Give each interactive session an accurate, durable choice between reviewing runtime permission requests and automatically approving eligible requests without widening authority beyond that session tree.

## ADDED Requirements

### Requirement: Each root session has a visible permission mode
The system SHALL expose a permission-mode selector in each conversation composer with `Request approval` and `Full access` options. The selected value SHALL belong to the rendered root session, SHALL remain independently correct in split view, and SHALL be restored from the server that owns the workspace.

#### Scenario: New session uses request approval
- **WHEN** a new interactive root session has no saved permission mode
- **THEN** its composer shows `Request approval`

#### Scenario: Split sessions use different modes
- **WHEN** two rendered session panes have different saved permission modes
- **THEN** each composer shows and changes only its own root session's mode

#### Scenario: Owning server is unavailable
- **WHEN** the current permission mode cannot be read or changed on the server that owns the workspace
- **THEN** the selector does not claim that a requested change succeeded
- **AND** Full access is not enabled from a local-only fallback

### Requirement: Request approval presents runtime permission decisions
In `Request approval` mode, the system SHALL present permission requests that the upstream runtime actually emits and SHALL support rejection, one-time approval, and a reusable grant only when the request supplies a reusable scope. The UI SHALL describe this mode as following runtime policy rather than promising that every operation will prompt.

#### Scenario: User allows one request
- **WHEN** the user selects `Allow once` for a pending permission
- **THEN** the system resolves only that exact pending request with a one-time upstream approval

#### Scenario: Request supports a reusable scope
- **WHEN** a pending request supplies one or more reusable permission resources and the user selects `Always allow in this session`
- **THEN** the system stores a grant scoped to the visible root session and matching resources
- **AND** resolves the current request with a one-time upstream approval

#### Scenario: Request has no reusable scope
- **WHEN** a pending request supplies no reusable permission resources
- **THEN** the approval presentation does not offer an effective reusable-session action
- **AND** one-time approval and rejection remain available

#### Scenario: Upstream policy already allows an operation
- **WHEN** an upstream configured or previously saved permission allows an operation without emitting a permission request
- **THEN** Request approval does not claim that JuggleWork reviewed or prompted for that operation

### Requirement: Reusable grants are truly session-scoped
The system SHALL own reusable grants independently of protocol-native persistent approvals. A grant SHALL apply only to its workspace, root session, matching action or permission, matching resources, and descendants of that root, and SHALL NOT install an engine-wide or project-wide saved permission. Grant matching SHALL remain within the protocol and normalized action from which the grant was created.

#### Scenario: Matching request in the same session tree
- **WHEN** a root session or one of its descendants raises a future permission request fully covered by a reusable grant
- **THEN** the system resolves that exact request with a one-time upstream approval without presenting another prompt

#### Scenario: Matching request predates grant activation
- **WHEN** another matching request existed at the grant activation snapshot's authoritative linearization point, including one first delivered to the broker afterward
- **THEN** the grant does not automatically approve that request
- **AND** the exact source request explicitly approved while creating the grant is the only pre-existing request resolved by that action

#### Scenario: Request belongs to another root session
- **WHEN** another root session raises an otherwise matching request
- **THEN** the reusable grant does not approve it

#### Scenario: Request exceeds the saved scope
- **WHEN** a later permission request contains an action or resource not fully covered by the grant
- **THEN** the request remains subject to normal approval behavior

#### Scenario: Request uses a different protocol or normalized action
- **WHEN** a later request uses a different permission protocol or normalized action than the saved grant
- **THEN** the grant does not approve it

#### Scenario: Legacy or v2 runtime is used
- **WHEN** the upstream permission protocol is legacy or v2
- **THEN** the session-scoped grant does not send the protocol-native `always` response

#### Scenario: Grant creation is interrupted
- **WHEN** the current one-time approval succeeds but durable grant activation cannot be confirmed
- **THEN** the grant remains inactive
- **AND** the user is told that the current operation may have proceeded but future requests are not covered

#### Scenario: Grant semantics version is incompatible
- **WHEN** a reusable grant has an old, unknown, or malformed governing profile version
- **THEN** the grant remains inactive regardless of the root session's requested mode

### Requirement: Full access automatically approves eligible future requests
When `Full access` is enabled, the owning server SHALL automatically resolve future eligible runtime permission requests for the root session and its descendants by sending one-time upstream approvals. The system MUST NOT implement Full access by appending a blanket wildcard allow rule to the OpenCode session.

#### Scenario: Eligible request arrives after Full access is enabled
- **WHEN** a new runtime permission request belongs to a Full access root session and passes all current policy checks
- **THEN** the system resolves the exact request with a one-time upstream approval without showing an approval prompt

#### Scenario: Request was pending before the mode changed
- **WHEN** a permission request was already pending before Full access was enabled
- **THEN** that request remains pending for an explicit user decision

#### Scenario: Pre-existing request is first observed after enablement
- **WHEN** a request existed at the Full access activation snapshot's authoritative linearization point but is first delivered to the broker afterward
- **THEN** the persisted activation exclusion prevents that request from being automatically approved

#### Scenario: Runtime cannot provide a complete activation snapshot
- **WHEN** the owning runtime cannot provide a complete pending-request snapshot with a trustworthy activation boundary
- **THEN** Full access does not become effective and reusable grants do not activate

#### Scenario: User returns to request approval
- **WHEN** the user changes a root session from Full access to Request approval
- **THEN** future requests require normal approval unless covered by a subsequently created grant
- **AND** requests already dispatched or actions already running are not represented as revoked

#### Scenario: Mode changes during an active run
- **WHEN** the user changes permission mode while a task is running
- **THEN** the UI states that the change applies to subsequent requests
- **AND** the server rechecks the current mode immediately before every automatic reply

### Requirement: Full access requires explicit acknowledgement
The system SHALL require an explicit risk acknowledgement before enabling Full access for a root session and SHALL keep the active mode visibly distinguishable in the composer.

#### Scenario: User selects Full access
- **WHEN** the user selects Full access for a session that has not acknowledged the current mode profile version
- **THEN** the system explains that file, shell, network, connector, and descendant-agent actions may proceed without individual confirmation
- **AND** does not enable the mode until the user confirms

#### Scenario: Permission profile meaning changes
- **WHEN** a persisted acknowledgement refers to an older incompatible permission-mode profile version
- **THEN** automatic approval is suspended and the UI shows `Full access paused`
- **AND** Full access requires a new acknowledgement before automatic approval resumes

#### Scenario: Full access authorizing principal loses authority
- **WHEN** the principal who enabled Full access is removed, demoted below owner, or no longer belongs to the owning workspace context
- **THEN** the system durably suspends Full access and advances the authority revision before another request is dispatched
- **AND** a current owner must explicitly re-enable or re-acknowledge Full access

#### Scenario: Full access principal authority cannot be verified
- **WHEN** the owning server cannot authoritatively verify the current Full access principal's required scope
- **THEN** the system durably suspends Full access and requires explicit renewal after authority is restored

#### Scenario: Full access profile version is unsupported or malformed
- **WHEN** the persisted Full access profile version or acknowledgement version is unsupported or otherwise unsupported by the running server
- **THEN** the effective mode is `Full access paused`
- **AND** automatic approval remains disabled until a current owner explicitly accepts a supported profile version

### Requirement: Permission modes preserve hard safety boundaries
Neither permission mode nor a reusable grant SHALL override organization policy, server role and read-only checks, operating-system authorization, provider or connector scopes, disabled MCP policy, execution-time safety policy, or explicit hard-deny rules. Every human and automatic approval path SHALL pass the same server-side approval ceiling before dispatch; execution-time policy SHALL remain authoritative afterward.

#### Scenario: A hard policy denies the operation
- **WHEN** a request or operation is prohibited by a hard safety boundary
- **THEN** Full access, reusable grants, and manual one-time approval do not dispatch an approval that bypasses the boundary
- **AND** a pending request that cannot safely be approved remains rejectable and is identified as policy-blocked

#### Scenario: Caller lacks mutation authority
- **WHEN** a non-owner attempts to enable Full access, or a viewer or other unauthorized caller attempts to create a reusable grant
- **THEN** the server rejects the mutation without changing session authority

#### Scenario: Reusable-grant author loses authority
- **WHEN** the principal who created a reusable grant no longer has collaborator authority for the workspace
- **THEN** the system durably invalidates the grant and advances the authority revision before another automatic reply

#### Scenario: Reusable-grant author authority cannot be verified
- **WHEN** the owning server cannot authoritatively verify the grant author's required scope
- **THEN** the system durably invalidates the grant
- **AND** restoring the author's membership does not reactivate the old grant

#### Scenario: Organization disallows Full access
- **WHEN** the applicable organization policy prohibits session Full access
- **THEN** the Full access option is unavailable and server-side attempts to enable it fail closed

### Requirement: Modes and grants have explicit lifecycle semantics
Permission modes and reusable grants SHALL be persisted by the owning JuggleWork server and SHALL have explicit cleanup behavior. Renderer memory or local browser storage MUST NOT be the authority for automatic approval.

#### Scenario: Renderer reconnects or another client opens the session
- **WHEN** the renderer reconnects or another authorized client opens the same root session
- **THEN** it observes the authoritative saved mode and grant effects from the owning server

#### Scenario: Root session is deleted
- **WHEN** a root session is deleted
- **THEN** its saved permission mode and reusable grants are removed

#### Scenario: User clears session grants
- **WHEN** the user clears reusable grants or returns to Request approval under the default cleanup behavior
- **THEN** subsequent matching requests are no longer automatically approved by those grants

#### Scenario: Grant is cleared during automatic evaluation
- **WHEN** a matching grant is cleared before its automatic reply is dispatched
- **THEN** the changed authority revision prevents that reply from being dispatched

### Requirement: Automatic permission decisions are auditable
The system SHALL durably record sanitized permission-mode changes, reusable grant changes, and automatic permission decisions without writing credentials, unbounded command output, or raw sensitive metadata. Authority-widening changes and automatic approvals MUST persist an audit intent before taking effect and MUST record a terminal outcome afterward.

#### Scenario: Full access automatically approves a descendant request
- **WHEN** the server automatically approves a descendant's permission request
- **THEN** the audit record identifies the workspace, root session, target session, permission or action, bounded resource summary, decision source, actor, mode profile version, and timestamp

#### Scenario: Automatic approval fails policy evaluation
- **WHEN** a request is not automatically approved because a hard boundary or current mode prevents it
- **THEN** the system retains enough sanitized audit information to explain the decision without exposing secrets

#### Scenario: Audit intent cannot be persisted
- **WHEN** the system cannot durably persist the intent for Full access enablement, grant creation, or an automatic approval
- **THEN** it does not widen authority or dispatch the automatic approval

#### Scenario: Outcome cannot be confirmed after dispatch
- **WHEN** an upstream approval may have been dispatched but its terminal audit outcome cannot be confirmed
- **THEN** the durable decision remains marked indeterminate for reconciliation
- **AND** no pending reusable grant is activated from that decision

#### Scenario: Completed audit decisions expire
- **WHEN** a completed security decision exceeds the retention age or workspace count bound
- **THEN** its linked intent and terminal outcome are removed as one completed decision unit
- **AND** genuinely unresolved or indeterminate decisions remain available for reconciliation

### Requirement: Remote control cannot silently widen session authority
In the initial version, remote-control operations SHALL NOT enable Full access, create reusable session grants, or send protocol-native persistent permission approvals. The server SHALL derive controller origin from authenticated route or transport context rather than trusting a client-supplied origin field.

#### Scenario: Remote controller requests persistent authority
- **WHEN** a remote-control client attempts to enable Full access or create a reusable grant
- **THEN** the request is rejected without changing the root session's permission configuration

#### Scenario: Remote controller resolves a displayed request
- **WHEN** an authorized remote controller resolves a pending permission
- **THEN** only the existing one-time approval or rejection choices are accepted

#### Scenario: Remote request forges a local origin field
- **WHEN** a remote-control request supplies a body field that claims to originate from the local renderer
- **THEN** the authenticated remote-control context remains authoritative and persistent authority is rejected
