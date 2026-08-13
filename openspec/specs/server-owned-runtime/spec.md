# server-owned-runtime Specification

## Purpose
Define Server ownership of runtime state, managed OpenCode lifecycle, endpoint configuration, secrets, and JuggleWork-compatible runtime configuration.
## Requirements
### Requirement: Server is the runtime authority
JuggleWork Server SHALL be the single owner of workspace runtime state, agent runtime registry and health, session-to-runtime bindings, runtime configuration, and managed engine lifecycle for local desktop and headless operation. Server SHALL continue to own managed OpenCode and SHALL additionally supervise the independent Claude Agent Worker when that runtime is enabled; hosts remain responsible for provisioning resolved runtime assets.

#### Scenario: Desktop starts a local runtime
- **WHEN** Electron starts a local JuggleWork workspace
- **THEN** it embeds JuggleWork Server and Server starts and owns the configured managed agent engines without invoking an orchestrator process

#### Scenario: Headless starts a local runtime
- **WHEN** a headless deployment starts JuggleWork Server with one or more managed agent runtimes enabled and their resolved executables
- **THEN** Server exposes one JuggleWork API, owns runtime dispatch and health, and manages those engines without a separate orchestrator process

#### Scenario: Claude runtime is not enabled
- **WHEN** Server starts without Claude Agent enabled or provisioned
- **THEN** managed OpenCode and existing JuggleWork sessions remain available without requiring Claude worker assets

### Requirement: Runtime lifecycle is transactional
Server SHALL clean up every acquired runtime resource when startup fails and SHALL provide idempotent asynchronous shutdown after startup succeeds.

#### Scenario: OpenCode starts but HTTP Server fails
- **WHEN** managed OpenCode starts and the HTTP Server subsequently fails to bind or initialize
- **THEN** Server terminates OpenCode, unregisters trusted process identity, stops config refresh listeners, and reports the startup failure

#### Scenario: Runtime stop is invoked repeatedly
- **WHEN** multiple callers invoke stop concurrently or sequentially
- **THEN** they observe one shared cleanup operation and each resource is released at most once

### Requirement: Managed OpenCode receives valid runtime endpoints
Server SHALL inject the actual reachable JuggleWork Server URL and current runtime configuration into managed OpenCode.

#### Scenario: Preferred Server port is unavailable
- **WHEN** the requested Server port cannot be bound
- **THEN** startup either retries as a new coherent generation using the actual port or fails without leaving OpenCode configured with the unavailable port

### Requirement: Runtime secrets are not identities or logs
Server MUST keep managed credentials out of trusted process identity inputs, execution snapshots, routine logs, and non-host API responses.

#### Scenario: Managed OpenCode is registered
- **WHEN** Server registers a managed OpenCode process as trusted
- **THEN** the identity uses non-secret process generation data and does not contain the OpenCode username or password

### Requirement: Runtime configuration remains JuggleWork-compatible
The consolidated runtime SHALL preserve JuggleWork-specific environment names, database paths, workspace stores, Cloud MCP identifiers, provider/model URL behavior, managed plugins, and compaction configuration.

#### Scenario: Runtime configuration is rebuilt
- **WHEN** Server writes the engine-visible OpenCode configuration
- **THEN** Safe Grep, Context Overflow, JuggleWork cloud/tool identifiers, and explicit compaction overrides remain present
