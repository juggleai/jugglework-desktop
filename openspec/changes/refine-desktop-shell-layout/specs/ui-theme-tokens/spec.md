## MODIFIED Requirements

### Requirement: 顶栏统一高度与背景
除会话 Shell 的紧凑顶部 chrome 外，所有页面级顶栏 SHALL 统一为 `--app-topbar-height`（亮暗同值 50px）。会话 Shell SHALL 使用 44px 的紧凑顶部内嵌距离，窗口顶部 chrome SHALL 使用与左侧导航一致的 `--app-list-bg`，其内嵌会话与面板顶栏 SHALL 继续使用 `--app-page-bg`；其他页面级顶栏继续使用 `--app-page-bg`。

#### Scenario: 会话 Shell 顶部与左侧 chrome 对齐
- **WHEN** 用户在桌面端打开工作区会话页
- **THEN** 窗口顶部留白与左侧导航/列表使用同一 `--app-list-bg`
- **AND** 圆角会话工作区距离窗口上边缘为 44px
- **AND** 内嵌白色会话工作区中的会话顶栏与右侧文件/扩展/设置面板头渲染高度均为 50px、背景为 `--app-page-bg`

#### Scenario: 其他页面顶栏对齐
- **WHEN** 用户依次打开设置页、自动化任务页、消息页会话、通讯录页
- **THEN** 各页面级顶栏渲染高度均为 50px，背景为 `--app-page-bg`

#### Scenario: 通讯录顶栏 flex-basis 同步
- **WHEN** 通讯录页内容顶栏位于 column flex 容器内
- **THEN** 其 `height`、`min-height`、`flex-basis` 三者 **应** 同时引用 `--app-topbar-height`，实际渲染高度不被任一残留旧值顶回

## ADDED Requirements

### Requirement: 会话工作区圆角内嵌
桌面工作区会话 SHALL 在应用导航 Rail 与窗口 chrome 内渲染一个连续的 `--app-page-bg` 工作区。该工作区 SHALL 同时涵盖左侧工作区/会话列表和右侧会话内容，在整体外缘使用一致圆角并裁剪内部内容，同时保留可见的外围 `--app-list-bg`。

#### Scenario: 亮色会话布局
- **WHEN** 用户在亮色主题打开工作区会话
- **THEN** 应用导航 Rail 与顶部外围使用列表背景色，左侧会话列表和右侧会话内容共同位于白色圆角工作区内
- **AND** 列表与会话内容之间仅保留内部分隔线，不出现外围背景色间隙

#### Scenario: 暗色会话布局
- **WHEN** 用户在暗色主题打开工作区会话
- **THEN** 外围和中央分别使用主题映射后的列表与页面 token，圆角与裁剪关系保持不变

#### Scenario: 会话列表折叠
- **WHEN** 用户折叠左侧会话列表
- **THEN** 右侧会话内容恢复四角圆角和左侧内嵌间距

### Requirement: 紧凑应用导航 Rail
桌面端应用导航 Rail SHALL 使用 48px 宽度，并使用与该宽度协调的 36px 操作按钮和 20px 图标，使圆角会话工作区更接近窗口左边缘。

#### Scenario: 桌面会话布局比例
- **WHEN** 用户在桌面端打开工作区会话
- **THEN** 应用导航 Rail 宽度为 48px
- **AND** 圆角会话列表距离 Rail 右缘保留 4px 外围间距

### Requirement: 会话 Shell 控件与分割线留白
macOS 会话 Shell 的侧栏开关 SHALL 位于顶部 chrome 的固定位置，展开与折叠侧栏时不得跳到会话列表内部。圆角工作区内部的列表水平分割线和列表/会话垂直分割线 SHALL 与外缘保留 12px 间距。

#### Scenario: 展开或折叠会话列表
- **WHEN** 用户点击侧栏开关展开或折叠会话列表
- **THEN** 开关保持相同的窗口坐标和顶部 chrome 对齐

#### Scenario: 工作区内部分割线
- **WHEN** 圆角会话工作区包含会话列表和会话内容
- **THEN** 列表头水平分割线左右各留出 12px
- **AND** 列表与会话内容之间的垂直分割线上下各留出 12px

### Requirement: 会话工具操作位于顶栏
Browser、Files、Extensions 以及启用时的 Voice 操作 SHALL 横向排列在会话顶栏右侧，并 SHALL NOT 占用永久右侧竖向区域。

#### Scenario: 常规本地会话
- **WHEN** 用户打开一个本地工作区会话且 Voice 未启用
- **THEN** Browser、Files、Extensions 三个图标横向出现在会话顶栏右侧
- **AND** 页面右边缘不存在独立的 44px 工具栏

#### Scenario: 工具状态与行为保持
- **WHEN** 用户点击任一顶栏工具图标
- **THEN** 原有侧面板开关、`aria-label` 和 `aria-pressed` 状态保持一致

#### Scenario: 聚焦会话决定工具归属
- **WHEN** 工作台存在聚焦的分屏会话，或路由会话正在恢复但工作台仍保留有效会话
- **THEN** Find、Browser、Files、Extensions 使用同一个有效会话作为操作目标
- **AND** 顶栏按钮在 macOS 拖拽区域中仍可接收点击

#### Scenario: Files 展开模式
- **WHEN** Files 面板进入展开模式
- **THEN** 覆盖层延伸到窗口右边缘，不为已删除的右侧工具栏保留空白
