## ADDED Requirements

### Requirement: Projects provide an ordered multi-canvas catalog
The system SHALL let a project contain multiple canvases organized into ordered folders, with stable canvas and folder IDs independent of display names and paths.

#### Scenario: User creates and organizes canvases
- **WHEN** the user creates a canvas, creates a folder, and moves the canvas into that folder
- **THEN** the catalog persists the stable IDs, folder membership, names, and order
- **AND** reopening the project restores the same organization and active canvas

#### Scenario: User renames a canvas with open references
- **WHEN** the user renames a canvas referenced by a workflow record or assistant message
- **THEN** the references remain valid through the stable canvas ID
- **AND** the new display name appears without rewriting historical message text

### Requirement: P0 canvas editing is complete and keyboard-operable
The canvas SHALL support node creation, selection, multi-selection, movement, connection, disconnection, deletion, keyboard movement, copy, cut, paste, duplicate, undo, redo, pan, zoom, reset, and fit-to-content using domain commands.

#### Scenario: User edits a selection with shortcuts
- **WHEN** focus is on the canvas and the user selects nodes then invokes platform copy, paste, duplicate, delete, undo, and redo shortcuts
- **THEN** each enabled command updates the graph deterministically
- **AND** pasted or duplicated entities receive new stable IDs with valid internal edges

#### Scenario: User navigates without a pointer
- **WHEN** the user uses keyboard focus and arrow commands on the canvas
- **THEN** focus and selection are visible and movable without requiring pointer input
- **AND** keyboard movement can be undone as one coalesced command

#### Scenario: User attempts an invalid connection
- **WHEN** the user connects absent, directionally invalid, or type-incompatible handles
- **THEN** the edge is rejected with an accessible reason
- **AND** no invalid edge is persisted or added to history

### Requirement: P1 spatial arrangement tools preserve graph semantics
The canvas SHALL provide grouping and ungrouping, alignment, distribution, snapping guides, z-order controls, minimap navigation, drag/drop import, and supported auto-arrangement without changing node data or typed edges.

#### Scenario: User aligns a group
- **WHEN** the user multi-selects nodes and chooses an alignment or distribution command
- **THEN** only node positions change according to the command
- **AND** one undo restores all prior positions

#### Scenario: User groups selected nodes
- **WHEN** the user groups selected nodes and later ungroups them
- **THEN** membership and relative placement are preserved
- **AND** edges to nodes inside and outside the group remain valid

#### Scenario: User imports supported files by dropping them
- **WHEN** the user drops supported authorized files on the canvas
- **THEN** the system creates project assets and corresponding nodes at the drop location
- **AND** unsupported or unsafe files are rejected without partial nodes

### Requirement: Canvas history is bounded and revision-aware
The client SHALL maintain bounded command history per open canvas, coalesce compatible continuous edits, and SHALL NOT apply undo or redo across an unresolved external revision conflict.

#### Scenario: Dragging creates one history entry
- **WHEN** a node emits multiple position updates during one pointer drag
- **THEN** the completed drag is recorded as one undoable command

#### Scenario: External content changes before undo
- **WHEN** a newer server revision conflicts with local pending history
- **THEN** autosave and history application pause for that canvas
- **AND** the user is offered reload, compare, or conflict-copy recovery instead of silent overwrite

### Requirement: Canvas autosave is safe and recoverable
The canvas SHALL autosave dirty domain changes after a bounded debounce, flush before project or canvas transitions when possible, use expected revisions and stable operation IDs, and recover acknowledged or pending commands after restart without duplicate application.

#### Scenario: User switches canvases with pending edits
- **WHEN** the active canvas has pending edits and the user opens another canvas
- **THEN** the system attempts an immediate revision-checked flush
- **AND** either opens the new canvas after success or preserves the draft and presents the blocking conflict

#### Scenario: Response is lost after a save commits
- **WHEN** the server commits an autosave but the client does not receive the response
- **THEN** retrying the same operation ID returns the committed outcome
- **AND** the command is not applied twice

### Requirement: Visible canvas runtimes stay alive without wasting hidden work
The workspace SHALL maintain a bounded lease or heartbeat for the active canvas editor, retain serializable viewport, selection, and draft state across navigation, and suspend animation, polling, and expensive graph rendering while hidden.

#### Scenario: User leaves and returns to a project
- **WHEN** the user navigates away from a visible dirty canvas and returns before its retained state is evicted
- **THEN** the same canvas, viewport, selection, and draft are restored
- **AND** hidden time did not continue unnecessary rendering or polling

#### Scenario: Editor lease expires after a crash
- **WHEN** the client stops heartbeats with acknowledged or journaled operations outstanding
- **THEN** the server releases the lease after its bound
- **AND** reopening reconciles operations and reports any unresolved draft rather than deleting it

### Requirement: Canvas shortcuts respect focus and platform conventions
The workspace SHALL expose a discoverable shortcut reference and SHALL scope canvas shortcuts so text editors, dialogs, menus, and assistive controls retain their native behavior.

#### Scenario: User presses delete while editing text
- **WHEN** keyboard focus is inside a node text editor
- **THEN** Delete or Backspace edits text and does not delete the node

#### Scenario: User opens the shortcut reference
- **WHEN** the user invokes the help shortcut or shortcut menu
- **THEN** the workspace lists current platform-specific P0 and P1 shortcuts
- **AND** disabled commands explain their preconditions
