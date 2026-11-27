## ADDED Requirements

### Requirement: Idle engines without terminal evidence settle after a bounded window
When the engine reports a session idle for the current run but no current terminal evidence exists, the server SHALL keep the run for a bounded settle window of 60 seconds measured from the first authoritative idle observation, and SHALL then end the run as failed and remove it from the active-run list. The window SHALL NOT start or SHALL NOT elapse while the run is starting or aborting. An observation of a different run SHALL be rejected rather than settled.

#### Scenario: Idle engine inside the window
- **WHEN** the engine reports idle, no terminal evidence exists, and less than 60 seconds have passed since the first idle observation
- **THEN** the run remains active and is marked as suspected idle

#### Scenario: Idle engine after the window
- **WHEN** the engine still reports idle with no terminal evidence 60 seconds after the first idle observation
- **THEN** the server ends the run with a failed terminal reason and the session no longer appears in active runs

#### Scenario: Engine becomes busy again
- **WHEN** the engine reports activity before the window elapses
- **THEN** the idle observation is discarded and the full window applies to any later idle observation

### Requirement: Stop is idempotent when the engine is already idle
When the engine declines an abort request, the server SHALL re-read the engine session status. If the engine reports idle, the server SHALL treat Stop as successful. If the engine reports any other status, the server SHALL continue to reject the request with the existing abort-not-accepted error.

#### Scenario: Stop after the engine already finished
- **WHEN** the user stops a run whose engine session is idle and the engine declines the abort
- **THEN** the request succeeds and the run settles through the normal lifecycle path

#### Scenario: Stop while the engine is busy
- **WHEN** the engine declines an abort while reporting a busy session
- **THEN** the server rejects the request with the abort-not-accepted error

### Requirement: Stop controls show pending state and reconcile
The renderer SHALL accept one Stop request at a time per session surface. While a Stop request is outstanding, the stop control SHALL show a progress indicator, be marked disabled, and ignore further clicks. If the request is still unresolved after 5 seconds, the renderer SHALL re-read the server's active runs and the session snapshot so that stale-projection recovery can clear a busy state the server no longer backs. The pending state SHALL end when the request settles, including when it fails.

#### Scenario: Repeated clicks while stopping
- **WHEN** the user clicks Stop again while the first request is outstanding
- **THEN** no second abort request is sent

#### Scenario: Stop request hangs
- **WHEN** a Stop request remains unresolved for 5 seconds
- **THEN** the renderer refetches active runs and the session snapshot

#### Scenario: Server no longer owns the run
- **WHEN** reconciliation shows no active server run and an idle snapshot
- **THEN** the renderer clears its busy projection and the stop control disappears
