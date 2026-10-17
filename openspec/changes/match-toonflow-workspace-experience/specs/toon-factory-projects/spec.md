## ADDED Requirements

### Requirement: Portable project schema v2 describes the retained workspace
The portable v2 project format SHALL describe stable project, canvas-folder, canvas, document, asset, node-configuration, workflow, and public model references using versioned project-relative files, and SHALL exclude credentials, absolute paths, OpenCode session IDs, database row IDs, leases, and other runtime-only state.

#### Scenario: A v2 project is reopened on another machine
- **WHEN** its complete directory is copied into an authorized workspace with required files intact
- **THEN** the server reconstructs the canvas, document, asset, workflow, and model selections from portable data
- **AND** missing runtime mappings are recreated locally

#### Scenario: Portable files contain runtime-only fields
- **WHEN** a v2 write attempts to persist credentials, absolute paths, local session IDs, or SQLite identifiers
- **THEN** schema validation rejects the write

### Requirement: Runtime state maps to portable entities without becoming canonical
The system SHALL store project discovery, session lineage, visibility, event cursors, operation outcomes, leases, recovery journals, and generation runtime links in SQLite keyed by workspace scope and portable IDs, while portable files remain the durable content authority.

#### Scenario: Runtime database mappings are missing
- **WHEN** a valid portable project opens without its prior SQLite rows
- **THEN** reconstructible mappings are recreated
- **AND** portable project content is not treated as missing or rewritten solely for that reason

#### Scenario: Runtime mapping is orphaned
- **WHEN** a mapped project root remains unavailable beyond the configured grace period
- **THEN** runtime rows can be garbage-collected
- **AND** no project files are deleted by runtime cleanup

### Requirement: Migration from v1 to v2 is explicit and recoverable
The system MUST preflight and obtain user confirmation before migrating a v1 project, use a recovery journal and validated backup manifest, commit the root schema switch last, and preserve the original on any failed migration.

#### Scenario: Migration succeeds
- **WHEN** preflight passes and the user confirms migration
- **THEN** the server writes and validates all v2 catalogs and files before atomically publishing the v2 root metadata
- **AND** reports the backup and rollback eligibility

#### Scenario: Migration is interrupted
- **WHEN** the process stops at any migration crash point
- **THEN** startup recovery either completes the validated commit or restores the pre-migration project
- **AND** the project is never presented as successfully migrated with missing required files

#### Scenario: User declines migration
- **WHEN** a v1 project requires v2 behavior and the user declines
- **THEN** the project remains unchanged and available through supported v1 behavior
- **AND** v2-only edits remain disabled

### Requirement: Downgrade and rollback are non-destructive
The application SHALL retain v2 read or export support when advanced features are disabled and SHALL NOT perform a lossy automatic downgrade; in-place v1 restoration is allowed only while the validated backup remains compatible and no v2-only edits would be lost.

#### Scenario: Feature rollout is rolled back
- **WHEN** advanced workspace exposure is disabled after v2 projects exist
- **THEN** users can safely read or export those projects
- **AND** project files are not deleted or rewritten to v1 automatically

#### Scenario: Project contains v2-only edits
- **WHEN** the user requests rollback to a v1 backup after creating v2-only content
- **THEN** the application blocks lossy in-place downgrade and offers a validated copy or export path
