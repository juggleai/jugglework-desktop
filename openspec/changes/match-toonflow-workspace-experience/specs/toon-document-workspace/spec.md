## ADDED Requirements

### Requirement: Document mode exposes a safe retained project file tree
The workspace SHALL provide a project-confined file tree for supported documents and previews, preserve expansion and selection state, and SHALL NOT expose paths outside the authorized project root.

#### Scenario: User expands and opens a document
- **WHEN** the user expands folders and selects a supported project document
- **THEN** the file opens in a document tab and tree state is retained across mode changes

#### Scenario: Symlink escapes the project
- **WHEN** a tree entry resolves through a symlink outside the authorized root
- **THEN** it is not traversed or opened
- **AND** the user receives a safe-path diagnostic

### Requirement: Documents support retained multi-tab editing
The document workspace SHALL support multiple tabs with active tab, ordering, dirty state, cursor, selection, scroll, and supported layout state retained while the project remains open.

#### Scenario: User switches among dirty tabs
- **WHEN** the user edits multiple documents and switches tabs or workspace modes
- **THEN** each unsaved draft and view state is retained independently
- **AND** no tab is saved or discarded merely because it became hidden

#### Scenario: User closes a dirty tab
- **WHEN** the user closes a tab with unsaved changes
- **THEN** the workspace requires save, discard, or cancel
- **AND** cancel leaves the tab and draft unchanged

### Requirement: Document saves are atomic and revision-checked
Editable documents SHALL expose content revisions, autosave or explicit save through atomic expected-revision writes, and conflict handling that never silently replaces external changes.

#### Scenario: Document revision is current
- **WHEN** a dirty tab saves with the current expected revision
- **THEN** the server atomically publishes the content and returns the next revision
- **AND** the tab becomes clean at that revision

#### Scenario: Document changed externally
- **WHEN** a save uses a stale expected revision
- **THEN** the draft remains available and the file is not overwritten
- **AND** the user can compare, reload, or save a conflict copy

### Requirement: Revision history is inspectable and non-destructive
The document workspace SHALL expose available checkpoints or saved revisions with timestamp and origin and SHALL restore an older revision only by creating a new current revision.

#### Scenario: User restores a prior revision
- **WHEN** the user previews a prior revision and confirms restore
- **THEN** the prior content is saved as a new revision
- **AND** intervening revisions remain inspectable

### Requirement: Project document search is bounded and cancellable
The workspace SHALL search supported project text files by filename and content, return path and match ranges, exclude unsafe, secret, binary, generated, or ignored locations, and support cancellation.

#### Scenario: User searches project documents
- **WHEN** the user submits a search query
- **THEN** matching authorized files and bounded line or range previews are returned incrementally
- **AND** selecting a result opens the file and reveals the match

#### Scenario: User cancels a large search
- **WHEN** the user cancels an in-progress search
- **THEN** further scanning and result delivery stop
- **AND** existing document drafts remain unchanged

### Requirement: Unsupported files use safe preview behavior
The document workspace SHALL edit only declared safe text formats and SHALL open unsupported or binary files through validated preview, metadata, or download behavior without executing active content.

#### Scenario: User opens a binary asset from the tree
- **WHEN** the file has a validated previewable media type
- **THEN** the workspace shows a safe preview and metadata instead of a text editor

#### Scenario: File type is unsupported
- **WHEN** no safe editor or preview exists
- **THEN** the workspace shows metadata and a truthful unsupported state
- **AND** does not evaluate or render the file as active code
