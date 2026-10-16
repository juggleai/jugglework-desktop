## ADDED Requirements

### Requirement: 漫剧工厂使用共享桌面应用外壳

漫剧工厂 SHALL 使用共享应用导航 Rail、圆角 inset 内容面、二级侧栏宽度与 resize 行为、页面顶栏高度及语义主题 token，不得引入独立的 Toonflow 或 Element Plus 视觉外壳。

#### Scenario: 在亮色主题打开漫剧工厂

- **WHEN** 用户在亮色主题打开漫剧工厂
- **THEN** 页面使用共享 `--app-page-bg`、`--app-list-bg`、`--app-topbar-height`、DLS 边框和文本 token
- **AND** 内容面与设置、插件、自动化及代码审查使用一致的 inset 圆角和窗口边距

#### Scenario: 在暗色主题打开漫剧工厂

- **WHEN** 用户切换到暗色主题
- **THEN** 项目侧栏、画布、检查器、节点、菜单和状态提示通过现有语义 token 自动映射
- **AND** 不保留硬编码的亮色白底或 Toonflow 品牌控件样式

### Requirement: 漫剧工厂二级侧栏遵循共享响应式布局

漫剧工厂 SHALL 复用可持久化的二级侧栏宽度、收起、展开和 resize 约束，并在窄窗口为主工作区保留可用最小宽度。

#### Scenario: 用户调整项目侧栏宽度

- **WHEN** 用户拖动漫剧工厂项目侧栏的 resize handle
- **THEN** 侧栏宽度在共享最小值和最大值之间变化并持久化
- **AND** 切换离开再返回时恢复该宽度

#### Scenario: 窗口宽度不足

- **WHEN** 窗口变窄且持久化侧栏宽度会挤占主工作区
- **THEN** 有效侧栏宽度被限制以保留主内容区域
