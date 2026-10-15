## Why

The dedicated Plugins surface currently reuses a workspace-bound settings runtime, while the session settings panel also exposes Marketplace plugins beside workspace instructions, skills, and connectors. This makes a workspace installation look like a global plugin installation and makes users unsure whether switching workspaces changes their plugin inventory.

## What Changes

- Apply mutually exclusive Public / selected organization name / Personal source tabs consistently to Plugins, Skills, and Connectors. Public is JuggleWork-curated and visible without organization membership; Personal is custom environment-local additions, never a personal organization or a duplicate of installed Public items.
- Reset organization inventories and detail dialogs when the selected organization changes, including switches to a personal organization.

- Treat the dedicated Plugins surface as the application-level catalog for built-in, account, and organization plugins.
- Stop presenting the current workspace's imported plugin ledger as the installation state of the global Plugins surface.
- Keep the dedicated Plugins page's left navigation for globally discoverable/installable Plugins, Skills, Connectors, and installed items.
- Keep workspace-scoped instructions, skills, connectors, and a plugin inventory in the session's top-right Settings panel. Show global and workspace sources together and offer workspace disable only where runtime enforcement exists.
- Do not equate a workspace plugin copy with an application-level installation or claim unsupported Marketplace packages are workspace-switchable.
- Label execution-host, workspace, account, and organization scope explicitly instead of using an ambiguous Global label where practical.
- Preserve legacy workspace plugin installations and their ledgers without broadening their availability to other workspaces.

## Capabilities

### New Capabilities

- `global-plugin-catalog`: Defines an application-level plugin catalog whose discovery and account/organization state are not projected from the selected workspace's local installation ledger.

### Modified Capabilities

- `session-extensions-panel`: Presents workspace instructions alongside scoped connectors, skills, and plugins, with workspace add/import and supported disable actions.

## Impact

- Desktop Plugins navigation and the embedded SettingsRoute catalog mode.
- Session top-right settings panel and its extension modals.
- Marketplace presentation logic and scope labels.
- Existing workspace plugin installation APIs remain compatible but are no longer presented as global installation state.
