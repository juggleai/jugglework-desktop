## Why

「添加自定义应用」目前只有两个输入框：名称与启动命令（`add-mcp-modal.tsx:162-268`）。而需要配置参数的 MCP 是常态，且参数落点不止一处——实测三例：

- `@modelcontextprotocol/server-postgres`：连接串是**位置参数**（`dist/index.js:15-20` 读 `process.argv[2]`，全文无 `process.env` 读取）
- `crystaldba/postgres-mcp`：连接串走 **`DATABASE_URI` 环境变量**（`server.py:558` 的 `os.environ.get("DATABASE_URI", args.database_url)`），访问模式走 `--access-mode` 标志
- 带令牌的远程 MCP：凭据走 **HTTP 请求头**

三个后果：

1. **环境变量填不了**。`resolveLocalMcpEnvironment`（`store.ts:373`）硬编码只为 `jugglework-ui` 解析 environment，用户自定义的 MCP 无法写入任何环境变量，需要 env 的 MCP 一律配不成。
2. **命令按空白粗暴切分**。`trimmedCommand.split(/\s+/)`（`add-mcp-modal.tsx:132`）不认引号，`--dsn "postgres://a b"` 会被切坏，带空格的连接串无法录入。
3. **失败原因被吞掉**。连接器面板（`connectors-source.ts`）只算 `connected` 布尔值，`McpStatus` 里已有的 `{ status: "failed"; error }` 原文从未呈现。而缺参数时服务器的 stderr 恰恰点名了缺什么——`server-postgres` 会打印 `Please provide a database URL as a command-line argument`。

即使补齐了 KV 表，用户仍然不知道 key 叫什么——key 名是隐藏知识。实测 npm README 的 JSON 代码块可高精度还原：8 个主流 MCP 包中 7 个精确挖出 env 键（notion → `NOTION_TOKEN`/`OPENAPI_MCP_HEADERS`，slack → `SLACK_BOT_TOKEN`/`SLACK_TEAM_ID`/`SLACK_CHANNEL_IDS`，firecrawl → `FIRECRAWL_API_KEY` 等），第 8 个是正确的空结果（`server-postgres` 确实没有环境变量）。

## What Changes

- **本地 MCP 支持环境变量与工作目录**：新增 `environment` 键值表与 `cwd` 输入，落到 opencode `McpLocalConfig` 的同名字段。取代 `resolveLocalMcpEnvironment` 只认 `jugglework-ui` 的硬编码分支。
- **远程 MCP 支持请求头**：新增 `headers` 键值表，落到 `McpRemoteConfig.headers`。
- **命令改为 shell 词法解析**：识别单双引号与反斜杠转义，切成 argv 数组。解析用 shell 规则，**执行仍为数组直传，不经 shell**——避免 MCP 官方 schema 在 `Argument` 定义中警告的命令注入风险。
- **新增「粘贴 JSON」录入方式**：接受社区标准 `mcpServers` 格式（README 里普遍提供的那段），解析 `command`/`args`/`env`/`url`/`headers` 后回填表单。用户不必逐字段誊抄，也不必知道 key 名。
- **环境变量 key 建议**：新增 IPC `npmPackageEnvHints`，主进程按包名拉取 npm packument，从 README 的 JSON 代码块提取 `env` 键作为高置信建议，并按「包名前缀匹配」二次排序。用户填完命令即可看到建议项，可一键采纳。
- **连接失败呈现 stderr 原文**：连接器行与详情展示 `McpStatus.failed` 的 error 原文（截断但不改写），并对 `-32000` / `ENOENT` / 超时这类不透明错误补一句可行动提示。
- **已装 MCP 可编辑**：详情提供编辑入口，以现有配置回填表单并按原 server 名原地覆盖，不再只能删了重建。
- **「断开」不再删除自定义 MCP**：改为置 `enabled: false`，条目保留在列表中可一键启用；删除下沉为详情里带二次确认的独立动作，且不以连接成功为前提。

- **BREAKING**: 无。新增字段均为可选；既有 `opencode.json` 条目不受影响；`AddMcpModal` 的 `onAdd(entry)` 契约向后兼容（`McpDirectoryInfo` 追加可选字段）。

## Capabilities

### New Capabilities

- `custom-mcp-parameters`: 自定义 MCP 的参数录入与生命周期契约——命令词法、环境变量与请求头键值对、工作目录与超时、JSON 粘贴导入、环境变量 key 建议的来源与排序、连接失败原文与提示的呈现规则、以及编辑与停用/删除的语义边界。

### Modified Capabilities

无。会话右侧扩展面板的规格仍在 `openspec/changes/2026-08-06-redesign-session-extensions-panel` 内未归档，本变更只在其连接器行追加失败原文展示，不改动既有要求。

## Impact

- 受影响代码：
  - `apps/app/src/app/constants.ts`：`McpDirectoryInfo` 追加可选 `environment` / `headers` / `cwd`。
  - `apps/app/src/react-app/domains/connections/mcp-command-lexer.ts`（新增）：shell 词法解析，纯函数。
  - `apps/app/src/react-app/domains/connections/mcp-config-import.ts`（新增）：`mcpServers` JSON 解析为表单值，纯函数。
  - `apps/app/src/react-app/domains/connections/mcp-env-hints.ts`（新增）：README 提取与建议项排序，纯函数（网络调用在主进程）。
  - `apps/app/src/react-app/domains/connections/modals/add-mcp-modal.tsx`：新增 KV 表、cwd、JSON 粘贴页签、建议项区块。
  - `apps/app/src/react-app/domains/connections/store.ts`：`connectMcp` 写入 `environment` / `headers` / `cwd`；`resolveLocalMcpEnvironment` 改为合并内置解析与用户输入。
  - `apps/app/src/react-app/domains/settings/pages/project-extensions/connectors-source.ts`：`ConnectorRow` 追加 `errorDetail`。
  - `apps/app/src/react-app/domains/settings/pages/project-extensions/connector-picker-modal.tsx`：连接器行与详情展示失败原文。
  - `apps/desktop/electron/main.mjs`：新增 `npmPackageEnvHints` 处理器（主进程 fetch，沿用 `skillhubSearch` 模式）。
  - `packages/types/src/desktop-ipc.ts`：新增 `npmPackageEnvHints` 命令类型与 `NpmPackageEnvHints` 结果类型。
  - `apps/app/src/app/lib/desktop.ts`：导出 `npmPackageEnvHints` 包装。
- i18n：新增环境变量、请求头、工作目录、粘贴 JSON、建议 key、失败原文等文案（zh/en）。
- 无数据迁移；无新增第三方依赖（shell 词法自行实现，约 40 行）。
- 网络：新增对 `registry.npmjs.org` 的只读请求，仅在用户填写本地命令后触发，失败静默降级为手填。
