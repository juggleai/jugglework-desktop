## ADDED Requirements

### Requirement: Toon workspace spatial surfaces use JuggleWork semantic tokens
The multi-canvas, document, asset, and project-assistant surfaces SHALL adapt JuggleWork semantic color, typography, spacing, radius, elevation, motion, focus, and disabled-state tokens into graph and editor dependencies and SHALL NOT import a Toonflow or Element Plus visual shell.

#### Scenario: Theme changes while a project is open
- **WHEN** the user switches between supported JuggleWork themes
- **THEN** canvas chrome, nodes, edges, guides, minimap, document editor, file tree, asset views, menus, and assistant dock update from semantic tokens
- **AND** no hard-coded light surface or provider branding remains

### Requirement: Floating and docked controls preserve hierarchy and content access
Floating project controls, canvas controls, menus, panels, and the assistant dock SHALL have defined elevation, collision spacing, resize limits, and responsive transformations so primary canvas or document content and critical actions remain reachable.

#### Scenario: Assistant dock is resized
- **WHEN** the user resizes the dock on a sufficiently wide window
- **THEN** it stays within declared minimum and maximum sizes and the primary workspace retains a usable minimum area
- **AND** the chosen size is restored for that workspace context

#### Scenario: Floating controls would overlap
- **WHEN** viewport size or localization causes controls to collide
- **THEN** lower-priority controls collapse into accessible overflow or a responsive surface
- **AND** save, mode, stop, and panel controls remain reachable

### Requirement: Graph, document, and assistant interactions meet shared accessibility behavior
The Toon workspace SHALL provide visible focus, semantic labels, keyboard traversal, reduced-motion handling, contrast-compliant states, focus restoration for overlays, and announcements for saves, conflicts, tool progress, questions, and generation state.

#### Scenario: Reduced motion is enabled
- **WHEN** the operating system or application requests reduced motion
- **THEN** canvas transitions, panel movement, streaming indicators, and progress animation avoid nonessential motion
- **AND** state remains understandable through text or static visuals

#### Scenario: Keyboard user answers an assistant question
- **WHEN** a structured question opens from the dock or narrow-layout sheet
- **THEN** focus moves into the interaction, all choices and submission are keyboard-operable, and completion restores focus predictably

### Requirement: Interaction state is visually truthful
Controls SHALL visually distinguish idle, hover, focused, selected, dirty, saving, saved, conflicted, disabled, running, stopping, failed, stale, awaiting review, and adopted states where applicable, and disabled controls SHALL expose their reason.

#### Scenario: Canvas save conflicts
- **WHEN** autosave stops because the server revision changed
- **THEN** the save indicator uses conflict semantics rather than saved or generic failure styling
- **AND** the resolution action is perceivable without relying on color alone
