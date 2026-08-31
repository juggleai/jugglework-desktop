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

### Requirement: 第一方 Cloud MCP 鉴权失败自动恢复一次
桌面 SHALL 在会话维护和发送前通过 direct MCP probe 验证第一方 `jugglework-cloud` Bearer，而不是只信任 Engine 的历史 `connected` 状态。probe 明确返回 `401`、`invalid_mcp_token` 或等价 Token 鉴权失败时，桌面 SHALL 在当前 workspace、organization、server scope 内重新 Mint、持久化、重注册并复验一次。一次恢复后仍失败 SHALL 停止自动重试并向用户报告；membership、scope、policy、网络或下游连接器失败 MUST NOT 触发 re-mint。

#### Scenario: 历史 connected 状态掩盖过期 Token
- **WHEN** Engine 仍显示 `connected`，但 direct probe 返回 `invalid_mcp_token`
- **THEN** freshness marker 不覆盖 probe 结果，桌面重新 Mint 并复验一次

#### Scenario: 新 Token 仍被拒绝
- **WHEN** 本轮恢复后 Cloud MCP 仍返回 Token 鉴权失败
- **THEN** 本轮停止，不形成 re-mint 循环，并显示重新登录或检查当前组织的操作建议

#### Scenario: 非 Token 鉴权问题
- **WHEN** probe 返回 membership、scope、policy 或网络错误
- **THEN** 桌面保留原错误并且不重新 Mint

### Requirement: 仓库不跟踪运行时 OpenCode 凭据配置
仓库根目录的本地 `config.json` SHALL 被 Git 忽略，MUST NOT 提交 `jwmcp_*` Bearer 或其他账户运行时凭据。取消跟踪 SHALL 保留开发者本机文件，当前 Desktop 账户与工作区继续使用 Runtime SQLite 和派生的 `runtime-opencode-config.json`。

#### Scenario: 已登录开发者更新代码
- **WHEN** 仓库停止跟踪根目录 `config.json`
- **THEN** 本机文件、当前登录 Session 和 Runtime SQLite 均不被删除，当前账户不退出
