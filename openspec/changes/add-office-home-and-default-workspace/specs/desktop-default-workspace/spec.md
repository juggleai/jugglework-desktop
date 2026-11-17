## ADDED Requirements

### Requirement: Default office workspace on first launch
The desktop shell SHALL create the local workspace `~/Documents/北数Work/日常办公` and select it when it starts with no local workspace and the default office workspace has not been provisioned yet. Provisioning SHALL be tracked by a `defaultWorkspaceProvisioned` flag in the workspace state file: any state file that already contains workspaces counts as provisioned, and a state file that was written as an empty list before provisioning (older build, interrupted provisioning, or a failed creation attempt) still provisions exactly once. It SHALL NOT overwrite existing workspace configuration in that directory and SHALL NOT recreate the workspace once provisioning succeeded.

#### Scenario: First launch
- **WHEN** the desktop app starts with no workspace state file and no recoverable workspace
- **THEN** the 日常办公 workspace exists and is selected
- **AND** the state file records `defaultWorkspaceProvisioned: true`

#### Scenario: Empty state file written before provisioning
- **WHEN** the workspace state file exists with an empty workspace list and no provisioning flag
- **THEN** the 日常办公 workspace is created and selected

#### Scenario: Existing workspaces without a provisioning flag
- **WHEN** the workspace state file already contains workspaces but no provisioning flag
- **THEN** no default workspace is added and the state file is marked as provisioned

#### Scenario: User removed every workspace
- **WHEN** the state file is marked as provisioned and contains no workspaces
- **THEN** no default workspace is created

#### Scenario: Opt out
- **WHEN** `JUGGLEWORK_DESKTOP_DISABLE_DEFAULT_WORKSPACE=1` is set
- **THEN** no default workspace is created
