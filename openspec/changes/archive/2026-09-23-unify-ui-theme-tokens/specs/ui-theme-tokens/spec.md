# ui-theme-tokens Specification

## ADDED Requirements

### Requirement: 会话列表运行图标暗色反白

任务运行中的会话行尾图标 SHALL 在暗色主题显示为白色，在亮色主题保持既有强调色。该配色变化 SHALL NOT 改变图标动画、尺寸、状态语义或悬浮时与快捷操作互换的行为。

#### Scenario: 暗色会话任务运行中

- **WHEN** 会话任务正在运行且界面使用暗色主题（`.dark` 或 `[data-theme="dark"]`）
- **THEN** 会话行尾的圆形运行图标显示为白色

#### Scenario: 亮色会话任务运行中

- **WHEN** 会话任务正在运行且界面使用亮色主题
- **THEN** 会话行尾的圆形运行图标继续使用既有强调色

### Requirement: 运行中停止按钮黑白反色

任务运行中的 Stop 按钮 SHALL 在亮色主题显示黑色圆形背景和白色实心方块，在暗色主题显示白色圆形背景和黑色实心方块。配色变化 SHALL NOT 改变按钮尺寸、队列角标或停止行为。

#### Scenario: 亮色运行中按钮

- **WHEN** 任务运行中且界面使用亮色主题
- **THEN** Stop 按钮黑底白方块，悬停时仍保持黑底白方块的配色关系

#### Scenario: 暗色运行中按钮

- **WHEN** 任务运行中且界面使用暗色主题（`.dark` 或 `[data-theme="dark"]`）
- **THEN** Stop 按钮白底黑方块，悬停时仍保持白底黑方块的配色关系

### Requirement: 页面与列表背景语义 token

系统 SHALL 在宿主 `:root` 提供 `--app-page-bg` 与 `--app-list-bg` 唯一来源 token，亮色值 **应** 分别为 `#ffffff` 与 `#fcfcfc`。

#### Scenario: 亮色主题下页面背景统一

- **WHEN** 应用处于亮色主题
- **THEN** 工作区会话页、通讯录/消息页、自动化任务页的内容区背景解析为 `#ffffff`
- **AND** 工作区列表、左侧导航栏等侧栏背景解析为 `#fcfcfc`

#### Scenario: 暗色主题自动映射

- **WHEN** 应用切换至暗色主题（`[data-theme="dark"]` 或 `.dark`）
- **THEN** `--app-page-bg` 映射为 `--slate-1`、`--app-list-bg` 映射为 `--slate-2`，消息页 shadow DOM 内引用同一 token 的样式同步变化

### Requirement: 顶栏统一高度与背景

所有页面级顶栏 SHALL 统一为 `--app-topbar-height`（亮暗同值 50px）、背景 `--app-page-bg`。

#### Scenario: 跨页面顶栏对齐

- **WHEN** 用户依次打开工作区会话页、设置页、自动化任务页、消息页会话、通讯录页
- **THEN** 各顶栏（含会话右侧文件/扩展/设置面板头）渲染高度均为 50px，背景为纯白（暗色为主题背景色）

#### Scenario: 通讯录顶栏 flex-basis 同步

- **WHEN** 通讯录页内容顶栏位于 column flex 容器内
- **THEN** 其 `height`、`min-height`、`flex-basis` 三者 **应** 同时引用 `--app-topbar-height`，实际渲染高度不被任一残留旧值顶回

### Requirement: 发送消息气泡统一背景

已发送消息气泡背景 SHALL 统一引用 `--app-msg-sent-bg`（亮色 `#f3f3f4`，暗色 `--slate-3`），消息页气泡 **应** 无描边。

#### Scenario: 工作区会话与消息页气泡同色

- **WHEN** 用户分别在工作区会话和消息页发送文本消息
- **THEN** 两处气泡背景均解析为 `#f3f3f4`，消息页气泡无 1px 描边

### Requirement: 消息页输入区卡片形态

消息页输入区 SHALL 渲染为无边框白色卡片：白底 `#ffffff`（暗色为主题面板色）、阴影、16px 圆角、`margin: 0 16px 16px`；布局为编辑器在上、操作行沉底；操作行图标统一 16px 线性风格；**不应** 提供发送按钮（回车发送）。

#### Scenario: 输入卡视觉与间距

- **WHEN** 消息页会话打开
- **THEN** 输入卡与页面右侧、底部各保持 16px 间距，卡片无边框仅有阴影，编辑区在上、表情与回形针图标行沉底且两图标视觉尺寸一致

#### Scenario: 顶栏仅显示会话名称

- **WHEN** 消息页会话顶栏渲染
- **THEN** 仅显示会话名称，不显示头像与 `@id` 副行
