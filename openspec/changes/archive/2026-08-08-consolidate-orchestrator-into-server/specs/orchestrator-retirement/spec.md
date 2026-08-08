## ADDED Requirements

### Requirement: Active callers migrate before removal
The system SHALL migrate every active Desktop, headless, Docker, Cloud worker, test, and release caller away from `apps/orchestrator` before deleting that package.

#### Scenario: Orchestrator package is removed
- **WHEN** `apps/orchestrator` is deleted
- **THEN** production and development code, package scripts, Electron resources, workflows, and tests no longer require its package, binary, state file, or release assets

### Requirement: Legacy runtime APIs do not spawn Orchestrator
Any temporary compatibility API retaining an `orchestrator` name SHALL delegate only to Server/Desktop runtime operations and SHALL NOT locate, spawn, or query an orchestrator binary or daemon.

#### Scenario: Compatibility status is requested
- **WHEN** a legacy Desktop caller requests orchestrator status during the compatibility period
- **THEN** Desktop returns current Server/engine state without reading an orchestrator state file or starting a daemon

### Requirement: CLI compatibility is explicit
Before removing the published orchestrator package, the project MUST either provide a tested thin replacement for the `jugglework` command or document and release an explicit retirement path.

#### Scenario: Existing CLI user upgrades
- **WHEN** a user follows the published migration guidance
- **THEN** the user can start an equivalent direct JuggleWork Server runtime or is clearly informed which retired features have no replacement

### Requirement: Orchestrator-owned state is handled safely
The migration SHALL NOT reinterpret orchestrator workspace IDs, credentials, or state files as Server state without explicit validation and conversion.

#### Scenario: Legacy state exists on upgrade
- **WHEN** `~/.jugglework/jugglework-orchestrator` contains daemon or credential state
- **THEN** the new runtime ignores it safely, imports it through a versioned migration, or provides cleanup guidance without exposing secrets

### Requirement: Distribution no longer ships unused orchestrator artifacts
After migration, Desktop and release automation SHALL stop building, signing, notarizing, uploading, publishing, or packaging orchestrator executables and npm platform packages.

#### Scenario: Desktop package is produced
- **WHEN** Electron packaging completes after orchestrator retirement
- **THEN** the application includes Server code and the OpenCode sidecar but no orchestrator executable or version asset
