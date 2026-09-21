# composer-action-menus Specification

## Purpose
Define how the task composer exposes add actions, plugins, MCP servers, slash commands, and skills through compact, discoverable, keyboard-accessible menus.
## Requirements
### Requirement: Composer-width add menu

The task composer SHALL open its plus menu above the composer and SHALL align the menu's left and right edges with the composer panel. The menu MUST constrain its height to the available viewport and scroll vertically without horizontal scrolling.

#### Scenario: User opens the add menu

- **WHEN** the user selects the plus control
- **THEN** one menu opens immediately above the composer at the same width as the composer
- **AND** the task input remains visible below it

### Requirement: Flat add-menu groups

The add menu SHALL render Add, Plugins, and MCP as groups in one surface. Action rows SHALL include an icon, name, and concise description where available. Selecting a plugin or MCP action MUST NOT open a secondary menu.

#### Scenario: User selects a plugin

- **WHEN** an enabled composer extension or imported plugin action is available
- **THEN** it appears directly in the Plugins group
- **AND** selecting it applies that action and closes the menu

#### Scenario: MCP is unavailable

- **WHEN** a workspace MCP server is not connected or is disabled for the workspace
- **THEN** it remains visible in the MCP group with its status
- **AND** it cannot be selected

### Requirement: Grouped slash menu

Typing a slash as the current composer command token SHALL open a composer-width menu above the input. The menu SHALL group matching Commands and Skills without nested navigation and SHALL show descriptions. Skill rows SHALL identify their relevant scope when known.

#### Scenario: User types a slash

- **WHEN** the composer contains a slash command query
- **THEN** matching command rows appear in the Commands group
- **AND** matching local, global, or connected skill rows appear in the Skills group

#### Scenario: User filters and selects with the keyboard

- **WHEN** the user types more query characters and uses ArrowUp or ArrowDown
- **THEN** results are fuzzy-filtered within their groups
- **AND** keyboard selection follows the visible flattened order across group boundaries
- **AND** Enter or Tab applies the highlighted action while Escape closes the menu

#### Scenario: Built-in commands use localized presentation

- **WHEN** the slash menu shows new, compact, init, or review
- **THEN** each row uses a localized display label, localized description, and a distinct semantic icon
- **AND** selecting the row still invokes the original `/new`, `/compact`, `/init`, or `/review` command
