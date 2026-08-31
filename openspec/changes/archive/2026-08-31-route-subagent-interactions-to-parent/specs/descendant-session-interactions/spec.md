## Purpose

Ensure interactions raised by hidden child and nested subagent sessions remain visible, recoverable, and actionable through the user-visible root session without weakening exact-session authorization.

## ADDED Requirements

### Requirement: Descendant interactions are presented in the visible root session
The system SHALL present pending permissions and questions raised by a child or nested descendant session in the user-visible root session that owns the subagent task. The presented interaction MUST identify that it originated from a subagent and MUST NOT require direct navigation to the hidden child session.

#### Scenario: Child requests external directory access
- **WHEN** a child session requests `external_directory` access while its root parent is visible
- **THEN** the root parent SHALL display an actionable permission request containing the requested resource

#### Scenario: Nested descendant requests approval
- **WHEN** a grandchild or deeper descendant raises a permission or question
- **THEN** the interaction SHALL be presented in the nearest user-visible root ancestor

#### Scenario: Unrelated child requests approval
- **WHEN** the visible session is not an ancestor of the requesting child
- **THEN** that child interaction SHALL NOT be presented as belonging to the visible session

### Requirement: Replies target the originating session
The system MUST retain the originating descendant session as the authoritative reply target even when the interaction is presented in a parent session. A reply SHALL be dispatched exactly once to the interaction's originating session and request identifier.

#### Scenario: Parent approves a child permission
- **WHEN** a user approves a child permission from the parent presentation
- **THEN** the permission reply SHALL use the child session identifier and original request identifier

#### Scenario: Concurrent local and remote replies
- **WHEN** local and remote controllers race to resolve the same descendant interaction
- **THEN** at most one reply SHALL be accepted and subsequent replies SHALL receive an already-resolved result

### Requirement: Pending descendant interactions survive synchronization gaps
The system SHALL reconstruct pending descendant interactions from authoritative session and interaction state after application startup, session navigation, event-stream reconnection, or a missed live event. Snapshot reconciliation MUST preserve newer live interactions and MUST remove interactions that are authoritatively resolved or expired.

#### Scenario: Application opens after child request was created
- **WHEN** a descendant interaction is already pending before the root session UI mounts
- **THEN** the interaction SHALL be discovered and displayed without requiring a new live event

#### Scenario: Live request arrives during snapshot loading
- **WHEN** a live descendant interaction arrives after snapshot reconciliation begins
- **THEN** an older snapshot SHALL NOT remove the newer live interaction

#### Scenario: Reply event is missed
- **WHEN** a descendant interaction is resolved while the event stream is disconnected
- **THEN** the next authoritative reconciliation SHALL remove the stale interaction from the parent presentation

### Requirement: Subagent task status reflects blocked interactions
When a descendant session is waiting for a permission or question, the owning parent Task SHALL be represented as waiting for user input rather than generic running. Resolving, rejecting, expiring, or aborting the interaction SHALL eventually move the Task out of the waiting state.

#### Scenario: Child waits for permission
- **WHEN** a descendant permission blocks a parent Task
- **THEN** the parent SHALL show that the Task is waiting for approval and provide access to the interaction

#### Scenario: Permission is rejected
- **WHEN** the user rejects the descendant permission
- **THEN** the child and owning Task SHALL terminate or continue according to the engine result and SHALL NOT remain indefinitely marked as waiting

### Requirement: Hidden child sessions remain hidden
Interaction aggregation SHALL NOT expose child sessions as top-level desktop sessions or change the normal session-navigation hierarchy.

#### Scenario: Parent displays child permission
- **WHEN** a parent presents an interaction from a hidden child
- **THEN** the child SHALL remain absent from top-level session navigation while the interaction remains actionable

### Requirement: Local and remote interaction views use consistent ownership
Local desktop and remote-control interaction projections SHALL resolve the same root owner and originating target for descendant interactions.

#### Scenario: Remote controller is bound to a root session
- **WHEN** a descendant of that root raises an interaction
- **THEN** the remote projection SHALL expose the interaction under the bound root while retaining the descendant as the reply target
