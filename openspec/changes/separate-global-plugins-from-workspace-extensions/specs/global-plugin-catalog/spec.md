## ADDED Requirements

### Requirement: Stable source switching and source-independent adding

Skills and Connectors SHALL expose Add in all source tabs. Add SHALL create an environment-local Personal item, not publish to Public or the organization. Successful additions SHALL navigate to Personal; cancellations, failed operations, and completions after a context change SHALL NOT redirect the user. Unsupported environments SHALL keep the action visible but disabled.

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

Plugins, Skills, and Connectors SHALL each offer Public, the selected organization's actual name, and Personal source tabs. Public SHALL be curated by JuggleWork and visible independently of sign-in. Personal SHALL show local environment additions/installations and SHALL NOT mean a personal organization. Unsupported installers SHALL NOT claim successful local installation.

#### Scenario: Public plugins and connectors

- **WHEN** the user selects Public
- **THEN** Browser and Voice are in Plugins, and Notion and Linear are in Connectors
- **AND** installed public entries remain discoverable with installation state distinct from provenance

#### Scenario: Switch organizations including personal organization

- **WHEN** the active organization changes
- **THEN** the middle tab displays its name and only its authorized inventory
- **AND** old requests and details cannot repopulate the previous organization's data
- **AND** Personal continues to refer to the execution environment, not that organization's kind

#### Scenario: No public skills feed

- **WHEN** no JuggleWork-curated skills catalog is configured
- **THEN** Public Skills reports an empty catalog rather than mislabeling SkillHub or organization skills

### Requirement: Global catalog navigation remains available

The dedicated Plugins page SHALL retain Plugins, Skills, Connectors, and Installed navigation for globally discoverable items and the global installation actions already supported by each source. Unsupported desktop-only Marketplace packages SHALL NOT be presented as globally installed or installable without a host-level installer.

#### Scenario: Navigate to global skills or connectors

- **WHEN** a member selects Skills or Connectors in the Plugins page sidebar
- **THEN** the corresponding global installation and management surface opens
- **AND** Installed is not populated from a selected workspace's local plugin copies

### Requirement: Dedicated Plugins uses application-level discovery

The dedicated Plugins surface SHALL display built-in, account, organization, and supported personal plugin sources without treating the selected workspace's local imported-plugin ledger as application-level installation state.

#### Scenario: Switching workspaces

- **WHEN** a member switches from one local workspace to another while remaining in the same account and organization
- **THEN** the application-level plugin sources remain available
- **AND** a local plugin copy installed only in the first workspace is not labeled as globally installed in the second workspace

### Requirement: Cloud readiness remains separate from local materialization

The catalog SHALL derive Cloud plugin readiness from Connect authorization and service readiness, independently from legacy workspace files.

#### Scenario: Cloud plugin ready without local copy

- **WHEN** an organization plugin runs through JuggleWork Connect and its required connection is ready
- **THEN** the catalog reports that the plugin runs in Cloud
- **AND** it does not require a workspace installation merely because the current workspace has no local ledger

### Requirement: Legacy workspace copies remain compatible

The change SHALL NOT delete, promote, or silently enable an existing workspace plugin copy in another workspace.

#### Scenario: Existing workspace installation

- **WHEN** a workspace already contains plugin-owned files or runtime MCP entries
- **THEN** those resources and their ownership ledger remain unchanged
- **AND** they continue to be manageable through compatibility or advanced workspace management paths
