## ADDED Requirements

### Requirement: 技能列表保留作用域标注
技能列表在所有读取路径上 SHALL 保留每条技能的 `scope`（`project` 或 `global`）。工作区技能来自工作区的技能目录，全局技能来自当前运行环境的全局技能目录。

#### Scenario: 桌面端通过服务端读取技能
- **WHEN** 桌面端经 JuggleWork Server 读取技能列表
- **THEN** 每条技能都带有正确的 `scope`，全局技能标为 `global`

#### Scenario: 同名技能同时存在于两个作用域
- **WHEN** 工作区与全局目录下存在同名技能
- **THEN** 工作区技能优先，列表中不出现重复条目

### Requirement: 全局技能页只展示全局技能
设置页的「技能」SHALL 只列出 `scope` 为 `global` 的技能，MUST NOT 列出工作区技能。列表 SHALL 以响应式两列展示；页面右上角 SHALL 提供添加入口，支持从本地目录上传和从 SkillHub 安装到全局技能目录。每条 SHALL 可查看详情，并 SHALL 提供删除入口。

#### Scenario: 查看全局技能
- **WHEN** 用户打开设置页的「技能」
- **THEN** 只看到全局技能，工作区技能不出现在列表中

#### Scenario: 删除全局技能
- **WHEN** 用户确认删除一个全局技能
- **THEN** 该技能从全局技能目录中移除，列表刷新后不再出现

#### Scenario: 从本地添加全局技能
- **WHEN** 用户通过右上角添加入口选择本地技能目录
- **THEN** 技能安装到全局 OpenCode 技能目录，并在所有工作区可用

#### Scenario: 从 SkillHub 添加全局技能
- **WHEN** 用户通过右上角添加入口在 SkillHub 选择技能并确认
- **THEN** 技能包安装到全局 OpenCode 技能目录，而不是当前工作区目录

#### Scenario: 切换工作区
- **WHEN** 用户切换工作区后再次打开「技能」
- **THEN** 列表内容不变

### Requirement: 全局技能可按作用域删除
技能删除接口 SHALL 接受作用域参数。作用域为 `global` 时 MUST 在全局技能目录集合内解析目标；为 `project` 或未指定时 MUST 维持只删除工作区技能的行为。目标不存在时 SHALL 返回未找到而非静默成功。

#### Scenario: 删除不存在的全局技能
- **WHEN** 请求删除一个全局目录中不存在的技能
- **THEN** 接口返回未找到，且不删除任何文件

#### Scenario: 以工作区作用域删除全局技能
- **WHEN** 请求以 `project` 作用域删除一个只存在于全局目录的技能
- **THEN** 接口返回未找到，全局目录不受影响

### Requirement: 全局连接器页只展示全局 MCP
设置页全局分组的「连接器」SHALL 只列出来源为全局 OpenCode 配置的 MCP，MUST NOT 列出工作区配置、工作区运行时层或组织连接。页面右上角 SHALL 提供添加按钮，每条 SHALL 展示其连接状态。

页面 SHALL 与工作区连接器入口一样展示「已连接 / 未连接」两组。未连接组来自内置 MCP 快速连接目录，仅以全局配置判断是否已连接；工作区同名 MCP 不得隐藏全局未连接项。自动维护或默认隐藏的内部 transport（包括 `jugglework-cloud`）MUST NOT 出现在未连接组。

全局连接器 SHALL 从当前选中运行环境的全局配置读取，并与该运行环境报告的 `config.global` MCP 投影合并；MUST NOT 因固定读取桌面 host 而漏掉远程运行环境的全局 MCP。同名条目以可写全局配置文件为准。

#### Scenario: 查看全局连接器
- **WHEN** 用户打开设置页的「连接器」
- **THEN** 只看到全局配置声明的 MCP，工作区 MCP 不出现在列表中

#### Scenario: 当前运行环境报告全局 MCP
- **WHEN** 配置文件读取与引擎快照短暂不一致，但引擎报告一个 `config.global` MCP
- **THEN** 全局连接器列表仍显示该 MCP，不显示 `config.project` 或 `config.remote` 条目

#### Scenario: 全局尚未配置目录 MCP
- **WHEN** 快速连接目录包含一个未写入全局配置的 MCP
- **THEN** 它出现在「未连接」组，用户可通过「连接」将完整配置写入全局 OpenCode 配置

#### Scenario: 工作区存在同名 MCP
- **WHEN** 一个 MCP 只在当前工作区配置、全局配置不存在同名项
- **THEN** 它仍出现在全局页「未连接」组，不会被工作区配置错误去重

#### Scenario: 连接全局 OAuth MCP
- **WHEN** 用户从未连接组连接声明 OAuth 的远程 MCP
- **THEN** 应用先写入全局配置，再通过现有 OAuth 流程完成授权，不得写入工作区配置

#### Scenario: 切换工作区
- **WHEN** 用户切换工作区后再次打开「连接器」
- **THEN** 列表内容不变

### Requirement: 全局连接器的写入目标是全局配置
新增、启用/停用与移除全局连接器 SHALL 直接读写当前运行环境的全局 OpenCode 配置文件，MUST NOT 写入任何工作区配置或工作区运行时层。写入 SHALL 保留文件中已有的其他配置与 JSONC 注释，并在成功后标记引擎需要重载。

#### Scenario: 新增全局连接器
- **WHEN** 用户在「连接器」中新增一个 MCP
- **THEN** 该条目写入全局配置文件的 `mcp` 段，并在所有工作区中可见

#### Scenario: 移除全局连接器
- **WHEN** 用户移除一个全局连接器
- **THEN** 该条目从全局配置文件中删除，列表刷新后不再出现

#### Scenario: 停用全局连接器
- **WHEN** 用户停用一个全局连接器
- **THEN** 全局配置中该条目的启用状态变为关闭，对所有工作区一致生效

#### Scenario: 写入失败
- **WHEN** 全局配置文件写入失败
- **THEN** 界面提示失败，且不改变列表状态
