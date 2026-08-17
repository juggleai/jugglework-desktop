## ADDED Requirements

### Requirement: 启动命令按 shell 词法解析
本地 MCP 的启动命令 SHALL 按 POSIX shell 的引号与转义规则切分为 argv 数组：空白分隔 token，单引号内字符全部字面量，双引号内保留空白且支持 `\"` 与 `\\` 转义，引号外反斜杠转义下一字符。未闭合引号 MUST 视为输入错误并阻止提交，MUST NOT 猜测性补全。解析结果 MUST 以字符串数组形式写入 `McpLocalConfig.command` 并由引擎直接 spawn，全链路 MUST NOT 经过 shell。变量展开、`~` 展开、管道与重定向 MUST NOT 被解释。

#### Scenario: 带空格的引号参数
- **WHEN** 用户输入 `npx -y foo --dsn "postgres://a b/c"`
- **THEN** 解析为 `["npx","-y","foo","--dsn","postgres://a b/c"]`，第 5 个元素完整保留空格

#### Scenario: 未闭合引号
- **WHEN** 用户输入 `npx -y foo --dsn "postgres://a`
- **THEN** 提交被阻止并提示引号未闭合，不写入任何配置

#### Scenario: 注入字符不被执行
- **WHEN** 用户输入 `npx -y foo ";rm -rf ~/x"`
- **THEN** `;rm -rf ~/x` 成为单个 argv 元素原样传给子进程，MUST NOT 触发任何 shell 解释

### Requirement: 本地 MCP 支持环境变量与工作目录
新增自定义本地 MCP 的表单 SHALL 提供环境变量键值表与工作目录输入，分别写入 `McpLocalConfig.environment` 与 `McpLocalConfig.cwd`。键 MUST 满足 `[A-Za-z_][A-Za-z0-9_]*`，不满足时阻止提交。空键或空值的行 MUST 在写入时被丢弃，MUST NOT 产生空字符串条目。未填写任何环境变量时 MUST NOT 写入 `environment` 字段，未填写工作目录时 MUST NOT 写入 `cwd`——留空即由引擎使用工作区根目录。工作目录 SHALL 收在折叠的高级区内而非默认展开：其默认值适用于绝大多数 MCP，把它摆在主流程会让每个用户都要判断一次是否该填。

#### Scenario: 环境变量写入配置
- **WHEN** 用户添加本地 MCP 并填入 `DATABASE_URI` = `postgresql://localhost/db`
- **THEN** `opencode.json` 中该条目为 `{ "type": "local", "command": [...], "environment": { "DATABASE_URI": "postgresql://localhost/db" }, "enabled": true }`

#### Scenario: 非法键名被拒绝
- **WHEN** 用户填入键 `MY-KEY`
- **THEN** 提交被阻止并提示键名只能包含字母、数字与下划线且不以数字开头

#### Scenario: 空行不落盘
- **WHEN** 用户添加了三行环境变量但其中一行键与值均为空
- **THEN** 写入的 `environment` 只含两条有效记录

### Requirement: 本地 MCP 支持请求超时
新增自定义本地 MCP 的表单 SHALL 提供请求超时输入，写入 `McpLocalConfig.timeout`（毫秒）。留空时 MUST NOT 写入该字段，由引擎按其默认值（5000 毫秒）处理。填写值 MUST 为大于 0 的整数，否则阻止提交。表单 SHALL 说明首次运行 `npx` / `uvx` 需下载依赖、容易超过默认值。

#### Scenario: 留空不落盘
- **WHEN** 用户未填写请求超时
- **THEN** 写入的条目不含 `timeout` 字段

#### Scenario: 非法值被拒绝
- **WHEN** 用户填入 `0` 或 `-1` 或非数字
- **THEN** 提交被阻止并提示需为大于 0 的整数

#### Scenario: 首次拉包场景
- **WHEN** 用户为 `uvx postgres-mcp` 填入 `60000`
- **THEN** 写入的条目为 `{ ..., "timeout": 60000 }`

### Requirement: 少用字段收进折叠区且不静默吞值
工作目录与请求超时 SHALL 收在本地类型下的折叠高级区内，默认收起。当导入的 JSON 片段含 `cwd` 或 `timeout` 时，高级区 MUST 自动展开——导入得来的值必须对用户可见且可改，MUST NOT 因为收在折叠区而被静默带入配置。

#### Scenario: 默认收起
- **WHEN** 用户手动新增一个本地 MCP
- **THEN** 高级区默认收起，主流程只呈现名称、类型、命令与环境变量

#### Scenario: 导入含工作目录时自动展开
- **WHEN** 粘贴的片段含 `"cwd": "packages/api"`
- **THEN** 回填表单后高级区自动展开并显示该值

### Requirement: 远程 MCP 支持请求头
新增自定义远程 MCP 的表单 SHALL 提供请求头键值表，写入 `McpRemoteConfig.headers`。填写了请求头时 `oauth` MUST 置为 `false`，与现有 header 鉴权条目的处理保持一致——否则引擎会在已有有效请求头的情况下仍报 `needs_auth`。

#### Scenario: 请求头与 OAuth 互斥
- **WHEN** 用户为远程 MCP 填入 `Authorization: Bearer xxx`
- **THEN** 写入的条目含该 header 且 `oauth` 为 `false`

### Requirement: 粘贴 JSON 导入
添加自定义 MCP 的界面 SHALL 提供「粘贴 JSON」录入方式，接受 `{ "mcpServers": { ... } }` 与 `{ "<name>": { ... } }` 两种顶层形状，解析后回填表单而非直接落盘，使用户可在提交前复核。`command` 与 `args[]` MUST 合并为单一 argv 数组；`env` MUST 映射到环境变量表；`url`/`serverUrl` 出现时 MUST 切换为远程类型；`headers` MUST 映射到请求头表。JSON 非法时 MUST 提示解析错误并保留用户输入。含多个 server 时 MUST 导入第一条并明确告知已忽略其余条目。

#### Scenario: 标准 mcpServers 片段
- **WHEN** 用户粘贴 `{"mcpServers":{"postgres":{"command":"npx","args":["-y","@x/pg"],"env":{"DATABASE_URI":"postgresql://localhost/db"}}}}`
- **THEN** 名称回填 `postgres`，命令回填 `npx -y @x/pg`，环境变量表出现一行 `DATABASE_URI`

#### Scenario: 远程条目
- **WHEN** 粘贴的条目含 `"url": "https://mcp.example.com/mcp"` 与 `headers`
- **THEN** 类型切换为远程，URL 与请求头表被回填

#### Scenario: 占位符值不被当作真实值
- **WHEN** 粘贴的 `env` 为 `{"API_KEY":"<YOUR_API_KEY>"}`
- **THEN** 环境变量表出现键 `API_KEY` 但值为空并标记为待填，MUST NOT 把占位符文本写入配置

#### Scenario: 多条目只取首条
- **WHEN** 粘贴的 `mcpServers` 含 3 个 server
- **THEN** 回填第一条并提示其余 2 条已忽略

### Requirement: 环境变量 key 建议
用户在本地命令中填入 npm 包名后，系统 SHALL 尝试从该包的 npm README 中提取建议的环境变量键并展示，用户可一键采纳为表单行。命令经聚合器 CLI 转发时（`<启动器> run|exec|start|launch|serve <目标包>`），查询对象 MUST 为被转发的目标包——用户要配置的环境变量属于真正运行的 MCP，而非启动器。建议项 MUST 标注来源：README 的 JSON 代码块中 `env` 对象的键为高置信来源，包名前缀匹配的键为次级来源。建议 MUST NOT 自动写入配置，MUST 由用户显式采纳。网络失败、包不存在或 README 无可提取内容时 MUST 静默降级为无建议，MUST NOT 阻塞或中断添加流程。远程类型 MUST NOT 触发该查询。

#### Scenario: 从 README 提取到键
- **WHEN** 用户填入命令 `npx -y firecrawl-mcp`
- **THEN** 建议区展示 `FIRECRAWL_API_KEY` 并标注来源为该包的说明文档

#### Scenario: 包确实无环境变量
- **WHEN** 用户填入命令 `npx -y @modelcontextprotocol/server-postgres`
- **THEN** 不展示任何建议项，且不提示错误——该包确实不读取环境变量

#### Scenario: 网络不可用
- **WHEN** 查询 npm 失败
- **THEN** 添加流程不受影响，用户仍可手动填写键值对

#### Scenario: 经聚合器 CLI 启动
- **WHEN** 用户填入命令 `npx -y @mcp_hub_org/cli@latest run @benborla29/mcp-server-mysql`
- **THEN** 查询的是被转发的 `@benborla29/mcp-server-mysql` 而非启动器 `@mcp_hub_org/cli`，建议区展示 `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASS` / `MYSQL_DB`

#### Scenario: 转发动词后是选项而非包名
- **WHEN** 用户填入命令 `npx -y @some/cli run --key abc`
- **THEN** 查询的是 `@some/cli`，MUST NOT 把选项值 `abc` 当作包名

#### Scenario: 采纳建议
- **WHEN** 用户点击建议项 `FIRECRAWL_API_KEY`
- **THEN** 环境变量表新增一行，键为 `FIRECRAWL_API_KEY`、值为空并获得输入焦点

### Requirement: 连接失败呈现原始错误
连接器列表与详情 SHALL 呈现 `McpStatus` 为 `failed` 时的 `error` 原文：列表行单行截断，详情完整展示并保留换行。错误原文 MUST NOT 被替换为泛化文案——服务器自述的失败原因（如缺少必需参数）是用户补全配置的主要线索。仅当 `error` 为空时 SHALL 回退到通用失败文案。

#### Scenario: 缺少必需参数
- **WHEN** 某本地 MCP 因缺少数据库连接串启动失败，引擎报告的 error 为 `Please provide a database URL as a command-line argument`
- **THEN** 该连接器行展示这句原文而非「连接失败」

#### Scenario: 无错误详情
- **WHEN** 状态为 `failed` 但 `error` 为空字符串
- **THEN** 展示通用连接失败文案

### Requirement: 添加与保存需等待写入完成
添加/编辑弹窗 SHALL 等待连接动作真正完成后再关闭，期间保持提交中状态并禁用提交按钮。调用方 MUST 把连接动作的 Promise 交回弹窗，MUST NOT 丢弃——否则弹窗会在配置写入与列表刷新之前关闭，用户看到的是不含新条目的旧列表。

#### Scenario: 新增后列表立即包含该条目
- **WHEN** 用户提交一个新的本地 MCP
- **THEN** 弹窗在写入与刷新完成后才关闭，关闭时连接器列表已包含该条目

### Requirement: 已装 MCP 可编辑配置
已装 MCP 的详情 SHALL 提供编辑入口，打开时以其现有配置回填表单（命令、环境变量、请求头、工作目录、超时），保存后按原 server 名原地覆盖而非新建。编辑入口 MUST NOT 以连接成功为前提——启动失败的条目正是最需要改配置的。server 名 MUST NOT 可改，界面 SHALL 说明改名需删除后重建。

#### Scenario: 编辑启动失败的条目
- **WHEN** 某 MCP 因缺少环境变量启动失败，用户打开其详情
- **THEN** 编辑入口可用，点击后表单以现有命令与环境变量回填

#### Scenario: 保存为原地覆盖
- **WHEN** 用户编辑名为 `postgres` 的条目并保存
- **THEN** 配置中 `mcp.postgres` 被整体替换，MUST NOT 产生第二条条目

### Requirement: 不透明失败给出可行动提示
当引擎报告的失败原文为不透明形式（裸 JSON-RPC 错误码、`connection closed`、`ENOENT`、超时）时，详情 SHALL 在原文之外补一句常见原因与下一步动作。该提示 MUST 作为补充展示，MUST NOT 替换原文。无法归类的错误 MUST 只展示原文。

#### Scenario: 进程启动后退出
- **WHEN** 失败原文为 `-32000 connection closed`
- **THEN** 详情展示该原文，并补充说明进程启动后立即退出的常见原因（缺环境变量、参数不对、依赖未装）

#### Scenario: 已经足够具体的错误
- **WHEN** 失败原文为 `Please provide a database URL as a command-line argument`
- **THEN** 只展示原文，不追加泛化提示

### Requirement: 自定义 MCP 的断开为停用而非删除
连接器面板中，没有目录项兜底的自定义 MCP，其「断开」SHALL 置 `enabled: false` 而非从配置中删除。条目 MUST 继续出现在列表中并标注为已停用，且 SHALL 可一键重新启用。目录项支持的连接器可保持移除语义——它们删除后仍以未连接状态留在目录里，可一键重加。删除 SHALL 作为独立的破坏性动作出现在详情中，且 MUST 二次确认；该动作 MUST NOT 以连接成功为前提，启动失败或已停用的条目同样可删除。

#### Scenario: 停用自定义 MCP
- **WHEN** 用户对一个自定义本地 MCP 点击断开
- **THEN** 该条目置为 `enabled: false`，仍出现在列表中并标注已停用，其命令与环境变量保持不变

#### Scenario: 重新启用
- **WHEN** 用户对已停用的条目点击启用
- **THEN** 该条目置回 `enabled: true`，无需重新填写任何配置

#### Scenario: 显式删除需确认
- **WHEN** 用户在详情中点击移除
- **THEN** 按钮进入确认态，再次点击才真正从配置中删除

#### Scenario: 失败条目可删除
- **WHEN** 某条目启动失败因而未连接
- **THEN** 移除动作仍然可用
