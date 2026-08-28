## MODIFIED Requirements

### Requirement: 设置分组反映配置的实际作用域
设置页 SHALL 只承载不随工作区切换而变化的配置。设置导航 MUST NOT 包含工作区分组，也 MUST NOT 包含任何按 workspaceId 读写的页面。工作区切换器 MUST NOT 出现在设置页。分组内没有可见页面时 SHALL 不渲染该分组。

#### Scenario: 打开设置页
- **WHEN** 用户打开设置页
- **THEN** 侧栏只出现「全局」与「云端」两个分组，且不显示工作区切换器

#### Scenario: 切换工作区后返回设置页
- **WHEN** 用户切换工作区后再次打开设置页
- **THEN** 所有设置项的取值保持不变

### Requirement: 通用页归入全局分组首位
「通用」页 SHALL 位于「全局」分组，并 MUST 是该分组的第一项。「技能」与「连接器」SHALL 紧随其后。

#### Scenario: 打开设置页
- **WHEN** 用户打开设置页
- **THEN** 全局分组依次以「通用」「技能」「连接器」开头

## ADDED Requirements

### Requirement: 工作区扩展不进入设置导航
工作区级技能、MCP、组织连接策略与组织市场包 MUST NOT 出现在个人设置导航中，SHALL 继续由会话右侧扩展面板承载。「扩展」与 `connect` 的路由 MUST 保留，供该面板与兼容深链渲染使用。

会话右侧连接器 SHALL 使用一套「已连接 / 未连接」MCP 列表，MUST NOT 创建独立的「组织连接」页签。已授权且可由工作区策略控制的 Cloud MCP SHALL 在已连接行上显示滑动开关。

#### Scenario: 在设置页查找工作区扩展
- **WHEN** 用户在设置导航中查找工作区技能或工作区 MCP
- **THEN** 设置导航中不存在该入口

#### Scenario: 打开会话右侧扩展面板
- **WHEN** 用户在会话页打开右侧扩展面板
- **THEN** 面板正常展示当前工作区的连接器、技能与插件
