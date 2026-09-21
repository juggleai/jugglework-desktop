## Context

The composer already loads commands, skills, imported plugins, built-in extensions, and workspace MCP status. Its add menu previously exposed category rows that opened a second panel to the right of a fixed-width menu. Slash suggestions were rendered from a mixed, capped list.

## Decisions

### One anchored surface per invocation

Both the plus and slash surfaces are absolutely positioned against the composer panel rather than the plus button. Their horizontal bounds therefore follow the composer, while a bounded vertical area scrolls when content exceeds the available viewport.

### Flat groups over nested navigation

The plus surface renders Add, Plugins, and MCP in one scroll container. Built-in extensions and imported plugin files become direct actions. MCP rows directly insert their capability tag when connected; unavailable rows remain visible and disabled so the user can understand why an action cannot be selected.

The slash surface renders Commands first and Skills second. Filtering is applied within each group and the flattened visible order remains the keyboard-navigation order.

### Existing inventories remain authoritative

No parallel catalog is introduced. Plus-menu plugins use enabled composer extensions and imported plugin files, MCP uses the current workspace inventory, and slash skills combine engine-provided skill commands with the full local/global/Connect skill list.

## Accessibility

Each surface uses menu/menuitem semantics, maintains ArrowUp/ArrowDown/Enter/Tab/Escape behavior, keeps focus in the editor during pointer selection, and exposes disabled reasons through titles and status labels.
