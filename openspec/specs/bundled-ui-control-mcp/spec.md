# bundled-ui-control-mcp Specification

## Purpose

Ensure JuggleWork's built-in semantic UI-control MCP is shipped as a verified part of every Desktop installation and remains usable without npm, network access, or a separately installed Node runtime.

## Requirements

### Requirement: Desktop ships a self-contained UI-control MCP
Every supported Desktop artifact SHALL contain the JuggleWork UI-control MCP and all JavaScript runtime dependencies required to start it.

#### Scenario: Package is assembled
- **WHEN** a macOS, Windows, or Linux Desktop artifact is assembled
- **THEN** the artifact contains the UI-control MCP at a stable application-resource path
- **AND** starting that resource does not require dependency installation or package-registry access

#### Scenario: Bundled resource is missing
- **WHEN** the Desktop packaging pipeline cannot find the prepared UI-control MCP resource
- **THEN** packaging fails instead of producing an artifact that falls back to a network command

### Requirement: Production uses only bundled runtime components
Packaged Desktop SHALL start the built-in UI-control MCP using the application's own executable runtime and bundled resource path, without invoking `npm`, `npx`, `node`, or another executable resolved from the user's PATH.

#### Scenario: Offline production launch
- **WHEN** a user starts JuggleWork without network access and without Node.js installed
- **THEN** the built-in UI-control MCP can start and connect to the local JuggleWork UI bridge

#### Scenario: Development launch
- **WHEN** JuggleWork runs in repository development mode
- **THEN** the UI-control MCP may run directly from the source checkout while preserving the same bridge protocol

#### Scenario: Existing workspace uses the legacy npm command
- **WHEN** an upgraded Desktop loads an enabled `jugglework-ui` entry that still invokes the legacy npm command
- **THEN** Desktop replaces that entry with the current stable bundled command and runtime environment only for its local embedded workspace
- **AND** the migration preserves unrelated MCP fields and aborts if the authoritative command or enabled state changed concurrently
- **AND** a user-disabled entry remains disabled and is not automatically reinstalled

#### Scenario: Existing workspace uses a prior app-managed bundle
- **WHEN** an upgraded Desktop loads an enabled runtime-managed `jugglework-ui` entry that points at an earlier versioned profile bundle
- **THEN** Desktop replaces it with the current app-managed runtime and bundle paths
- **AND** a custom, project-scoped, or global command remains unchanged

### Requirement: Packaged MCP startup is mechanically verified
The release pipeline SHALL verify that the packaged UI-control MCP can start under the packaged application runtime and complete MCP protocol initialization over stdio.

#### Scenario: Valid packaged MCP
- **WHEN** packaged-app verification runs against a complete artifact
- **THEN** the verifier starts the bundled MCP, completes an `initialize` request, receives the expected server identity, and terminates the child process cleanly

#### Scenario: Bundle has an unresolved dependency
- **WHEN** the embedded MCP still requires a module that is absent from the artifact
- **THEN** the packaged-app verification fails before release

### Requirement: UI-control discovery remains scoped to the running app
The bundled MCP SHALL use the discovery path supplied by the Desktop process to locate the current JuggleWork bridge and SHALL NOT embed bridge tokens, ports, credentials, or machine-specific absolute paths in the packaged resource.

#### Scenario: Desktop bridge endpoint changes
- **WHEN** a new JuggleWork process writes a discovery file with a different local bridge port or token
- **THEN** a newly started bundled MCP resolves the new values at runtime from that discovery file
