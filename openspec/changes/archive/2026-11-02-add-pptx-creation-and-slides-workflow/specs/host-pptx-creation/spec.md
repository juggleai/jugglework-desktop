## ADDED Requirements

### Requirement: Host-owned blank PPTX creation
The system SHALL allow a collaborator in a writable local workspace to create a new blank `.pptx` through the host-owned Office creation API, and SHALL NOT expose the native presentation lifecycle tool directly to the Agent.

#### Scenario: Create a blank presentation
- **WHEN** a user chooses a new workspace-relative path ending in `.pptx`
- **THEN** the host creates one blank presentation model, waits until the slide model reports open, saves it to that exact path, releases the temporary model, and opens the saved file through the normal Office document lifecycle

#### Scenario: Reject unavailable native creation
- **WHEN** the active Office engine does not expose its presentation creation tool
- **THEN** the host rejects creation with an explicit capability error before creating or publishing a target file

#### Scenario: Preserve existing format limits
- **WHEN** the requested path is not a supported manually creatable DOCX or PPTX path
- **THEN** the host rejects the request without opening a model or writing a file

### Requirement: User-facing Office creation actions
The desktop application SHALL offer Word and PowerPoint creation actions from supported file surfaces and SHALL resolve the chosen target through the host's native workspace path boundary.

#### Scenario: Create and open from Files
- **WHEN** a user selects the PowerPoint creation action and confirms a path inside the active local workspace
- **THEN** the application creates the PPTX and opens that path in the existing Files panel and Office editor

#### Scenario: Cancel creation
- **WHEN** the user cancels the native save dialog
- **THEN** the application creates no file, adds no file tab, and does not change the active document

#### Scenario: Reject an external target
- **WHEN** the selected target is outside the active workspace
- **THEN** the host rejects the path and the renderer does not attempt a direct file write
