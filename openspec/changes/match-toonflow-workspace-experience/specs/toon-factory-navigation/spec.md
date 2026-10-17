## ADDED Requirements

### Requirement: Project routes retain Canvas and Document workspace modes
The Toon Factory project route SHALL expose Canvas and Document modes, retain each mode after first use, and restore the last valid project, canvas or document, assistant conversation, and panel layout without continuing hidden expensive work.

#### Scenario: User switches project modes
- **WHEN** the user switches from a selected canvas to an open document and back
- **THEN** both modes restore their selection, viewport or editor view, drafts, and layout
- **AND** the hidden mode suspends unnecessary rendering, search, and polling

#### Scenario: Deep link targets a missing entity
- **WHEN** a project route addresses a removed canvas or document
- **THEN** the workspace opens the project with a recoverable not-found state
- **AND** does not silently select an unrelated entity as though it were the target

### Requirement: Workspace controls follow Toonflow interaction placement with JuggleWork behavior
An open project SHALL provide floating project and mode controls, canvas-local controls, project asset access, and a resizable or collapsible assistant dock while preserving JuggleWork routing, focus, theme, and responsive behavior.

#### Scenario: Desktop project workspace opens
- **WHEN** sufficient width is available
- **THEN** mode and project controls float above the primary workspace and the assistant can dock without replacing project content

#### Scenario: Narrow project workspace opens
- **WHEN** width cannot support the primary workspace and dock together
- **THEN** secondary surfaces use accessible sheets or dialogs
- **AND** the active canvas or document remains reachable and is not permanently obscured

### Requirement: Home project actions have explicit import and open semantics
The Toon Factory home SHALL distinguish creating from inspiration, opening a known portable project, and importing supported external content, and SHALL present unsupported Toonflow compatibility as unavailable rather than executing an implicit conversion.

#### Scenario: User opens an existing JuggleWork Toon project
- **WHEN** the user selects a supported project directory inside the authorized workspace
- **THEN** the application validates its schema and opens it without copying or reinitializing content

#### Scenario: User selects an unsupported Toonflow project
- **WHEN** no explicit compatible importer is available for the selected source
- **THEN** the UI explains that direct import is unsupported
- **AND** does not start Toonflow's server or load its runtime code
