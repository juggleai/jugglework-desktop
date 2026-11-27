## ADDED Requirements

### Requirement: Managed engine directories are warmed in the background
Server SHALL warm the directory instance of a local workspace on a trusted managed engine by sending one read-only configuration request, without blocking the caller and without disposing the engine. Server SHALL NOT send warmup requests to engines it does not manage, to remote workspaces, or to workspaces other than the one being started, created or activated.

#### Scenario: The managed engine has just started
- **WHEN** Server starts the managed engine and has registered its trusted process identity
- **THEN** Server warms the engine's boot directory in the background before it syncs workspace MCP entries
- **AND** startup does not wait for the warmup to finish, and a warmup failure does not fail startup

#### Scenario: A local workspace is created or activated
- **WHEN** a local workspace is created or activated on a trusted managed engine
- **THEN** Server warms only that workspace's directory in the background and returns the response without waiting

#### Scenario: Warmups overlap or repeat
- **WHEN** warmups for the same engine and directory overlap
- **THEN** they share one request
- **WHEN** a warmup succeeded within the last 60 seconds and the instance was not disposed
- **THEN** no further request is sent

#### Scenario: The instance is rebuilt or the warmup fails
- **WHEN** the engine instance for a directory is disposed
- **THEN** the earlier warmup no longer counts as ready
- **WHEN** a warmup request fails or times out
- **THEN** it is not remembered as successful and the next trigger retries it

#### Scenario: An externally configured engine is used
- **WHEN** the engine is an external OpenCode address that Server does not manage
- **THEN** Server sends no warmup request
