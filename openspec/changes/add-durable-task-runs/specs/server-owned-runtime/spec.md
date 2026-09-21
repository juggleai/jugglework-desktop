## MODIFIED Requirements

### Requirement: Server is the runtime authority
JuggleWork Server SHALL be the single owner of workspace runtime state, managed OpenCode connection state, runtime configuration, engine lifecycle, and durable Task Run execution state for local desktop and headless operation.

#### Scenario: Desktop starts a local runtime
- **WHEN** Electron starts a local JuggleWork workspace
- **THEN** it embeds JuggleWork Server and Server starts and owns the managed OpenCode child without invoking an orchestrator process

#### Scenario: Headless starts a local runtime
- **WHEN** a headless deployment starts JuggleWork Server with managed OpenCode enabled and a resolved OpenCode executable
- **THEN** Server exposes the JuggleWork API and manages OpenCode without a separate orchestrator process

#### Scenario: Client observes or controls a managed task
- **WHEN** Desktop, a remote controller, or another client reads, resumes, or cancels a managed task
- **THEN** it uses Server-owned Task Run state and fenced commands rather than treating renderer memory or transcript presentation as execution authority

## ADDED Requirements

### Requirement: Runtime startup reconciles durable task state
Server SHALL reconcile persisted non-terminal Task Runs after runtime initialization and MUST complete that reconciliation without re-dispatching original task prompts as a startup side effect.

#### Scenario: Runtime returns after interruption
- **WHEN** Server starts and finds one or more non-terminal Task Runs
- **THEN** it compares them with authoritative engine and Operation state and schedules only safe reconciliation or recovery work

#### Scenario: Runtime shuts down during reconciliation
- **WHEN** Server shutdown begins while durable task reconciliation is active
- **THEN** reconciliation stops idempotently and leaves persisted state valid for the next startup
