## MODIFIED Requirements

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
