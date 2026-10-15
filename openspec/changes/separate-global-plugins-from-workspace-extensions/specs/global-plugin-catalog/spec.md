## ADDED Requirements

### Requirement: Plugin components are not duplicated as top-level catalog items

The standalone Skills catalog and its Installed shortcuts SHALL exclude skills owned by a plugin package. Ownership SHALL be determined by server-provided exact-path provenance from the active host registry or workspace plugin ledger, never by display name. Plugin-owned skills remain available to the runtime and visible inside their plugin detail. Standalone same-name skills with different paths remain visible.

#### Scenario: TestPlugin includes okf-coding

- **WHEN** `okf-coding` is owned by TestPlugin through Connect, a workspace copy, or a host-global installation
- **THEN** it is not repeated in the standalone Skills source lists or Skills Installed shortcuts
- **AND** it remains visible in TestPlugin details and available to sessions according to plugin readiness

#### Scenario: Independent same-name skill

- **WHEN** another standalone skill has the same display name but a different unowned path
- **THEN** that standalone skill remains listed

#### Scenario: Organization switches

- **WHEN** the active host registry identity scope changes
- **THEN** skill ownership is annotated from one atomic active-registry snapshot so stale organization ownership cannot leak into the next catalog

### Requirement: Host-level Marketplace installation is workspace-independent

The execution host SHALL expose a versioned registry and root-level API for organization Marketplace packages requiring desktop materialization. Records SHALL be scoped by execution environment, Cloud origin, member, and organization and SHALL NOT use a workspace ID or workspace plugin ledger. Installation SHALL project owned resources only into the host global OpenCode environment and a Server-owned MCP overlay.

#### Scenario: Install from the standalone catalog

- **WHEN** an authorized owner installs a desktop or mixed organization package on a supported managed host
- **THEN** a host installation record and owned global resources are committed transactionally
- **AND** the package appears Installed across workspaces on that host for the active identity
- **AND** no workspace `.opencode` file or workspace plugin ledger is created

#### Scenario: Cloud-only package

- **WHEN** all package components run through JuggleWork Connect
- **THEN** no host installation record or local resource copy is created
- **AND** Cloud readiness remains separate from Installed

#### Scenario: Existing workspace copy

- **WHEN** the same package has an existing workspace installation
- **THEN** normal host installation reports a conflict without promoting, deleting, or changing that copy
- **AND** the user may explicitly request a migration plan listing every exact workspace copy and blocker
- **AND** only after confirming that exact fingerprint may a host-authorized transaction remove the listed copies and install globally
- **AND** cancellation performs no mutation, while failure restores the exact workspace bytes, MCP entries, ledger rows, host state, and engine projection

#### Scenario: Conflict or failed mutation

- **WHEN** a target is user-owned, owned by another package, modified after installation, or a mutation/reload fails
- **THEN** unrelated resources remain unchanged and the prior projection is restored
- **AND** incomplete compensation is recorded as repair-required rather than current

#### Scenario: Switch organization or sign out

- **WHEN** the active member/organization scope changes or signs out
- **THEN** the old organization projection is deactivated before the next scope is activated
- **AND** stale requests cannot reactivate old resources

#### Scenario: Unsupported execution host

- **WHEN** the target is direct remote OpenCode, read-only, or not JuggleWork-managed
- **THEN** packages remain discoverable but host mutation is unavailable and no workspace fallback is attempted

### Requirement: Catalog state is conveyed without redundant tags

Plugin cards SHALL omit Installed, Enabled, and the redundant JuggleWork Extension type tags. Installation SHALL be conveyed by Add versus overflow actions. Enabled plugins SHALL show a status mark at the lower-right of their icon; disabled plugins SHALL show no enabled mark. Preview and Beta release-stage tags remain. The Installed sidebar SHALL show each plugin, skill, or connector's configured/catalog icon, using the existing category icon as fallback.

#### Scenario: Installed enabled plugin

- **WHEN** an installed enabled plugin is listed
- **THEN** its card has an overflow action and an icon status mark, but no Installed or Enabled text tag

#### Scenario: Installed disabled plugin

- **WHEN** an installed disabled plugin is listed
- **THEN** its card has an overflow action and no icon status mark or Enabled tag

#### Scenario: Installed sidebar icon fallback

- **WHEN** an Installed shortcut has an icon URL, icon slug, service URL, or Skill identity
- **THEN** that visual is rendered before its name
- **AND** missing visuals use the existing plugin, skill, or connector category icon

### Requirement: Catalog details are pages, not overlays

The standalone Plugins area SHALL open Plugins, Skills, and Connectors details inline while keeping the category/Installed sidebar visible. The page SHALL include a category/name breadcrumb, icon, title, description and applicable controls. Category breadcrumb returns to the source list preserving its search. Catalog cards and Installed shortcuts SHALL resolve the same item by stable identity, not display-name search. Async inventory loading SHALL not discard a pending selection. Organization and runtime context changes SHALL isolate selection.

#### Scenario: Installed item opens its detail

- **WHEN** the user clicks an Installed shortcut
- **THEN** the correct category and source open the same inline detail as the corresponding card
- **AND** clicking the category sidebar exits detail

#### Scenario: Connector detail does not authorize on click

- **WHEN** a user opens a public or organization connector card
- **THEN** it displays details without connecting or authorizing
- **AND** installation/authorization requires its explicit action

#### Scenario: Workspace dialogs remain compatible

- **WHEN** a detail is opened in session workspace settings rather than the standalone catalog
- **THEN** its existing modal behavior is retained
- **AND** creation and removal confirmations remain dialogs in both surfaces

#### Scenario: Inline skill retains the former detail content

- **WHEN** a global skill detail opens inline
- **THEN** Overview renders the complete selected `SKILL.md` body with frontmatter hidden and Files renders the exact skill's bounded file tree
- **AND** selection is resolved by the owning runtime's exact inventory path, so same-name workspace or global skills cannot replace it
- **AND** remote details never fall back to a local desktop copy

#### Scenario: Organization skill uses the same detail presentation

- **WHEN** a Connect-delivered organization skill opens from its source or Installed
- **THEN** it uses the same Overview/Files detail structure as Personal skills
- **AND** its supplied source is rendered as sanitized Markdown with frontmatter hidden, not exposed as raw source text
- **AND** it never invokes the Personal exact-path loader or desktop filesystem readers
- **AND** when no local file inventory exists, the Files tab is hidden rather than showing an empty file surface

### Requirement: Installation and connection readiness are distinct

Installed connector cards and details SHALL show installation separately from connected, failed, authentication required, disabled, registration required, or unverified runtime state. Missing status SHALL NOT imply readiness. Token/static-header configurations SHALL NOT offer a browser OAuth action. Hints SHALL use safe localized categories rather than raw provider errors or credential values.

#### Scenario: Installed GitHub is not connected

- **WHEN** GitHub configuration exists but its runtime connection failed or remains unverified
- **THEN** its catalog card shows Installed together with the real connection category; failed connections are labeled Not connected without troubleshooting text in cards, details, or composer rows
- **AND** a failure alone does not assert that a token is missing or invalid

#### Scenario: Composer shows unavailable installed connectors

- **WHEN** a configured or organization-assigned connector is unavailable or disabled in the workspace
- **THEN** the composer plus menu keeps its row visible with a safe explanation but blocks mouse, Enter, and Tab selection
- **AND** uninstalled directory entries and internal transports remain excluded
- **AND** Manage connectors opens the current workspace connector settings

#### Scenario: Status refresh fails

- **WHEN** refreshing connector inventory fails
- **THEN** known installed rows remain visible but stale readiness is cleared, preventing selection until readiness is confirmed

### Requirement: Stable source switching and source-independent adding

Skills and Connectors SHALL expose custom Add in all source tabs. Custom Add SHALL create an environment-local Personal item, not publish to Public or the organization. Successful custom additions SHALL navigate to Personal; Public directory installation SHALL stay Public. Cancellations, failed operations, and completions after a context change SHALL NOT redirect the user. Unsupported environments SHALL keep the action visible but disabled.

#### Scenario: Add from Organization

- **WHEN** a user successfully uploads/installs a skill or creates a connector while browsing Organization
- **THEN** the Personal inventory refreshes and Personal becomes selected
- **AND** the organization inventory remains unchanged

#### Scenario: Switch source without layout jumps

- **WHEN** the user switches Public, Organization, and Personal within the same environment/organization
- **THEN** the page and search input remain mounted, the search query is retained, and toolbar actions stay in place
- **AND** description height, content minimum height, and scrollbar space remain stable
- **AND** changing the actual organization or execution environment still invalidates context-bound details and pending navigation

### Requirement: Shared source classification

Plugins, Skills, and Connectors SHALL each offer mutually exclusive Public, the selected organization's actual name, and Personal source tabs. Public SHALL be curated by JuggleWork and visible independently of sign-in. Personal SHALL show custom environment-local additions only, not installations originating from Public or the organization, and SHALL NOT mean a personal organization. Unsupported installers SHALL NOT claim successful local installation.

#### Scenario: Bundled skill creator is Public

- **WHEN** the desktop app installs its bundled `skill-creator` into the execution host's global skill directory
- **THEN** Skills → Public lists `skill-creator` with its bundled instructions and installed state
- **AND** the same installation does not appear in Skills → Personal
- **AND** the Installed shortcut identifies its source as Public

#### Scenario: Connecting a public directory item

- **WHEN** the user connects Notion from Public
- **THEN** the installed connection remains manageable in Public and does not appear in Personal
- **AND** its stored provenance survives refreshes and app edits
- **AND** legacy unmarked configurations match Public only by exact server name and endpoint/command identity, never name alone

#### Scenario: Custom name collision

- **WHEN** a custom connection uses a public directory server name
- **THEN** explicit Personal provenance takes precedence, and directory installation cannot overwrite the existing connection

#### Scenario: Installed aggregates sources

- **WHEN** the user views Installed
- **THEN** installed Public and Personal items and ready organization items appear with source labels
- **AND** shortcuts navigate to the item's original source, without merging same-name organization and personal items

#### Scenario: Installed follows the selected category

- **WHEN** the user selects Plugins, Skills, or Connectors in the category sidebar
- **THEN** Installed shows only items of that category, across Public, Organization, and Personal sources
- **AND** an empty selected category shows the installed empty state even if other categories have installed items

#### Scenario: Public plugins and connectors

- **WHEN** the user selects Public
- **THEN** Browser and Voice are in Plugins, and Notion and Linear are in Connectors
- **AND** GitHub is a Public connector using its official remote MCP endpoint and an execution-environment token reference, without claiming unconfigured OAuth login
- **AND** installed public entries remain discoverable with installation state distinct from provenance

#### Scenario: GitHub public connector

- **WHEN** the user opens Public Connectors
- **THEN** GitHub is visible with the official remote MCP endpoint `https://api.githubcopilot.com/mcp/`
- **AND** its description states that authentication requires `GITHUB_TOKEN` in the MCP execution environment, without claiming automatic browser OAuth
- **AND** generated configuration references the environment variable instead of embedding a credential, and installing from the directory retains Public provenance

#### Scenario: Switch organizations including personal organization

- **WHEN** the active organization changes
- **THEN** the middle tab displays its name and only its authorized inventory
- **AND** old requests and details cannot repopulate the previous organization's data
- **AND** Personal continues to refer to the execution environment, not that organization's kind

#### Scenario: No public skills feed

- **WHEN** no JuggleWork-curated skills catalog is configured
- **THEN** Public Skills reports an empty catalog rather than mislabeling SkillHub or organization skills

#### Scenario: Skill belongs to a plugin package

- **WHEN** an organization or host-projected Skill is identified by plugin membership or an exact host-owned resource target
- **THEN** it is omitted from the standalone Skills list and Skills section of Installed
- **AND** it remains visible inside the parent plugin detail and available to the session runtime
- **AND** independent Personal Skills remain listed even when their names resemble plugin components

### Requirement: Global catalog navigation remains available

The dedicated Plugins page SHALL retain Plugins, Skills, Connectors, and Installed navigation for globally discoverable items and the global installation actions already supported by each source. Unsupported desktop-only Marketplace packages SHALL NOT be presented as globally installed or installable without a host-level installer.

#### Scenario: Navigate to global skills or connectors

- **WHEN** a member selects Skills or Connectors in the Plugins page sidebar
- **THEN** the corresponding global installation and management surface opens
- **AND** Installed is not populated from a selected workspace's local plugin copies

#### Scenario: Legacy workspace plugin removed upstream

- **WHEN** the selected workspace retains an imported plugin copy that the active organization no longer provides
- **THEN** the standalone Plugins organization tab does not show an upstream-removal warning or workspace-removal action
- **AND** compatibility cleanup remains available only in the workspace Extensions management surface

### Requirement: Dedicated Plugins does not expose workspace installs as global

The dedicated Plugins surface SHALL display built-in, account, organization, and supported personal plugin sources. Public built-ins SHALL be treated as preinstalled. Until a host-level Marketplace registry and materializer exist, organization Marketplace packages SHALL be discovery/readiness-only here. Workspace ledgers SHALL NOT populate Installed or lifecycle state, and workspace Add, Update, Repair, Resync, or Uninstall actions SHALL NOT be exposed as global actions.

#### Scenario: Switching workspaces

- **WHEN** a member switches from one local workspace to another while remaining in the same account and organization
- **THEN** the application-level plugin sources remain available
- **AND** a local plugin copy installed only in the first workspace is not labeled as installed in the second workspace

#### Scenario: Organization package without a global installer

- **WHEN** an organization Marketplace package is viewed in the standalone Plugins page
- **THEN** it does not display workspace-backed Add or Uninstall actions
- **AND** its detail does not show current-workspace delivery summaries, workspace versions, or workspace component badges
- **AND** its catalog card omits redundant delivery/install summary text because Add/overflow actions and icon state already convey installation
- **AND** workspace installation remains available only in an explicitly workspace-scoped compatibility surface

### Requirement: Cloud readiness remains separate from local materialization

The catalog SHALL derive Cloud plugin readiness from Connect authorization and service readiness independently from host installation. A ready assignment SHALL NOT be claimed as globally installed without an explicit host-level install record.

#### Scenario: Cloud plugin ready without local copy

- **WHEN** an organization plugin runs through JuggleWork Connect and its required connection is ready
- **THEN** the catalog reports that the plugin runs in Cloud
- **AND** the card does not expose a workspace Add action or claim global installation

### Requirement: Legacy workspace copies remain compatible

The change SHALL NOT delete, promote, or silently enable an existing workspace plugin copy in another workspace.

#### Scenario: Existing workspace installation

- **WHEN** a workspace already contains plugin-owned files or runtime MCP entries
- **THEN** those resources and their ownership ledger remain unchanged
- **AND** they continue to be manageable through compatibility or advanced workspace management paths
