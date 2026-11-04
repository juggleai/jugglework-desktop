## MODIFIED Requirements

### Requirement: Reconnect performs authoritative reconciliation

On the first successful event-stream connection as well as reconnection, the client SHALL reconcile tracked session snapshots and active-run state. Reading active runs SHALL NOT block opening or consuming the event stream. Late active-run reads SHALL NOT resurrect terminal runs or overwrite newer generations. The client SHALL share one event transport per workspace endpoint, SHALL NOT infer transport failure solely from a period without business events, and SHALL use bounded backoff before reconnecting a transport that actually ends or fails.

#### Scenario: Idle event was lost during disconnect
- **GIVEN** the event stream disconnects while a run appears active
- **AND** the engine becomes idle before reconnection
- **WHEN** the event stream reconnects
- **THEN** the client refreshes the authoritative snapshot and active-run state
- **AND** stale running projections are terminalized

#### Scenario: Messages precede the first stream connection
- **GIVEN** a task was accepted before the event stream connected
- **WHEN** the first stream connection succeeds
- **THEN** tracked session snapshots are refreshed without requiring navigation

#### Scenario: Quiet workspace retains its connection
- **GIVEN** a workspace event stream connected successfully
- **WHEN** no session, message, todo, or tool event is emitted for longer than the activity watchdog interval
- **THEN** the client keeps the existing event transport open
- **AND** it does not force a session-list refresh merely because the workspace is quiet

#### Scenario: Event transport ends
- **WHEN** the event transport ends or fails with a retryable error
- **THEN** the client opens at most one replacement transport after bounded exponential backoff with jitter
- **AND** the successful replacement performs authoritative reconciliation

