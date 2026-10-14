## MODIFIED Requirements

### Requirement: 会话右侧扩展面板按类别分组展示

The session top-right Settings panel SHALL present Instructions, Connectors, Skills, and Plugins as separate groups. It SHALL distinguish globally available items from workspace-local items without treating the application catalog as the workspace's installed inventory.

The panel SHALL retain its narrow width and fixed padding, show counts without skill avatar previews, and omit unimplemented Experts/Automation placeholders. Dedicated catalog navigation SHALL remain separate from the session panel.

#### Scenario: Open workspace settings

- **WHEN** a user opens Settings from a session
- **THEN** the panel shows Instructions, Connectors, Skills, and Plugins
- **AND** the plugin group shows the global and workspace inventory rather than a duplicate installation catalog

### Requirement: 技能管理弹窗区分项目级与全局技能

The workspace Skills group SHALL provide import and supported discovery actions whose target is the captured workspace.

It SHALL list and count both workspace and global skills with scope labels. Workspace skills can be uninstalled; global skill files SHALL NOT be removed from this dialog. Workspace disable is available only with a trusted managed runtime. Disabled skills remain visible and can be re-enabled.

#### Scenario: Upload a skill

- **WHEN** a user uploads a skill from the workspace Skills dialog
- **THEN** the skill is installed into that workspace
- **AND** global skills remain visible and cannot be uninstalled there, but can be disabled for the current workspace when enforcement is ready

## ADDED Requirements

### Requirement: Workspace plugin visibility and supported disable

The workspace Plugins group SHALL show global and workspace plugin sources with scope labels. It SHALL offer a workspace disable switch only when directory-isolated enforcement is verified. The current shared runtime SHALL report enforcement unavailable, expose no controllable specs, and reject policy writes without mutating configuration or reloading.

#### Scenario: Shared runtime cannot isolate plugin enablement

- **WHEN** plugin policy is queried or updated on the current shared runtime
- **THEN** the inventory remains visible without a misleading switch and updates return an unavailable error
- **AND** persisted disabled specs are not applied to the shared runtime config

### Requirement: Add workspace connectors from workspace settings

The workspace Connectors group SHALL provide a custom MCP add action that writes to or registers with the captured workspace scope rather than the execution-host global configuration.

#### Scenario: Add custom MCP

- **WHEN** a user adds a custom MCP from the workspace Connectors dialog
- **THEN** the connector is added for the captured workspace
- **AND** a host-global connector shown in that dialog remains read-only there
