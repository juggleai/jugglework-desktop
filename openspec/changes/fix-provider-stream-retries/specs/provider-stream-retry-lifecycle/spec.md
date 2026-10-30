## ADDED Requirements

### Requirement: Retries release the preceding transport
The managed provider plugin SHALL abort the current attempt's fetch and await reader cancellation before retrying a pre-output timeout. Caller cancellation SHALL prevent retries and consumer cancellation SHALL reach the upstream reader and fetch signal.

#### Scenario: First byte never arrives
- **WHEN** a streaming request exceeds the first-byte deadline
- **THEN** the plugin aborts and releases that attempt before starting another request

### Requirement: Established streams are never replayed
The plugin SHALL use a single reader, preserve every inspected byte, and return as soon as the first non-empty response-body chunk is received. Role, metadata, comments, and keepalive frames SHALL establish the stream just like visible text, reasoning, or tool-call output. The plugin SHALL NOT wait for EOF or replay a request after any response-body byte.

#### Scenario: Metadata precedes reasoning
- **WHEN** a stream first emits role metadata or a keepalive while the model continues reasoning
- **THEN** the original stream is handed off immediately without waiting for visible output, EOF, or creating another attempt

### Requirement: Initial waits remain bounded and diagnosable
Default response-header and first-byte waits SHALL be 330 seconds, slightly behind the gateway's authoritative 300-second deadline. Existing timeout environment overrides SHALL remain supported. Exhausted pre-stream timeouts SHALL identify their phase. After the first body byte, the plugin SHALL NOT impose a meaningful-output deadline; the provider's outer stream-idle timeout remains bounded at 330 seconds.

#### Scenario: First byte never arrives
- **WHEN** an upstream returns headers but emits no body byte before the first-byte deadline
- **THEN** the plugin releases the attempt and applies bounded retry policy

### Requirement: Retry budget excludes established streams
For one logical managed streaming model call, the plugin SHALL allow at most two empty-body recovery rounds: the initial round and one replacement. Replacement SHALL occur only for response-header timeout, first-body-byte timeout, or zero-byte SSE EOF. Each round SHALL allow at most two underlying fetch calls, including one transient TLS handshake retry. The composed budget SHALL be at most four fetch calls, not four rounds. Neither layer SHALL replay after any response-body byte.

#### Scenario: Zero-byte response closes
- **WHEN** a managed SSE response closes without emitting any body bytes
- **THEN** the plugin may issue one replacement request and SHALL fail terminally if that request is also empty

#### Scenario: TLS handshake recovery is eligible
- **WHEN** the initial fetch in a round fails with a recognized transient TLS handshake error
- **THEN** the plugin may retry that fetch once only if the request is replayable and has not been cancelled
- **AND** a non-replayable or cancelled request SHALL NOT receive that TLS retry

#### Scenario: TLS recovery composes with empty-body recovery
- **WHEN** the first round has a TLS handshake failure followed by zero-byte SSE EOF, and the replacement round has a TLS handshake failure followed by a successful stream
- **THEN** the plugin makes exactly four underlying fetch calls across two recovery rounds and preserves the successful stream without replay

#### Scenario: Both rounds exhaust the composed budget
- **WHEN** each round has one TLS handshake failure followed by zero-byte SSE EOF
- **THEN** the plugin fails terminally after two recovery rounds and four underlying fetch calls, without issuing a fifth fetch

#### Scenario: TLS handshake retry is exhausted within a round
- **WHEN** both underlying fetch calls in one round fail with a recognized TLS handshake error
- **THEN** the second error propagates without another TLS retry or dispatching another recovery round

#### Scenario: An established metadata-only stream ends or fails
- **WHEN** a round recovers from a TLS handshake failure and emits a role or keepalive chunk, then reaches EOF or fails with a TLS-shaped read error
- **THEN** the plugin preserves the chunk and propagates EOF or the read error without replaying the request, even if an empty-body recovery round remains unused

### Requirement: Managed providers cannot bypass guarded transport
The desktop runtime SHALL bind the guarded fetch directly to organization-managed provider options and SHALL also provide bounded response-header and SSE-idle defaults in serialized runtime configuration. Exhausting the inner retry budget SHALL be terminal and SHALL NOT trigger another outer retry cycle.

#### Scenario: Provider SDK captures fetch before plugin installation
- **WHEN** a managed provider integration resolves its transport independently of the global fetch function
- **THEN** its configured provider fetch still applies the response-header deadline, cancellation, and bounded retry policy

### Requirement: Provider timeouts are actionable
The client SHALL identify response-header and initial-output timeout failures and present retry-or-switch-model guidance without suggesting context compaction.

#### Scenario: Managed model never returns response headers
- **WHEN** the bounded provider retry budget is exhausted
- **THEN** the session ends with a provider-timeout explanation instead of a generic operation-timeout message
