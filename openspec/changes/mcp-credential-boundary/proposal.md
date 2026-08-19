## Why

组织分发的 MCP 声称「真实凭据托管在服务端，桌面只拿到中转后的凭据」。跨仓库读下来，这个说法只对 **remote 型** MCP 成立，且中转凭据本身的边界比预期宽得多。

**凭据边界与承载边界不重合。** `services/mcp_delivery.go` 的聚合规则是「含任一 desktop 组件即 `desktop_only`」。cloud 组件的凭据在服务端（`external_mcp_credentials.go` 用 AES-GCM 加密、AAD 绑 connection/member/kind），而 desktop 组件（stdio）没有任何托管路径——凭据要么明文落到工作区配置，要么根本配不了。模型里缺「服务端持有凭据 + 本地进程执行」这一格。

**中转凭据的粒度过粗。** `services/mcp.go` 的 `normalizeMCPScopes` 只认 `mcp:read` / `mcp:write` 且默认全给；token 绑 session + org，不绑 workspace、不绑 connection、不绑 tool。一个工作区配置里的那串 token 可调用该 org 下全部已授权连接的全部工具。而 `apis/mcp.go:551` 的注释承认下游工具读写属性无法从 `tools/list` 判定，因此任何调用都要求 `mcp:write`——`mcp:read` 实际执行不了任何东西，两档 scope 退化成一档。

**中转凭据明文落盘且随导出流出。** 桌面每约一小时重铸 token 并写入工作区 MCP 配置（`cloud-mcp-reconciler.ts:190`）。`workspace-archive.mjs` 导出工作区时包含 `opencode.json`，而其 `isSecretName` 只拦 `.env` / `credentials.*` / `*.key|pem|p12|pfx`——`opencode.json` 一条都不匹配。**导出一个工作区等于导出一枚一小时内有效、org 范围的 MCP 令牌**，外加用户自填的数据库密码与 OAuth client secret。

**服务端做的 provider 隔离在桌面被抹平。** `services/gateway_tokens.go:19` 特意为每个 provider 生成独立环境变量名，注释写明是为了防止客户端把一个 provider 的 token 发给另一个。但桌面把它镜像成 `MCP_GATEWAY_KEY_<PROVIDER>` 写入**全局** `env.json`，而 `runtime.mjs:772` 把整份 env.json 注入引擎进程——**每个 MCP 子进程都能读到全部 provider 的 gateway token**，包括用户随手装的第三方 stdio MCP。

**云端工具调用没有审计。** `gateway_relay.go:85` 有 `GatewayUsage` 记录，MCP 侧的 `callTool` / `executeExternalMCPCapability` 没有对应记录。管理员托管了凭据却查不到「谁在何时用它调了什么」，而桌面侧连 `mcp.add` / `mcp.remove` 都写审计。

## What Changes

- **导出剥离 MCP 凭据**（本变更已实现）：工作区导出按**配置结构**剥离凭据而非按文件名黑名单——环境变量值、凭据类请求头、OAuth secret、命令行内嵌的连接串密码，一律替换为占位串，键名与非凭据字段保持原样；剥离清单写入 manifest，接收方知道哪些值需要重填。
- **配置中存凭据引用而非明文值**：工作区 MCP 配置持有引用（如 `{jugglework:cloud-mcp-token}`），实际值在 spawn / 请求时解析。一并解决明文落盘、导出泄漏与每小时重写配置触发引擎重载三个症状。
- **MCP 工具调用审计**：服务端为 `tools/call` 记录成员、连接、工具名、结果与耗时，与 `GatewayUsage` 对齐。
- **token 绑定 connection 集合**：复用 automation 场景已有的 `AllowsAutomationConnection` 允许清单思路，交互场景同样按连接收窄；工具读写属性由连接注册时标注，不再试图从 `tools/list` 推断。
- **gateway 凭据按 provider 隔离注入**：不再镜像进全局 env store，改为仅注入声明了该 provider 绑定的 MCP 子进程，恢复服务端已有的隔离意图。
- **stdio MCP 的服务端凭据通道**：补上「服务端持有凭据 + 本地执行」这一格；依赖「凭据引用」机制。

- **BREAKING**: 导出包中的 MCP 凭据字段值变为占位串。导入方需重新填写——此前导入方会静默继承导出方的凭据，这本身即是缺陷。

## Capabilities

### New Capabilities

- `mcp-credential-boundary`: 组织分发 MCP 的凭据边界——凭据在服务端、传输中、桌面配置与子进程环境各自的存放形态与可见范围，导出与备份时的剥离规则，以及中转凭据的粒度与审计要求。

### Modified Capabilities

无。`custom-mcp-parameters`（用户自填参数的录入契约）不变；本变更约束的是这些值离开表单之后的去向。

## Impact

- 受影响代码（本变更已实现部分）：
  - `apps/desktop/electron/workspace-archive-redaction.mjs`（新增）：结构化剥离，纯函数。
  - `apps/desktop/electron/workspace-archive.mjs`：导出前剥离，manifest 增加 `redacted` 清单。
- 后续项跨两仓库：`jugglework-server` 的 `services/mcp.go`、`apis/mcp.go`、`services/gateway_tokens.go`；桌面的 `cloud-mcp-reconciler.ts`、`provider-auth/store.ts`、`runtime.mjs`。
- 无数据迁移；无新增依赖。
