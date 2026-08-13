# multi-agent-runtime-control Specification

## Purpose
Define JuggleWork's runtime-neutral control plane so sessions, runs, events, and persisted projections can be served by multiple agent engines without exposing engine-specific protocols to clients.
## Requirements
### Requirement: Agent runtimes are discoverable and capability-described
The system SHALL expose every enabled agent runtime with a stable identifier, display metadata, availability state, supported models, and machine-readable capability flags. The existing JuggleWork runtime SHALL remain the default unless an administrator or user explicitly selects another enabled runtime.

#### Scenario: Existing user creates a session without a runtime
- **WHEN** a compatible client creates a session without specifying a runtime
- **THEN** the system creates it with the existing JuggleWork runtime and preserves current behavior

#### Scenario: Client inspects available runtimes
- **WHEN** a client requests runtime descriptors
- **THEN** the response identifies unavailable runtimes and the controls supported by each available runtime

### Requirement: A session has one immutable runtime binding
Every JuggleWork session SHALL have a persisted runtime identifier, backend session identifier, canonical workspace directory, and creation-time configuration snapshot. The runtime binding MUST NOT change after the session is created.

#### Scenario: Session is created with Claude Agent
- **WHEN** an authorized client creates a session with the enabled Claude Agent runtime
- **THEN** the session is durably bound to that runtime before its first run starts

#### Scenario: Client attempts in-place runtime mutation
- **WHEN** a client attempts to change the runtime of an existing session
- **THEN** the system rejects the request and directs the client to create a linked cross-runtime fork

### Requirement: Server dispatches through a runtime-neutral contract
Session creation, reads, run start, abort, interactions, runtime configuration, and event subscription SHALL be routed by the session's persisted runtime binding. Public JuggleWork APIs MUST NOT require clients to call an engine-specific endpoint for a non-legacy session.

#### Scenario: Two runtime sessions run concurrently
- **WHEN** one OpenCode-backed session and one Claude-backed session start runs
- **THEN** Server dispatches each run to its bound engine while preserving independent status and cancellation

#### Scenario: Runtime is unavailable
- **WHEN** a bound runtime is disabled, unhealthy, or unsupported on the host
- **THEN** reads remain available from the canonical projection and new mutations fail with a stable runtime-unavailable error

### Requirement: Canonical session projections are engine-neutral
The system SHALL expose canonical session, message, content-part, status, todo, interaction, usage, and event shapes for all runtimes. Backend identifiers and engine-specific payloads MAY be retained as bounded metadata but MUST NOT be required for ordinary client rendering or control.

#### Scenario: Client renders tool activity from either runtime
- **WHEN** either runtime emits a tool call, progress, result, or failure
- **THEN** the client receives the same canonical tool lifecycle states and stable canonical identifiers

#### Scenario: Streaming delta is followed by a complete message
- **WHEN** a runtime emits both incremental content and a final complete message
- **THEN** the canonical projection finalizes the existing content rather than duplicating it

### Requirement: Canonical state is durable and replayable
Server SHALL persist runtime mappings and a canonical projection sufficient to list and read sessions when an engine is stopped. Canonical events SHALL carry stable identifiers and monotonic per-session ordering so reconnecting clients can reconcile snapshots and live events.

#### Scenario: Client reconnects after missing events
- **WHEN** a client reconnects after its event cursor has fallen behind
- **THEN** it can obtain a canonical snapshot and continue without duplicated messages or regressed status

#### Scenario: Backend resume identifier becomes known after startup
- **WHEN** an engine reports its backend session identifier during the first run
- **THEN** Server atomically records the mapping without changing the public JuggleWork session identifier

### Requirement: Cross-runtime continuation creates a linked fork
The system SHALL support continuing an idle session with another enabled runtime by creating a new session linked to the source. The new session SHALL receive a bounded, inspectable migration context and SHALL NOT import executable tool state, pending interactions, hidden prompts, or backend compaction state.

#### Scenario: User continues an OpenCode session with Claude
- **WHEN** the user confirms a cross-runtime continuation
- **THEN** the system creates a new Claude session, records a fork link, and seeds it with an attributed text summary or selected transcript context

#### Scenario: Source session has an active run
- **WHEN** a cross-runtime continuation is requested while the source session is busy
- **THEN** the system rejects or defers the operation rather than copying unstable in-flight state

### Requirement: Existing OpenCode sessions remain compatible
Existing sessions without a JuggleWork runtime mapping SHALL be lazily recognized as JuggleWork/OpenCode sessions and SHALL remain readable and runnable throughout the migration.

#### Scenario: Legacy session is first opened after upgrade
- **WHEN** Server reads an existing OpenCode session that has no runtime mapping
- **THEN** it returns the session as bound to the default JuggleWork runtime without changing its backend identifier
