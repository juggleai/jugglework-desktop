## ADDED Requirements

### Requirement: MCP 组件投递方式判定
桌面端 SHALL 按每个 MCP 组件独立判定承载位置：配置对象 payload（`mcp` 或 `mcpServers` 两种键名）中带 HTTPS `url` 的 server 判为 `cloud`，仅带启动命令 `command` 的 server 判为 `desktop`。服务端下发 `cloudReadiness.components` 时 MUST 以其 `delivery` 为准；该字段缺失时 MUST 回退到已解析的配置对象 payload 自行推断，不得因缺失而把组件标记为故障。

#### Scenario: 远程 MCP 判为云端承载
- **WHEN** 配置对象 payload 为 `{"mcp":{"github":{"type":"remote","url":"https://api.githubcopilot.com/mcp/"}}}`
- **THEN** 该组件承载位置为 `cloud`，就绪状态由组织连接与成员授权决定

#### Scenario: stdio MCP 判为桌面端承载
- **WHEN** 配置对象 payload 为 `{"mcp":{"vision":{"type":"local","command":["npx","-y","jugglework-vision-mcp"]}}}`
- **THEN** 该组件承载位置为 `desktop`，就绪状态由本工作区是否已安装决定

#### Scenario: 服务端未下发组件明细
- **WHEN** 插件的 `cloudReadiness` 为空或不含 `components`
- **THEN** 桌面端按配置对象 payload 推断承载位置，展示结果与下发明细时一致

### Requirement: 插件投递状态按最弱环节聚合
插件卡片与列表 SHALL 用其 MCP 组件的聚合结果替代固定的「已启用 · 在云端运行」文案：全部组件为 `cloud` 且均就绪时呈现「在云端运行」；全部组件为 `desktop` 时呈现「需在桌面端安装」；两类混合时呈现「部分需在桌面端安装」。徽标语义 MUST 取最弱环节——只要存在未就绪组件，插件 MUST NOT 呈现为完全可用。卡片 SHALL 给出组成明细，标明组件总数及云端/需本地各自数量。

#### Scenario: 纯云端插件
- **WHEN** 插件的全部 MCP 组件均为 `cloud` 且成员已授权
- **THEN** 卡片呈现「在云端运行」且为已就绪配色

#### Scenario: 混合插件未装到本工作区
- **WHEN** 插件含 1 个 `cloud` 组件与 1 个 `desktop` 组件，且本工作区未安装该插件
- **THEN** 卡片呈现「部分需在桌面端安装」、非就绪配色，并显示 `2 MCP · 1 云端 · 1 需本地`

#### Scenario: 纯本地插件已安装
- **WHEN** 插件的全部 MCP 组件均为 `desktop` 且已安装到本工作区
- **THEN** 卡片不再声称在云端运行，而是呈现已安装于桌面端的就绪态

### Requirement: 插件详情按组件展开
插件详情弹窗 SHALL 逐个列出 MCP 组件的名称、承载位置与就绪状态，并把操作入口绑定到组件行：`cloud` 且待授权的行提供授权入口，`desktop` 且未安装的行提供安装到工作区入口。详情 MUST NOT 用单一整插件按钮代表多个状态不同的组件。

#### Scenario: 混合插件详情
- **WHEN** 用户打开含 GitHub（`cloud`，成员未授权）与 vision（`desktop`，未安装）的插件详情
- **THEN** 两行分别显示「云端 · 需要登录」与「桌面端 · 未安装」，各自带对应操作入口

#### Scenario: 组件已全部就绪
- **WHEN** 插件的每个组件都已就绪
- **THEN** 详情不展示任何补齐入口，仅呈现组件清单与就绪状态

### Requirement: 会话 MCP 列表沿用组件粒度状态
会话输入栏的 MCP 列表 SHALL 按 server 粒度展示云端能力，并沿用组件投递方式对应的状态口径：`desktop` 组件未安装时标为「未安装」、已安装时并入本地条目并沿用其真实运行状态；`cloud` 组件按云端就绪度标注。同一个 MCP MUST NOT 同时以能力目录条目与本地配置条目重复出现。

#### Scenario: 桌面端组件未安装
- **WHEN** 插件的 `desktop` 组件未写入本工作区配置
- **THEN** 列表以「未安装」标注该条目，且不呈现为运行故障

#### Scenario: 桌面端组件已安装
- **WHEN** 插件的 `desktop` 组件已写入本工作区配置
- **THEN** 列表只保留本地条目，并带上市场与插件归属

### Requirement: 安装按投递方式分流落盘
安装**由 JuggleWork Connect 网关承载的组织云端插件**时，桌面端 SHALL 只把 `desktop` 组件写入工作区 opencode 配置；`cloud` 组件 MUST NOT 落地为本地 MCP 配置，继续经云端网关调用。安装记录 SHALL 只为实际落盘的组件生成文件条目，卸载与更新链路 MUST 容忍某个 MCP 组件没有对应本地文件。

分流 MUST 以插件来源为条件：**GitHub 导入的 Claude plugin bundle 没有网关兜底**，其远程 MCP SHALL 继续写入工作区配置，否则该能力将完全不可用。两类来源共用同一安装链路，因此调用方 MUST 显式声明远程组件是否由网关承载。

#### Scenario: 安装混合的组织云端插件
- **WHEN** 用户把含 1 个 `cloud` 与 1 个 `desktop` 组件的组织云端插件安装到工作区
- **THEN** 只有 `desktop` 组件出现在工作区 opencode 配置与安装记录中

#### Scenario: 安装含远程 MCP 的 GitHub bundle
- **WHEN** 用户从 GitHub 导入含远程 MCP 的 Claude plugin bundle
- **THEN** 该远程 MCP 仍写入工作区 opencode 配置，安装行为与本变更前一致

#### Scenario: 全部为云端组件时不误报安装失败
- **WHEN** 组织云端插件的 MCP 组件全部为 `cloud`，因而没有任何内容需要落盘
- **THEN** 安装正常完成且不产生「配置缺失」告警

#### Scenario: 卸载混合插件
- **WHEN** 用户卸载该插件
- **THEN** 落盘的 `desktop` 组件被移除，`cloud` 组件的缺失文件不导致卸载失败或残留记录
