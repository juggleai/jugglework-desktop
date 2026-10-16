## ADDED Requirements

### Requirement: A workspace can contain multiple portable Toon Factory projects
The system SHALL allow multiple Toon Factory projects under an authorized workspace and SHALL store each project's durable content in a versioned project directory.

#### Scenario: User creates a project
- **WHEN** the user supplies a valid project name and workspace-relative directory
- **THEN** the server creates versioned project metadata, initial canvases, content, asset, generation-manifest, and export locations
- **AND** the project appears in the workspace's Toon Factory project list

#### Scenario: User opens an existing project
- **WHEN** a supported `toon-project.json` exists inside the authorized workspace
- **THEN** the server validates and returns the project without requiring an app-global project database record

### Requirement: Project writes are confined and conflict-aware
The server MUST normalize all Toon Factory paths, reject traversal and unsafe symlink escapes, write durable files atomically, and support revision-checked updates.

#### Scenario: Client writes the expected revision
- **WHEN** the client submits a valid update with the current revision
- **THEN** the server atomically publishes the update and returns a new revision

#### Scenario: Project content changed externally
- **WHEN** the submitted expected revision does not match the current file revision
- **THEN** the server rejects the update with a stable stale-content error
- **AND** the existing file is not overwritten

#### Scenario: Requested path escapes the workspace
- **WHEN** a project, canvas, content, asset, or export path resolves outside the authorized workspace
- **THEN** the server rejects the request without reading or writing the escaped path

### Requirement: Canvases preserve typed graph state
The system SHALL persist versioned canvases containing unique nodes, typed handles, valid edges, and viewport state, and SHALL reject structurally invalid graphs with recoverable diagnostics.

#### Scenario: Valid canvas is saved and reopened
- **WHEN** a canvas contains unique node IDs, compatible source and target handles, and a valid viewport
- **THEN** reopening the canvas restores its nodes, edges, positions, and viewport

#### Scenario: Edge targets an absent or incompatible handle
- **WHEN** a canvas update contains an edge whose endpoint is missing or whose data types are incompatible
- **THEN** the server rejects the canvas update with node and edge diagnostics

### Requirement: Long text and media remain project-relative
The system SHALL store long node text outside canvas JSON and SHALL represent media outputs with project-relative paths and validated MIME metadata.

#### Scenario: Text node is persisted
- **WHEN** a user saves long script, asset, or storyboard text
- **THEN** the body is written under the project's content directory
- **AND** the canvas stores a stable content reference rather than duplicating the full body

#### Scenario: Media output is attached to a node
- **WHEN** an image or video generation succeeds
- **THEN** the node references a validated project- or workspace-relative artifact
- **AND** the canvas does not store provider credentials or an arbitrary absolute path

### Requirement: Unsupported project versions fail safely
The system SHALL validate project and canvas schema versions and SHALL NOT destructively rewrite a newer unsupported version.

#### Scenario: Project version is newer than the application supports
- **WHEN** the user opens a project with an unsupported newer schema version
- **THEN** the workbench shows a read-safe compatibility error
- **AND** no migration or save is attempted automatically
