## Purpose

Defines reliable, workspace-bound Marketplace plugin installation and synchronization so visible status, local resources, runtime MCPs, and recoverability remain consistent.

## ADDED Requirements

### Requirement: Plugin mutations are bound to the initiating workspace
An install, sync, or removal operation SHALL retain the workspace identity and server target captured when the user starts the operation. Navigation or workspace switching MUST NOT redirect an in-flight mutation or its refresh result to another workspace.

#### Scenario: User switches workspace during installation
- **WHEN** a user starts installation in workspace A and navigates to workspace B before resolution completes
- **THEN** all writes and installation records remain scoped to workspace A, and workspace B state is not overwritten by the late response

### Requirement: Local plugin delivery is atomic
The system SHALL serialize install, update, and removal mutations per workspace. It SHALL either apply all local plugin component changes, the installation record, and live engine reconciliation, or restore the previous workspace state. A failed operation MUST remain retryable and MUST NOT leave unowned files or MCP configuration. If compensation cannot fully restore the previous state, the system MUST persist and return a repair-required result with the original cause and rollback failure details.

#### Scenario: Component write fails midway
- **WHEN** one component fails after earlier files or MCP changes were applied
- **THEN** earlier changes are rolled back, the previous installation remains intact, and the UI reports installation failure

#### Scenario: Concurrent mutations target one workspace
- **WHEN** install, update, or removal requests overlap for the same workspace
- **THEN** each mutation reads snapshots after the prior mutation completes and no operation clobbers another operation's ledger or runtime configuration

#### Scenario: Live engine synchronization fails
- **WHEN** persisted plugin resources change but the affected MCP state cannot be reconciled with the live engine
- **THEN** the operation does not report success and restores the prior persisted and engine state when compensation succeeds

#### Scenario: Removal rollback fails
- **WHEN** plugin removal fails and any file, runtime MCP, installation record, or engine compensation also fails
- **THEN** the plugin remains recorded as repair-required with the removal cause and each failed rollback stage

#### Scenario: Unrelated runtime MCP changes during rollback
- **WHEN** another runtime writer adds or changes an MCP outside the plugin's affected names before plugin compensation runs
- **THEN** rollback restores only the plugin-affected MCP names and preserves the unrelated runtime change

### Requirement: Synchronization reconciles the exact owned graph
Synchronizing a plugin SHALL create or update current owned resources and remove resources no longer present in the resolved plugin graph. Every normalized local file destination and runtime MCP name in one incoming graph MUST have exactly one owning component. The system MUST detect duplicate destinations before mutation and MUST NOT choose an owner by sequential overwrite. Plugin removal SHALL also disconnect removed MCPs from the live engine. Repeating the same resolved graph SHALL be idempotent.

#### Scenario: Skill and command are removed upstream
- **WHEN** a new plugin version removes a previously installed Skill and Command
- **THEN** synchronization removes their owned workspace files and subsequent removal leaves no orphaned resources

#### Scenario: Same version is synchronized repeatedly
- **WHEN** the same resolved plugin version is synchronized more than once
- **THEN** the repeated synchronization is a true no-op with no file, MCP, installation-record, engine synchronization, or reload effects

#### Scenario: Components normalize to the same file destination
- **WHEN** two incoming components normalize to the same workspace file path during install or update
- **THEN** synchronization returns a deterministic conflict without writing either candidate, and an update preserves the previously installed component and ledger

#### Scenario: Components normalize to the same MCP destination
- **WHEN** two incoming components normalize to the same runtime MCP name during install or update
- **THEN** synchronization returns a deterministic conflict without upserting either candidate or synchronizing the engine, and an update preserves the previously installed MCP and ledger

### Requirement: MCP ownership prevents destructive collisions
Plugin-managed MCP entries SHALL carry ownership metadata or use an isolated name. Installation MUST reject an unsafe collision with user-owned or differently owned MCP configuration, and removal MUST delete only an entry still owned by that plugin.

#### Scenario: Plugin collides with user MCP
- **WHEN** a plugin declares an MCP server name already owned by the user
- **THEN** installation fails with an actionable conflict and preserves the user's configuration

#### Scenario: User takes ownership after installation
- **WHEN** an installed MCP is changed so it is no longer owned by the plugin
- **THEN** removing the plugin reports an ownership conflict, preserves the MCP, and retains a repair-required installation record

#### Scenario: User modifies a plugin-owned file after installation
- **WHEN** an installed file still has valid plugin ownership metadata but its content no longer matches the ownership digest
- **THEN** removing the plugin reports an ownership conflict, preserves the file, and retains a repair-required installation record

### Requirement: Cloud and local component outcomes are fully accounted
Installation records SHALL account for every active plugin membership, including Cloud-hosted components that do not create local files. Each component SHALL have a stable outcome such as installed locally, available in Cloud, needs sign-in, needs administrator setup, unsupported, or failed.

#### Scenario: Plugin contains only Cloud MCPs
- **WHEN** a plugin contains only Cloud-hosted MCP components and all are available
- **THEN** installation reaches a stable installed state and does not permanently report an update

#### Scenario: One component cannot be delivered
- **WHEN** some components are delivered but another requires action or fails
- **THEN** the plugin reports a persistent partial state with the affected component and next action instead of a generic success

#### Scenario: Resolved Cloud component needs setup
- **WHEN** resolved plugin Cloud readiness says a component needs member sign-in or administrator setup
- **THEN** the component ledger preserves the corresponding outcome and the plugin is classified as partial rather than installed

### Requirement: Workspace capability gates plugin actions
The UI SHALL enable workspace installation only when the captured runtime supports writable cloud-plugin installation. Unsupported, read-only, or insufficiently authorized workspaces SHALL explain the limitation before the user starts the operation.

#### Scenario: Direct remote OpenCode has no plugin installer
- **WHEN** a user opens a plugin in a remote runtime without workspace plugin installation capability
- **THEN** the install action is disabled with an explanatory message and no failing request is sent

### Requirement: Successful mutation refreshes all affected capabilities
After a successful install, sync, or removal, the initiating workspace SHALL refresh installation records, Marketplace state, Skills, MCPs, Commands, Agents, and the current session capability inventory before presenting the operation as complete.

#### Scenario: Mixed plugin installation succeeds
- **WHEN** a plugin containing Skill, Command, Agent, local MCP, and Cloud MCP components installs successfully
- **THEN** all corresponding workspace surfaces reflect the new state without requiring navigation or manual refresh

### Requirement: Marketplace lifecycle state is canonical
Marketplace card and detail state SHALL be one of `not_installed`, `installing`, `current`, `update_available`, `partial`, `needs_signin`, `needs_admin`, `failed`, `repair_required`, or `removing`. The system SHALL derive that state deterministically from the live organization/plugin identity, active operation, resolved version, component ledger, and Cloud readiness rather than retaining a stale selected-card snapshot.

#### Scenario: A new plugin version arrives while detail is open
- **WHEN** live Marketplace data replaces the selected plugin with a newer resolved version
- **THEN** the open detail resolves the new object by organization and plugin identity and changes from `current` to `update_available`

#### Scenario: A structured mutation failure is returned
- **WHEN** install, sync, repair, or removal returns a structured failure outcome
- **THEN** the initiating workspace refreshes authoritative installation and Marketplace data and projects `partial`, `failed`, or `repair_required` from the refreshed result

### Requirement: Marketplace actions are deterministic
The primary action SHALL be derived from canonical state, delivery shape, component next action, and workspace capability. `not_installed` SHALL offer install, `update_available` sync, `needs_signin` sign-in, `needs_admin` administrator guidance, `partial` or `failed` retry, and `repair_required` repair. `installing` and `removing` SHALL disable competing mutations. `current` SHALL offer removal only when the plugin owns desktop resources. Unsupported actions MUST be absent or disabled with their reason.

#### Scenario: Repeated renders use the same inputs
- **WHEN** canonical state, delivery shape, component outcomes, and workspace capability are unchanged
- **THEN** the same primary action, disabled reason, and component actions are produced in a stable order

### Requirement: Detail refresh preserves only scoped last-known-good data
Plugin detail requests SHALL be cached by organization ID, plugin ID, and resolved version. A refresh failure SHALL preserve last-known-good detail only for that exact key and SHALL expose a structured failure containing the failed stage, stable error code, user-safe message, and retryability. Changing organization or resolved version MUST NOT display cached detail from the previous key.

#### Scenario: Refresh fails for the open plugin version
- **WHEN** detail refresh fails after data for the same organization, plugin, and version was loaded
- **THEN** the modal keeps that last-known-good detail, marks it as not refreshed, and offers retry from the structured failure

#### Scenario: Organization changes after a cached detail load
- **WHEN** the active organization changes while a plugin detail request or cached result belongs to the prior organization
- **THEN** the prior result is not rendered and the new organization receives an independent detail request

### Requirement: Repeated synchronization has no runtime effects
Before mutation, synchronization SHALL compare the resolved version, component ledger, owned resource digests, and runtime MCP plan. When all values match the installed graph, it SHALL return `current` without writing files, runtime MCP configuration, or installation records and without invoking engine synchronization or reload.

#### Scenario: Installed graph is already exact
- **WHEN** the user synchronizes a plugin whose resolved graph and owned resource digests exactly match the current installation
- **THEN** the operation reports `current` and produces zero persistence, engine, and reload effects
