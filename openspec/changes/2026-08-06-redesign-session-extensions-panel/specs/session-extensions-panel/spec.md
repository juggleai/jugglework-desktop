# session-extensions-panel 规格增量

## ADDED Requirements

### Requirement: 会话右侧扩展面板按类别分组展示
系统 SHALL 在会话页右侧「扩展」rail 面板（`SettingsSurface` 的 `embedded` 变体）以分组卡片形式展示项目级扩展配置，首批分组为 `指令`、`连接器`、`技能`，并为 `专家`、`自动化` 预留占位卡片。

分组面板 MUST 仅作用于 `embedded` rail 变体；独立设置页的 extensions tab MUST 维持既有 `mcp-view` 渲染不变。

每个分组卡片 MUST 提供右上角 `+` 入口打开对应新增流程；`技能` 卡片 MUST 展示已装技能的图标行与数量。

面板宽度 MUST 使用独立于浏览器面板记忆宽度的窄默认值；面板内容 MUST 横向撑满并使用固定内边距，不得沿用按视口断点放大的设置页内边距。

#### Scenario: 打开会话右侧扩展面板
- **WHEN** 用户在会话页点击右侧配置 icon 打开「扩展」
- **THEN** 面板以分组卡片展示 `指令 / 连接器 / 技能`（含 `专家 / 自动化` 占位），而非扁平的 All/MCPs/Skills 列表

#### Scenario: 独立设置页不受影响
- **WHEN** 用户从独立设置页进入 extensions tab（非 `embedded`）
- **THEN** 仍渲染既有 `mcp-view`，样式与行为不变

#### Scenario: 面板默认宽度与留白
- **WHEN** 面板在大屏会话页打开
- **THEN** 以窄默认宽度呈现，内容左右留白与面板标题栏对齐，不随视口断点放大

#### Scenario: 预留分组占位
- **WHEN** 面板渲染 `专家` 或 `自动化` 分组
- **THEN** 展示占位卡片，其 `+` 入口不触发未实现功能（置灰或提示即将支持）

### Requirement: 连接器(MCP) 选择弹窗按连接状态分组
系统 SHALL 在 `连接器` 分组 `+` 打开的弹窗中，汇总组织下发连接器、快速连接目录与已装 MCP 三类来源并按身份去重，按「已连接 / 未连接」两组展示。

未连接项的连接动作 MUST 复用既有链路（组织连接器走成员授权、目录项走快速连接、已装但断开走重新授权），不新造连接逻辑。

#### Scenario: 分组展示
- **WHEN** 用户打开连接器选择弹窗
- **THEN** 状态为已连接的 MCP 归入「已连接」组，其余归入「未连接」组

#### Scenario: 连接未连接项
- **WHEN** 用户点击「未连接」组中的某个连接器
- **THEN** 系统按其来源触发对应的既有连接/授权流程，成功后该项移入「已连接」组

#### Scenario: 多来源去重
- **WHEN** 同一 MCP 同时出现在多个来源
- **THEN** 弹窗按身份去重，仅展示一条

### Requirement: 连接器弹窗提供添加入口
系统 SHALL 在连接器弹窗右上角提供「+ 添加」下拉，形式与技能管理弹窗的添加入口一致，包含 `自定义 MCP` 与 `从 MCP 中心添加` 两项。

`自定义 MCP` MUST 打开与扩展页「添加自定义应用」完全一致的弹窗（复用 `AddMcpModal`），提交后走既有 `connectMcp` 链路。`从 MCP 中心添加` 在功能实现前 MUST 置灰不可点。

#### Scenario: 添加自定义 MCP
- **WHEN** 用户点击「+ 添加」→「自定义 MCP」，填写服务器名称与地址（或本地命令）并提交
- **THEN** 系统按既有 `connectMcp` 链路添加该 MCP，弹窗关闭后回到连接器列表

#### Scenario: MCP 中心占位
- **WHEN** 用户展开「+ 添加」下拉
- **THEN** `从 MCP 中心添加` 置灰不可点

### Requirement: 组织下发连接器可由成员断开并重新连接
系统 SHALL 允许成员在连接器弹窗中断开自己在组织下发 MCP 连接（服务端下发，如 GitHub）上的授权，断开只清除调用成员自身的授权，连接本身由组织保留。

断开入口 MUST 仅对成员凭证（`credentialMode==="per_member"`）且当前成员已授权的连接展示；组织共享凭证（`shared`）由管理员维护，MUST 不展示断开入口。

断开通道 MUST 按连接类型分流：原生 Provider（Google Workspace / Microsoft 365）走 `POST /v1/oauth-providers/:id/disconnect`，其余组织下发连接走 `POST /v1/mcp-connections/:id/disconnect`。

断开失败 MUST 在弹窗中展示错误文案，不得静默无响应。断开按钮 MUST 使用警示（warning）配色以区别于普通操作。

#### Scenario: 断开非原生 Provider 的下发连接器
- **WHEN** 成员对一个已授权的成员凭证连接（如 GitHub）点击「断开」
- **THEN** 系统调用 `POST /v1/mcp-connections/:id/disconnect` 清除该成员授权，刷新后该项移入「未连接」组

#### Scenario: 断开后重新连接
- **WHEN** 成员对已断开的连接器点击「连接」
- **THEN** 系统走既有成员授权流程（浏览器 OAuth + 轮询），成功后该项回到「已连接」组

#### Scenario: 共享凭证不可断开
- **WHEN** 弹窗中出现 `credentialMode==="shared"` 的已连接项
- **THEN** 该项不展示断开入口

#### Scenario: 断开失败可见
- **WHEN** 断开请求返回错误
- **THEN** 弹窗顶部展示错误文案，该项保持「已连接」状态

### Requirement: 技能管理弹窗区分项目级与全局技能
系统 SHALL 在 `技能` 分组 `+` 打开的弹窗中展示当前项目已添加的技能网格，并提供「上传技能」与「从技能中心添加」两个新增入口。

技能来源 MUST 可区分：项目级技能（`scope==="project"`）可卸载管理；全局技能（`scope==="global"`）只读并标注「全局」，MUST 禁用其卸载入口。已添加技能计数 MUST 只统计项目级技能。

#### Scenario: 展示已装技能
- **WHEN** 用户打开技能管理弹窗
- **THEN** 展示项目已添加技能网格与「当前项目已添加 N 个技能」，N 只计项目级技能

#### Scenario: 卸载项目级技能
- **WHEN** 用户卸载一个 `scope==="project"` 的技能
- **THEN** 系统调用既有卸载链路移除该技能并刷新列表

#### Scenario: 全局技能只读
- **WHEN** 弹窗中出现 `scope==="global"` 的技能
- **THEN** 该技能标注「全局」且卸载入口被禁用

#### Scenario: 打开新增入口
- **WHEN** 用户点击「+ 添加」
- **THEN** 展示下拉：`上传技能`（本地上传至项目）与 `从技能中心添加`（打开技能中心）

### Requirement: 技能中心从 SkillHub 检索并安装技能
系统 SHALL 提供技能中心弹窗，通过 `https://skillhub.juggle.im` 的匿名 API 检索技能，支持关键字搜索、分页、多选与确认安装。所有 SkillHub 网络调用 MUST 经主进程发起。

技能中心 MUST 提供 `推荐 / SkillHub / 已安装` 三个 tab：`SkillHub` 拉全量（`sort=newest`），`推荐` 用热度排序（缺省回落 `newest`），`已安装` 与本地技能按 `slug`/`name` 交叉比对后展示。当 `GET /api/web/labels` 返回非空时 MUST 渲染分类 tab，返回空时 MUST 仅展示「全部」。列表项无图标时 MUST 使用首字母+哈希色占位头像。

#### Scenario: 搜索与分页
- **WHEN** 用户在技能中心输入关键字或翻页
- **THEN** 系统经主进程调用 `GET /api/web/skills?q=&sort=&page=&size=` 并展示对应结果与总数

#### Scenario: 多选并确认安装
- **WHEN** 用户勾选若干技能并点击「确认」
- **THEN** 系统对每个新选中技能依次安装，展示逐个进度与失败项，成功后刷新项目技能列表

#### Scenario: 已安装技能标记
- **WHEN** 某 SkillHub 技能已存在于本地技能列表
- **THEN** 该项标为「已安装」，在选择态下置为已选且禁用取消

#### Scenario: 分类数据缺失
- **WHEN** `GET /api/web/labels` 返回空数组
- **THEN** 技能中心仅展示「全部」，不渲染分类 tab 行

### Requirement: 技能安装从 ZIP 解压进项目技能目录
系统 SHALL 通过主进程从 `GET /api/web/skills/{namespace}/{slug}/download` 获取 ZIP 技能包，解压写入项目 `.opencode/skills/<slug>/`。

解压 MUST 做 zip-slip 防护：每个条目的目标路径归一化后必须仍位于目标目录内，越界条目 MUST 被跳过并计入失败结果。目标已存在同名技能时 MUST 按覆盖写入。安装结果 MUST 返回成功路径、跳过条目与消息。

#### Scenario: 正常安装
- **WHEN** 主进程收到某技能的安装请求
- **THEN** 下载 ZIP、解压其中文件到 `.opencode/skills/<slug>/`，安装后该技能被 `listLocalSkills` 识别为项目级

#### Scenario: 防御恶意路径
- **WHEN** ZIP 中存在指向目标目录之外的条目路径
- **THEN** 系统跳过该条目并在结果中标记失败，不写出目标目录之外

### Requirement: 本地技能列表输出来源标记
系统 SHALL 让 `listLocalSkills` 为每个技能返回 `scope: "project" | "global"`，由命中的技能根目录属项目级还是全局判定。

同名去重规则 MUST 保持不变（项目级优先于全局）。新增 `scope` 字段 MUST 不破坏既有字段与既有独立设置页。

#### Scenario: 项目级技能
- **WHEN** 技能位于 `.opencode/skills`、`.opencode/skill` 或 `.claude/skills`（项目内）
- **THEN** 其 `scope` 为 `"project"`

#### Scenario: 全局技能
- **WHEN** 技能位于 `~/.config/opencode/skills`、`~/.claude/skills` 等全局根目录
- **THEN** 其 `scope` 为 `"global"`

#### Scenario: 同名冲突
- **WHEN** 同名技能同时存在于项目级与全局根目录
- **THEN** 仅保留项目级一条，其 `scope` 为 `"project"`
