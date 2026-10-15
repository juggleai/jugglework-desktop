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

### Host-level Marketplace registry is independent of workspaces

Organization Marketplace packages that require desktop materialization are installed by the execution host, not a selected workspace. The registry lives in the host runtime database and is addressed through root-level host APIs. Immutable package revisions are cached under the JuggleWork runtime storage directory; active resources are projected into the host's global OpenCode resource directories and a Server-owned runtime MCP overlay. Workspace plugin ledgers are never read as installation source, promoted, or deleted automatically. A dedicated host-authorized migration is allowed only after a read-only plan fingerprints every local copy and the member confirms the listed workspaces. The migration journals exact workspace bytes, MCP entries, ledger rows and host state, holds plugin/host/workspace locks, rolls back to the workspace-local state by default, and never changes Cloud-only ledger records.

The installation scope binds the execution environment, Cloud control-plane origin, user, and organization. One scope is active on a host at a time. Switching identity deactivates the prior projection before the new one becomes active. Pure Cloud packages remain Cloud capabilities and do not receive a local install record.

Host mutations require host/owner authority, an idempotency key, optimistic revision, a writable JuggleWork-managed runtime, and no conflicting resource ownership. Files are staged, ownership digests are recorded, and failure restores prior files, registry state, runtime overlay, and engine state. Modified owned resources are preserved and move the installation to repair-required. Existing workspace copies are reported as conflicts; they are not migrated.

The MVP supports skills, agents, commands, context, hooks, tools, and local-command MCP components with bounded payloads and executable-revision confirmation. Direct remote OpenCode and arbitrary custom component materialization remain unsupported. Remote JuggleWork Servers are supported through the same host-root API when owner/host authorization is available.

### Mutually exclusive origin, orthogonal installed state

Personal means custom additions, not all local installations. Public directory connections remain Public after installation and editing, while ready organization deliveries remain Organization. Installed aggregates sources and labels each shortcut. Connector creation persists schema-neutral JSONC provenance metadata with a consistency fingerprint; explicit Personal wins over directory identity. Legacy unmarked entries use exact name and endpoint/command matching, with inferred Public provenance recorded on app edits. Duplicate names cannot be silently overwritten. No actual user config is migrated until a user requests a mutation.

### Catalog provenance is separate from installation

All three categories share a header with search, refresh, contextual add actions, and Public / organization name / Personal source pills. Public uses bundled JuggleWork-owned plugin manifests, skills, and curated MCP directory entries, not an organization's assignments. Browser and Voice are public plugins; `skill-creator` is a preinstalled public skill; Notion and Linear are public connectors. Public entries remain discoverable and manageable in Public after installation. Personal shows custom environment-local additions, not duplicate Public or organization installations; a personal cloud organization still belongs to the organization tab. No third-party SkillHub search result is claimed as JuggleWork curated. Until an explicit public skills feed is available, only JuggleWork-bundled public skills appear there.

Organization settings changes invalidate cloud snapshots and pending requests. Inventory and detail state are keyed to cloud identity and environment so previous organization data cannot be reused after switching. Remote inventory reads target the selected host, while desktop-only upload actions remain unavailable on remote hosts.

### Dedicated Plugins combines application-level discovery with explicit installation

Catalog discovery remains available across workspaces. Public built-ins ship with JuggleWork and are therefore always installed; their card menu controls enablement instead of offering uninstall. Organization Marketplace packages use the selected workspace's existing transactional installation ledger, and the catalog states that scope explicitly. A Cloud-ready assignment is still uninstalled until that explicit record exists. Cards expose Add while absent and an Uninstall menu while installed. This does not promote a workspace copy into a host-global install; host-level materialization remains a follow-up.

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
- [Catalog still needs a runtime context for built-in health and Marketplace installation] → Use the active workspace runtime for diagnostics and existing transactional Marketplace mutations, and label non-built-in installs as current-workspace scoped.
- [Pure desktop Marketplace components cannot yet be globally installed] → Show their requirements without promoting a workspace install; host-level materialization is a follow-up.

## Migration Plan

1. Separate the visible surfaces without changing persisted data.
2. Add tests for global navigation, scoped workspace inventory and policy switches, and prevent workspace ledgers from feeding global catalog installation state.
3. Keep advanced workspace plugin management for legacy copies.
4. Follow up with an execution-host plugin registry and immutable cache before migrating any files.
