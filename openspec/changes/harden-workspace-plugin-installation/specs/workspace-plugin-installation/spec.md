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
- **THEN** files, MCP entries, installation records, and reload effects do not duplicate

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
