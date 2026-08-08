# desktop-sandbox-runtime Specification

## Purpose
Define Desktop-owned sandbox provisioning, direct Server container runtime behavior, mount protections, and bounded lifecycle operations.

## Requirements

### Requirement: Desktop owns sandbox provisioning
Electron SHALL own host-level sandbox discovery, validation, creation, diagnostics, stopping, and cleanup without requiring a JuggleWork orchestrator sidecar.

#### Scenario: User starts a Desktop Docker sandbox
- **WHEN** Desktop receives a valid request to start a Docker-backed sandbox
- **THEN** a Desktop runtime module validates the request, creates the container, and returns the JuggleWork Server connection details

### Requirement: Sandbox containers run Server directly
Each Desktop-created sandbox container SHALL run JuggleWork Server directly with Server-managed OpenCode.

#### Scenario: Sandbox container becomes healthy
- **WHEN** Desktop launches a sandbox container
- **THEN** the container starts `jugglework-server`, Server starts OpenCode internally, and Desktop waits for the Server health endpoint

### Requirement: Sandbox mount protections are preserved
Desktop sandbox provisioning MUST retain explicit mount allowlisting, path normalization, and sensitive-path rejection before host paths are mounted into a container.

#### Scenario: Sensitive credential directory is requested
- **WHEN** a sandbox request attempts to mount a blocked path such as an SSH, cloud credential, key, or environment-secret location
- **THEN** Desktop rejects the mount before invoking the container runtime

### Requirement: Sandbox lifecycle is observable and bounded
Desktop SHALL expose sandbox doctor, start, stop, cleanup, inspect/log diagnostics, and debug probe operations with bounded timeouts and validated managed-container names.

#### Scenario: Stop targets an unmanaged container
- **WHEN** a caller asks Desktop to stop a container whose name is outside the JuggleWork managed namespace
- **THEN** Desktop rejects the operation and does not invoke a destructive container command
