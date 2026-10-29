# Session creation retry identity

## Purpose
Prevent duplicate desktop sessions when client transport fails after server admission.

## Requirements

### Requirement: Stable creation intent
Managed desktop SDK session creation SHALL retain a timestamped UUID intent after timeout or disconnection, scoped by endpoint/workspace/directory and credential identity. A consumed successful response SHALL retire it; a subsequent creation SHALL receive a new intent. An unresolved different payload SHALL be rejected rather than silently creating another session.

#### Scenario: Late success
- **WHEN** a client times out while the engine is creating a session
- **THEN** retry uses the original intent and receives the same session without another engine POST

### Requirement: Authenticated admission ledger
Every request SHALL pass current authentication and proxy permissions before lookup. The process-local ledger SHALL scope entries by workspace, upstream endpoint, authenticated token digest and permission scope, and reject changed request URL/directory/body for the same key. Credentials SHALL NOT appear in logs or UI keys.

#### Scenario: Concurrent retry or changed credentials
- **WHEN** two authenticated requests use the same scoped intent
- **THEN** they share one upstream operation and independent response bodies
- **AND** a revoked credential cannot replay a cached result

### Requirement: Bounded conservative recovery
The ledger SHALL retain results for a 24-hour timestamped intent window, reject expired keys, cap admission at 1024 entries, and never evict pending work to admit another create. Definitive validation/auth rejection responses SHALL NOT be cached as permanent failures. Upstream disconnection or ambiguous failure SHALL block re-execution of that intent. Client AbortSignal SHALL NOT cancel admitted engine creation.

#### Scenario: Unknown upstream outcome
- **WHEN** the upstream connection fails with no authoritative result
- **THEN** retries report unknown outcome and do not issue another POST

## Boundaries
This is a process-local protocol, not durable exactly-once execution. Server restart loses the admission ledger; renderer reload loses unresolved intents. Reconcile session history before retry across either boundary. No engine-specified session ID is assumed: installed SDK 1.19.3 v2 Session.create exposes parentID/title/agent/model/metadata/permission/workspaceID, not sessionID. Legacy callers without the intent header and server-internal/CLI creation are unchanged. Direct unmanaged engine connections cannot use this proxy guarantee. Client clock skew beyond one minute is rejected. Payload equality is exact serialized bytes plus URL/directory, intentionally conservative.
