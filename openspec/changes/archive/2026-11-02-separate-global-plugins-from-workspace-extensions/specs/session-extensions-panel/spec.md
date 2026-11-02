## MODIFIED Requirements

### Requirement: 会话右侧扩展面板按类别分组展示

The session top-right Settings panel SHALL present Instructions, Connectors, Skills, and Plugins as separate groups. It SHALL distinguish globally available items from workspace-local items without treating the application catalog as the workspace's installed inventory.

The panel SHALL retain its narrow width and fixed padding, show counts without skill avatar previews, and omit unimplemented Experts/Automation placeholders. Dedicated catalog navigation SHALL remain separate from the session panel.

#### Scenario: Open workspace settings

- **WHEN** a user opens Settings from a session
- **THEN** the panel shows Instructions, Connectors, Skills, and Plugins
- **AND** the plugin group shows the global and workspace inventory rather than a duplicate installation catalog

#### Scenario: 打开会话右侧扩展面板
- **WHEN** 用户在会话页点击右侧配置 icon 打开「扩展」
- **THEN** 面板以分组卡片展示 `指令 / 连接器 / 技能 / 插件`，而非扁平的 All/MCPs/Skills 列表或应用安装目录

#### Scenario: 独立设置页不受影响
- **WHEN** 用户从独立设置页进入 extensions tab（非 `embedded`）
- **THEN** 仍渲染既有 `mcp-view`，样式与行为不变

#### Scenario: 面板默认宽度与留白
- **WHEN** 面板在大屏会话页打开
- **THEN** 以窄默认宽度呈现，内容左右留白与面板标题栏对齐，不随视口断点放大

#### Scenario: 预留分组占位
- **WHEN** 面板渲染分组列表
- **THEN** 不再展示尚未实现的 `专家` 或 `自动化` 占位卡片

### Requirement: 技能管理弹窗区分项目级与全局技能

The workspace Skills group SHALL provide import and supported discovery actions whose target is the captured workspace.

It SHALL list and count both workspace and global skills with scope labels. Workspace skills can be uninstalled; global skill files SHALL NOT be removed from this dialog. Workspace disable is available only with a trusted managed runtime. Disabled skills remain visible and can be re-enabled.

#### Scenario: Upload a skill

- **WHEN** a user uploads a skill from the workspace Skills dialog
- **THEN** the skill is installed into that workspace
- **AND** global skills remain visible and cannot be uninstalled there, but can be disabled for the current workspace when enforcement is ready

#### Scenario: 展示已装技能
- **WHEN** 用户打开技能管理弹窗
- **THEN** 展示项目级与全局技能并分别标注作用域，计数与列表保持一致

#### Scenario: 卸载项目级技能
- **WHEN** 用户卸载一个项目级技能
- **THEN** 系统调用既有卸载链路移除该技能并刷新列表

#### Scenario: 全局技能只读
- **WHEN** 弹窗中出现全局技能
- **THEN** 该技能标注「全局」且不提供删除全局文件的入口
- **AND** 仅在运行时能够可信执行工作区隔离时提供当前工作区停用入口

#### Scenario: 打开新增入口
- **WHEN** 用户点击技能新增入口
- **THEN** 展示上传技能与受支持的技能发现流程，并把新增目标固定为当前工作区

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
