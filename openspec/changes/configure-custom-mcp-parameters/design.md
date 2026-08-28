# 设计

## 落点全集

opencode live schema（`https://opencode.ai/config.json`）中 MCP 可写字段：

```
McpLocalConfig   : type  command[]  cwd  environment{}  enabled
McpRemoteConfig  : type  url  headers{}  oauth  enabled
McpOAuthConfig   : clientId  clientSecret  scope  callbackPort
```

本变更把 `environment`、`headers`、`cwd` 三个此前未暴露的字段接到 UI。`oauth` 已由现有折叠区覆盖，不动。

## 命令词法

自行实现，不引入 `shell-quote`。规则取 POSIX shell 的最小子集：

- 空白（空格/制表）分隔 token
- 单引号内所有字符字面量，包括双引号与反斜杠
- 双引号内保留空格，`\"` 与 `\\` 为转义
- 引号外反斜杠转义下一个字符
- 未闭合引号 → 返回错误，不做猜测性补全

**不实现**：变量展开、`~` 展开、管道、重定向、`&&`。这些在 MCP 启动命令里没有合法用途，且实现它们等于把 shell 语义引入一个不过 shell 的执行路径。

安全边界：解析结果是 `string[]`，经 `McpLocalConfig.command` 交给 opencode 直接 spawn。全链路无 shell 参与，因此 `;rm -rf ~/x` 只会成为一个普通 argv 元素。MCP 官方 `server.schema.json` 在 `Argument` 定义里专门警告了这一点。

## JSON 粘贴导入

接受两种顶层形状，因为社区两种都在用：

```jsonc
{ "mcpServers": { "<name>": { ... } } }   // Claude Desktop / Cursor / 多数 README
{ "<name>": { ... } }                      // 少数 README 省略外层
```

单条目直接采用；多条目取第一条并提示"已导入 N 条中的第 1 条"（本版不做批量导入，避免与逐条命名/校验流程冲突）。

字段映射：

| 源 | 目标 |
|---|---|
| `command` + `args[]` | `command: [command, ...args]` |
| `env{}` | `environment{}` |
| `url` / `serverUrl` | `url`，类型切远程 |
| `headers{}` | `headers{}` |
| `type: "sse" \| "http" \| "streamable-http"` | 远程 |
| `cwd` | `cwd` |

`env` 值里形如 `<YOUR_TOKEN>`、`your-api-key`、`xxx` 的占位符保留 key、清空 value 并标记为待填——直接把占位符当真实值写进配置会产生一个"看起来配好了但连不上"的条目。

## 环境变量 key 建议

**来源与置信度分层**：

1. README 的 JSON 代码块中 `"env"` 对象的键 → `readme-json`，高置信，默认展开
2. 包名前缀匹配的键（`firecrawl-mcp` → `FIRECRAWL_*`）→ `name-prefix`，中置信，默认展开
3. 其余 → 本版不采集

第 3 类（扫包源码）实测噪音过大——`firecrawl-mcp` 源码里有 18 个 `process.env.X`，其中 `FASTMCP_PORT`/`HOST`/`PORT`/`NO_PROXY` 等与用户无关；notion 包混入 `NODE_ENV`/`DEBUG_FD`/`TRACE_DEPRECATION`（来自传递依赖）。召回高但精度低，留待后续版本配合噪音名单再做。

**提取正则**：抓 ` ```json ` / ` ```jsonc ` / 无语言标注的代码块 → 块内匹配 `"env"\s*:\s*{...}` → 取 `"KEY":` 形式的键名，限定 `[A-Z][A-Z0-9_]{2,}`。

**触发时机**：用户在本地命令框停止输入 600ms 后，从命令中提取包名（跳过 `npx`/`-y`/`--yes`/`bunx`/`uvx` 等前导 token，取第一个非选项 token）。远程类型不触发。

**失败处理**：网络失败、包不存在、README 无 JSON 块——一律静默降级为空建议，不弹错误。建议是加速器，不是前置条件。

## 环境变量的作用域与合并

写入 `opencode.json` 条目的 `environment`，是**该 MCP 独有**的。与已有的全局 `~/.config/jugglework/env.json`（`env-file.ts`，spawn 时注入整个引擎进程）并存：

- 全局 env store：跨项目复用，但对所有 MCP 子进程可见
- 条目级 `environment`：仅本 MCP 可见，隔离性更好

本版不做两者的联动（"已在全局配置，是否复用"）与密钥的 safeStorage 化，仅在文案上提示环境变量会明文写入 `opencode.json`。

## 失败原文呈现

`McpStatus` 已有 `{ status: "failed"; error: string }`，`mcp-view.tsx:1253` 的 `readMcpErrorInfo` 已在扩展页消费它；连接器面板（项目设置里的入口）尚未消费。本变更把该口径复用到 `ConnectorRow.errorDetail`：

- 列表行：单行截断展示
- 详情弹窗：完整展示（可滚动），保留原始换行
- **不改写文案**。`Please provide a database URL as a command-line argument` 这类原文比任何"连接失败，请检查配置"都更有信息量

## 手工验收发现的问题与对策

验收暴露了三类问题，均已在本变更内修复（见 tasks.md 第 7 节）：

1. **添加后列表不更新**：`connector-picker-modal` 用 `void` 丢弃了 `onAddCustomMcp` 的 Promise，弹窗在配置写入与刷新之前就关闭。
2. **失败原因不可读**：引擎只上报 `-32000 connection closed`，不透出子进程 stderr。已补可行动提示，但根因仍在——实测某第三方聚合器 CLI 崩在 `TypeError: e.filter is not a function`，这条信息只有手动执行命令才拿得到。
3. **「断开」是不可逆删除**：自定义 MCP 没有目录项兜底，删除后列表里不留痕迹且配置无从恢复。已改为停用语义，删除下沉为带确认的独立动作。

## 不在本版范围

- **启动诊断**：用条目的命令与环境在主进程跑一次并回传 stderr。第 2 类问题的真正解法——本版的文案提示只能给出「常见原因」，在聚合器崩溃这类场景反而会把用户引向错误方向（提示说"可能缺环境变量"，而环境变量恰恰是对的）。
- **命令参数的占位符识别**：粘贴导入只对 `env` / `headers` 的值做占位符清理，`args` 里的 `/path/to/other/allowed/dir`、`/Users/username/...` 一类模板路径会原样进命令，失败时同样只得到不透明错误。
- 官方 MCP Registry 查询（`registry.modelcontextprotocol.io` + npm `mcpName` 反查）——链路已验证可行，但覆盖率有限（抽样中 crystaldba/postgres-mcp 未登记），作为独立变更
- 扫包源码补全建议
- `isSecret` 值走 Electron safeStorage；当前凭据明文存于运行时库
- 目录条目的声明式参数（`McpParameter` 描述符）与描述符驱动表单
- 批量导入多条 `mcpServers`
- 工具粒度的权限控制（opencode `permission` 支持按工具名设 ask/allow/deny，UI 未暴露）
