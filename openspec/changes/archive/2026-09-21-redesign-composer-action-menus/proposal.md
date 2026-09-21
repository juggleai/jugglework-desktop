## Why

The composer add menu is anchored to the small plus button, so it is much narrower than the task input and opens an additional side panel for commands, skills, plugins, and MCP servers. The existing slash suggestions also mix command and skill results into a short ungrouped list, which makes available actions difficult to scan and hides local skills.

## What Changes

- Make the add menu match the composer width and open immediately above it.
- Present Add, Plugins, and MCP as flat groups with names and concise descriptions; remove the side submenu interaction.
- Present slash suggestions as flat Commands and Skills groups in a composer-width panel.
- Include workspace/global and connected skills in slash discovery, preserve fuzzy filtering, and retain keyboard navigation.
- Keep unavailable MCP actions visible but disabled with their current status.

## Capabilities

### New Capabilities

- `composer-action-menus`: Discovery and selection behavior for composer add actions, plugins, MCP servers, slash commands, and skills.

### Modified Capabilities

None.

## Impact

- Updates the session composer surface and its localized labels.
- Reuses the existing command, skill, plugin, extension, and MCP inventories; no new backend API or persisted state is introduced.
