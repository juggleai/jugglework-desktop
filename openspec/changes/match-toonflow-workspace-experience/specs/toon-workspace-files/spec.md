## ADDED Requirements

### Requirement: Workspace mutations use typed semantic commands
The server SHALL expose domain commands for project, canvas, folder, document, asset, and reference operations instead of accepting unrestricted filesystem mutations.

#### Scenario: User renames and moves a document
- **WHEN** the client submits a valid move command with project scope, stable document ID, destination, expected revisions, and operation ID
- **THEN** the server validates and atomically updates the file and catalog reference
- **AND** dependent stable-ID references continue to resolve

#### Scenario: Command contains an absolute or escaping path
- **WHEN** any command payload resolves outside the authorized project root or through an unsafe symlink
- **THEN** the command is rejected before reading or writing that path

### Requirement: Semantic commands are idempotent and serialized
Every mutating command MUST carry a stable operation ID and expected revisions, and the server SHALL serialize conflicting commands within a project and return the prior outcome when an operation is retried.

#### Scenario: Committed command is retried
- **WHEN** the same scoped operation ID and payload are submitted after the response was lost
- **THEN** the server returns the recorded result and revisions
- **AND** no duplicate entity or write is created

#### Scenario: Operation ID is reused with a different payload
- **WHEN** a client reuses an operation ID for a non-equivalent command
- **THEN** the server rejects it with a stable idempotency conflict

### Requirement: Multi-file commands recover from interruption
Commands that affect multiple files SHALL use a durable recovery journal with validated prepare, commit, and terminal states and SHALL reconcile incomplete operations after restart.

#### Scenario: Server stops before commit
- **WHEN** a multi-file command has only prepared temporary files at restart
- **THEN** recovery discards or safely resumes the prepared state according to the journal
- **AND** the prior committed project remains readable

#### Scenario: Server stops after files publish but before response
- **WHEN** all intended files validate as published for an operation at restart
- **THEN** recovery marks the operation committed and returns that outcome on retry
- **AND** it does not run the mutation again

### Requirement: Commands preserve referential integrity
The server MUST validate resulting catalogs and references before commit and SHALL reject a command that would create dangling IDs, incompatible node or asset references, duplicate paths, or invalid graph structure.

#### Scenario: Folder deletion contains canvases
- **WHEN** a delete command does not specify a valid recursive action or destination for contained canvases
- **THEN** the command is rejected with the affected stable IDs
- **AND** no catalog or file is changed

### Requirement: File APIs expose safe revisions and diagnostics
Read and write responses SHALL expose portable IDs, normalized project-relative paths, content revisions, and stable sanitized diagnostics without returning credentials, private provider settings, unrestricted absolute paths, or runtime database IDs.

#### Scenario: Client receives a stale-write error
- **WHEN** a command uses an outdated expected revision
- **THEN** the response identifies the conflicted portable entity and current revision
- **AND** omits private filesystem and credential material

### Requirement: Workspace commands record actor and origin
The system SHALL record whether a command originated from a human UI, autosave, migration, assistant tool, or recovery process and SHALL retain enough metadata to audit and undo supported reversible operations.

#### Scenario: Assistant changes the canvas
- **WHEN** an authorized assistant canvas command commits
- **THEN** history identifies the conversation and tool-call origin without embedding model secrets
- **AND** the corresponding reversible command can be undone under normal revision rules
