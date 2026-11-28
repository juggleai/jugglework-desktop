## MODIFIED Requirements

### Requirement: Runtime lifecycle is transactional
Server SHALL clean up every acquired runtime resource when startup fails and SHALL provide idempotent asynchronous shutdown after startup succeeds. A client receiving an active-task reload fence SHALL preserve the reload as pending without treating the current engine as unavailable. A trusted managed-engine reload SHALL use the process-wide instance-cache boundary, and Server SHALL serialize that lifecycle transition against prompt admission until the replacement workspace instance has loaded its configuration.

#### Scenario: OpenCode starts but HTTP Server fails
- **WHEN** managed OpenCode starts and the HTTP Server subsequently fails to bind or initialize
- **THEN** Server terminates OpenCode, unregisters trusted process identity, stops config refresh listeners, and reports the startup failure

#### Scenario: Runtime stop is invoked repeatedly
- **WHEN** multiple callers invoke stop concurrently or sequentially
- **THEN** they observe one shared cleanup operation and each resource is released at most once

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

#### Scenario: An idle managed workspace reloads its engine configuration
- **WHEN** an idle local workspace requests a reload from the trusted managed OpenCode process
- **THEN** Server disposes the process-wide instance cache instead of retaining a directory-scoped Runner registry
- **AND** Server loads the target workspace configuration before declaring the reload complete
- **AND** registration evidence from the disposed process generation is invalidated

#### Scenario: A new prompt arrives while the managed engine is reloading
- **WHEN** a prompt admission races with a managed-engine reload after disposal has begun
- **THEN** Server waits to submit that prompt until the reload and target-workspace readiness check complete
- **AND** the prompt does not enter the disposed Runner scope or become an immediate aborted turn
- **AND** prompt admissions that do not overlap a lifecycle reload remain concurrent
