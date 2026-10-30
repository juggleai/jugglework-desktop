## MODIFIED Requirements

### Requirement: Runtime lifecycle is transactional
Server SHALL clean up every acquired runtime resource when startup fails and SHALL provide idempotent asynchronous shutdown after startup succeeds. A client receiving an active-task reload fence SHALL preserve the reload as pending without treating the current engine as unavailable.

#### Scenario: Another workspace requests a shared engine reload during an active task
- **WHEN** any workspace has an active task and a different workspace requests an explicit managed-engine reload
- **THEN** Server rejects or defers the reload without disposing the shared engine until every active task has reached a terminal state
- **AND** Desktop keeps the reload pending without recording a terminal reload error
- **AND** Desktop retries the reload after activity settles or after a bounded retry cooldown
- **AND** the existing engine remains available for new task submission while the reload is pending or deferred

#### Scenario: Engine reload fails for a non-deferred reason
- **WHEN** an engine reload fails for a reason other than the active-task reload fence
- **THEN** Desktop surfaces the reload failure for diagnosis and manual retry
- **AND** the failure does not disable task submission through the still-running engine
