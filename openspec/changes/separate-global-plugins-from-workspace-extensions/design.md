## Context

JuggleWork combines built-in extensions, organization plugins delivered through Connect, legacy workspace plugin materializations, local OpenCode plugins, skills, and MCP connectors. The dedicated Plugins page and the workspace settings panel currently share one workspace-bound extension store, so a local workspace ledger can influence what appears installed in the application-level catalog.

## Goals / Non-Goals

**Goals:**

- Give the Plugins navigation a stable application-level meaning.
- Keep global Skills, Connectors, and installed navigation in the Plugins page, and workspace mutation entry points for skills, connectors, and supported plugin policy in top-right Settings.
- Prevent a legacy local copy in one workspace from masquerading as a global plugin install.
- Preserve Cloud/Connect authorization and credential boundaries.
- Make the first migration additive and non-destructive.

**Non-Goals:**

- Moving existing plugin-owned files out of every `.opencode` directory in this change.
- Copying Cloud MCP configuration or credentials to a device-level plugin store.
- Removing legacy workspace plugin install, repair, or uninstall APIs.
- Implementing team templates.

## Decisions

### Catalog provenance is separate from installation

All three categories share a header with search, refresh, contextual add actions, and Public / organization name / Personal source pills. Public uses bundled JuggleWork-owned plugin manifests and curated MCP directory entries, not an organization's assignments. Browser and Voice are public plugins; Notion and Linear are public connectors. Public entries remain discoverable after installation. Personal shows environment-local installations and user additions; a personal cloud organization still belongs to the organization tab. No third-party SkillHub search result is claimed as JuggleWork curated. Until an explicit public skills feed is available its public tab has an honest empty state.

Organization settings changes invalidate cloud snapshots and pending requests. Inventory and detail state are keyed to cloud identity and environment so previous organization data cannot be reused after switching. Remote inventory reads target the selected host, while desktop-only upload actions remain unavailable on remote hosts.

### Dedicated Plugins is an application-level catalog

Catalog mode continues to use the selected execution context for health and built-in capability checks, but it does not consume the selected workspace's imported Cloud plugin ledger as global installation state. Public, account, and organization discovery remains visible. Pure Cloud plugins derive readiness from Connect rather than a workspace copy.

### Workspace Settings shows scoped skills, connectors, and plugins

The top-right session Settings panel contains Instructions, Connectors, Skills, and Plugins. Connector creation and skill upload/install remain in those modals and target the captured workspace. Workspace settings lists both global and workspace plugin sources; it does not turn workspace copies into host installs. Only runtime-managed plugin specs whose workspace disable can be enforced expose a switch. Marketplace browsing and global installation remain in the dedicated Plugins page.

### Global navigation is retained

The dedicated Plugins page retains its Plugins, Skills, Connectors, and Installed sidebar. Skills and connectors have global add/install surfaces. Its installed inventory is not sourced from the selected workspace's imported plugin ledger.

### Legacy workspace plugin copies remain local

No automatic promotion is performed. Existing ledgers and files continue to be managed by the legacy workspace installation APIs. Removing their card from workspace Settings does not delete or disable them.

### Scope is described by concrete boundaries

UI copy distinguishes This workspace from This execution environment/account/organization. Existing translation keys may remain for compatibility, but new catalog and workspace descriptions avoid implying that one workspace ledger is global.

## Risks / Trade-offs

- [Shared runtime plugin list cannot isolate workspace disables] → Keep plugin policy unavailable and reject writes; do not apply stored disables to the process-global runtime configuration until task 4.2 establishes genuine isolation.

- [Not all plugin sources can be disabled per workspace] → Keep them visible and identify unsupported items without a nonfunctional switch; retain compatibility management in advanced Extensions settings.
- [Catalog still needs a runtime context for built-in health] → Continue using the active workspace runtime for diagnostics only and document that this is health context, not installation scope.
- [Pure desktop Marketplace components cannot yet be globally installed] → Show their requirements without promoting a workspace install; host-level materialization is a follow-up.

## Migration Plan

1. Separate the visible surfaces without changing persisted data.
2. Add tests for global navigation, scoped workspace inventory and policy switches, and prevent workspace ledgers from feeding global catalog installation state.
3. Keep advanced workspace plugin management for legacy copies.
4. Follow up with an execution-host plugin registry and immutable cache before migrating any files.
