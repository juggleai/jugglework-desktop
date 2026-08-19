## ADDED Requirements

### Requirement: 导出与备份按结构剥离 MCP 凭据
工作区导出 SHALL 按配置结构剥离 MCP 凭据，MUST NOT 依赖文件名黑名单判定机密——凭据的判据是它在配置中的位置，而 `opencode.json` 是一个完全合法的文件名。剥离范围 MUST 覆盖：MCP 条目的全部环境变量值、凭据类请求头（`Authorization`、`X-Api-Key` 等）、OAuth 的 `clientSecret` 与令牌字段、以及命令行参数中内嵌于 URL 的密码。键名、非凭据字段与参数顺序 MUST 保持原样，使接收方能看出配置形状并知道需要重填哪些值。被剥离项的清单 SHALL 写入导出 manifest。配置解析失败时 MUST 原样入包而非中断导出。

#### Scenario: 云端 MCP 令牌不随导出流出
- **WHEN** 工作区配置含 `mcp["jugglework-cloud"].headers.Authorization = "Bearer jwmcp_…"`
- **THEN** 导出包中该值为占位串，`url` 与 `oauth` 等非凭据字段不变，manifest 的 `redacted` 记录该项

#### Scenario: 环境变量保留键名清空值
- **WHEN** 某本地 MCP 配有 `MYSQL_HOST` / `MYSQL_PASS` / `MYSQL_DB`
- **THEN** 三个键都在，值都是占位串——键名本身不是机密，且接收方需要知道该填哪些变量

#### Scenario: 命令行内嵌的连接串密码
- **WHEN** 命令为 `["npx","-y","@x/server-postgres","postgresql://alice:s3cret@localhost:5432/mydb"]`
- **THEN** 仅密码段被替换，协议、用户名、主机与库名保留，其余参数不变

#### Scenario: 非凭据请求头不受影响
- **WHEN** 远程 MCP 配有 `X-Trace-Id` 与 `Accept` 请求头
- **THEN** 两者原样保留，manifest 不记录任何剥离项

#### Scenario: 配置无法解析
- **WHEN** `opencode.json` 含注释或语法有误而无法解析
- **THEN** 该文件原样入包，导出不因此失败
