## ADDED Requirements

### Requirement: Project assets have a stable portable catalog
The system SHALL catalog imported and generated project assets by stable ID, project-relative path, validated media type, size, checksum, dimensions or duration when known, origin, and lifecycle state.

#### Scenario: Project is copied to another authorized workspace
- **WHEN** a valid project directory and its assets are copied and opened elsewhere
- **THEN** portable asset IDs and relative references remain valid
- **AND** machine-local runtime identifiers are rebuilt rather than required from project files

### Requirement: Asset import validates source and content
The system MUST validate source authorization, normalized destination, filename, size limits, MIME signature, and supported type before atomically publishing an imported asset.

#### Scenario: User imports a valid image
- **WHEN** the user selects an authorized image whose signature and limits are valid
- **THEN** the image is copied into project-controlled storage and cataloged once
- **AND** it becomes available to nodes, documents, mentions, and generation references

#### Scenario: Extension and signature disagree
- **WHEN** an imported file extension claims a supported media type but its signature does not match
- **THEN** the import is rejected before catalog publication
- **AND** no partial asset remains visible

### Requirement: Assets are searchable, previewable, and reusable
The workspace SHALL let users browse, filter, search, inspect metadata, safely preview, and reuse project assets without duplicating bytes solely to create another reference.

#### Scenario: User attaches an existing asset to another node
- **WHEN** the user selects a cataloged asset for a compatible node
- **THEN** the node stores the stable asset reference
- **AND** the existing asset file and provenance are reused

#### Scenario: Active content is selected for preview
- **WHEN** an asset could execute scripts or active embedded content
- **THEN** the preview is sanitized, sandboxed, or disabled
- **AND** opening the asset does not execute project-provided code

### Requirement: Asset references govern safe lifecycle operations
The system SHALL track references from canvases, documents, workflow records, assistant history, generation records, and adoption records, and SHALL prevent unacknowledged deletion of referenced assets.

#### Scenario: User deletes an unreferenced imported asset
- **WHEN** the asset has no retained references and the user confirms deletion
- **THEN** it enters recoverable trash or tombstone state before bounded cleanup
- **AND** it no longer appears in normal pickers

#### Scenario: User deletes a referenced asset
- **WHEN** retained references exist
- **THEN** the system lists affected references and blocks deletion or requires an explicit supported replacement or destructive confirmation
- **AND** denial leaves the asset and references unchanged

### Requirement: Generated asset history remains truthful
Generated candidates SHALL retain request, model, artifact, review, and adoption provenance independently from the current asset catalog presentation.

#### Scenario: Adopted candidate is superseded
- **WHEN** the user adopts a different candidate for the same production role
- **THEN** the new adoption becomes current
- **AND** the prior candidate, artifact metadata, and historical adoption remain inspectable
