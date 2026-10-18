## ADDED Requirements

### Requirement: Desktop isolates packaged application sidecars
Electron SHALL provision packaged application sidecars with dedicated process, browser-storage, network, capability, logging, and shutdown boundaries instead of granting them the main renderer or server authority.

#### Scenario: Packaged sidecar opens an embedded application
- **WHEN** Desktop starts the managed Toonflow sidecar
- **THEN** the child receives only its allowlisted environment and instance capabilities, and its sandboxed view receives no privileged preload bridge

### Requirement: Sidecar process trees are bounded and observable
Desktop SHALL expose non-secret sidecar lifecycle status and diagnostics and MUST terminate the complete managed process tree within bounded shutdown deadlines on every authority-revoking lifecycle event.

#### Scenario: Sidecar spawns a helper process
- **WHEN** the sidecar or an approved built-in tool starts a helper and the workspace authority is revoked
- **THEN** Desktop cleanup terminates both the sidecar and its managed helper process tree
