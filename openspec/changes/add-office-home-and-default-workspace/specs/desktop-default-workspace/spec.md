## ADDED Requirements

### Requirement: Default office workspace on first launch
The desktop shell SHALL create the local workspace `~/Documents/北数Work/日常办公` and select it when it starts with no workspace state file and no recoverable workspace. It SHALL NOT overwrite existing workspace configuration in that directory and SHALL NOT recreate the workspace once workspace state exists.

#### Scenario: First launch
- **WHEN** the desktop app starts for the first time
- **THEN** the 日常办公 workspace exists and is selected

#### Scenario: User removed every workspace
- **WHEN** workspace state exists with no workspaces
- **THEN** no default workspace is created

#### Scenario: Opt out
- **WHEN** `JUGGLEWORK_DESKTOP_DISABLE_DEFAULT_WORKSPACE=1` is set
- **THEN** no default workspace is created
