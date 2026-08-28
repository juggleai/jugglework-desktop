## 1. 纯函数核心

- [x] 1.1 新增 `domains/connections/mcp-command-lexer.ts`：`lexCommand(input): { argv: string[] } | { error: "unterminated_quote" }`，支持单双引号与反斜杠转义，不做变量/波浪号展开
- [x] 1.2 新增 `domains/connections/mcp-config-import.ts`：`parseMcpServersJson(text)` 解析 `{mcpServers:{...}}` 与 `{<name>:{...}}` 两种形状，返回 `{ name, type, command, url, environment, headers, cwd, ignoredCount }` 或错误
- [x] 1.3 同文件实现占位符识别 `isPlaceholderValue(v)`：匹配 `<...>`、`your-*`、`xxx`、`***` 等，命中则保留键、清空值
- [x] 1.4 新增 `domains/connections/mcp-env-hints.ts`：`extractEnvKeysFromReadme(readme)` 抓 JSON 代码块中 `"env"` 对象的键；`rankEnvHints(keys, packageName)` 按 `readme-json` / `name-prefix` 分层排序
- [x] 1.5 同文件实现 `packageNameFromCommand(argv)`：跳过 `npx`/`bunx`/`uvx`/`-y`/`--yes` 等前导 token 取第一个非选项 token；并看穿聚合器包装（`<启动器> run <目标包>`）取被转发的目标包
- [x] 1.6 `tests/mcp-command-lexer.test.ts`：带空格引号参数、未闭合引号、注入字符成单元素、连续空白、空输入
- [x] 1.7 `tests/mcp-config-import.test.ts`：标准 mcpServers、无外层包裹、远程条目、占位符值、多条目只取首条、非法 JSON
- [x] 1.8 `tests/mcp-env-hints.test.ts`：README 提取（notion/slack/firecrawl 三种真实片段）、无 env 块、包名前缀排序、命令提取包名

## 2. 类型与配置写入

- [x] 2.1 `app/constants.ts` 的 `McpDirectoryInfo` 追加可选 `environment?: Record<string,string>` / `headers?: Record<string,string>` / `cwd?: string`
- [x] 2.2 `connections/store.ts` 的 `resolveLocalMcpEnvironment` 改为「内置解析结果 ∪ entry.environment」，用户输入不再被丢弃；`jugglework-ui` 既有行为不变
- [x] 2.3 `connectMcp` 本地分支写入 `cwd` 与 `timeout`（非空时）；远程分支写入 `entry.headers`，且有 header 时 `oauth` 置 `false`
- [x] 2.4 空键/空值行在写入前过滤；全空时不产出 `environment` / `headers` 字段
- [x] 2.5 SDK 热添加路径（`activeClient.mcp.add`）同步带上 `environment`，与配置文件写入保持一致

## 3. 添加弹窗改造

- [x] 3.1 `add-mcp-modal.tsx` 顶部增加「表单 / 粘贴 JSON」两个录入方式切换
- [x] 3.2 命令输入改用 `lexCommand`，未闭合引号时在提交前拦截并提示
- [x] 3.3 本地类型下新增环境变量键值表（增删行、键名校验）；工作目录与请求超时收进折叠高级区，导入带值时自动展开
- [x] 3.4 远程类型下新增请求头键值表
- [x] 3.5 粘贴 JSON 页签：文本域 + 解析按钮，成功后回填表单并切回表单视图，多条目时提示忽略数量
- [x] 3.6 建议区：命令停止输入 600ms 后触发查询，展示建议键与来源标注，点击追加为表单行并聚焦值输入
- [x] 3.7 环境变量区底部提示「将明文写入 opencode.json」

## 4. IPC 与主进程

- [x] 4.1 `packages/types/src/desktop-ipc.ts` 新增 `NpmPackageEnvHints` 结果类型与 `npmPackageEnvHints` 命令签名
- [x] 4.2 `apps/desktop/electron/main.mjs` 新增 `npmPackageEnvHints` 处理器：拉 npm packument 取 `readme`，提取键并返回；网络/解析失败返回空结果而非抛错
- [x] 4.3 `apps/app/src/app/lib/desktop.ts` 导出 `npmPackageEnvHints` 包装
- [x] 4.4 主进程侧对包名做基本校验（合法 npm 包名字符集），拒绝异常输入

## 5. 失败原文呈现

- [x] 5.1 `connectors-source.ts` 的 `ConnectorRow` 追加 `errorDetail?: string`，从 `mcpStatuses` 的 `failed` 分支取 `error`
- [x] 5.2 `connector-picker-modal.tsx` 连接器行单行截断展示 `errorDetail`
- [x] 5.3 详情弹窗完整展示 `errorDetail`（保留换行、可滚动）
- [x] 5.4 `error` 为空时回退通用文案
- [x] 5.5 补测 `tests/project-connectors-source.test.ts`：failed 带 error、failed 无 error、非 failed 状态不产出 errorDetail

## 6. i18n 与验收

- [x] 6.1 zh/en 新增文案：环境变量、请求头、工作目录、添加变量、粘贴 JSON、解析、建议来源、引号未闭合、键名非法、明文存储提示、已忽略 N 条
- [x] 6.2 `pnpm --filter @jugglework/app test` 通过
- [x] 6.3 `pnpm typecheck` 通过
- [ ] 6.4 手工验收：用 `uvx postgres-mcp --access-mode=restricted` + `DATABASE_URI` 环境变量配置成功并连上
- [ ] 6.5 手工验收：粘贴 firecrawl README 的 JSON 片段，确认回填正确且占位符值被清空
- [ ] 6.6 手工验收：故意不填连接串，确认连接器行展示服务器 stderr 原文

## 7. 手工验收暴露的缺陷修复

- [x] 7.1 `connector-picker-modal.tsx` 的 `onAdd` 交回 Promise，弹窗等待 `connectMcp` 完成再关闭（此前 `void` 丢弃导致列表不含新条目）
- [x] 7.2 `McpServerConfig` 补 `cwd` 字段（已在写入但类型缺失）
- [x] 7.3 `ConnectorRow` 增加 `serverName` / `serverConfig`，供编辑弹窗回填
- [x] 7.4 `AddMcpModal` 支持 `initial` 编辑模式：回填现有配置、server 名只读、提交时带原 serverName 以原地覆盖
- [x] 7.5 连接器详情增加「编辑配置」入口，不以 connected 为前提
- [x] 7.6 `explainConnectorErrorKey` 把 `-32000` / `ENOENT` / 超时翻译成可行动提示，原文照常展示
- [x] 7.7 补测：错误归类、编辑所需数据
- [x] 7.8 自定义 MCP 的「断开」改为停用（`setMcpEnabled(name, false)`），条目保留并可一键启用
- [x] 7.9 详情增加独立的「移除」破坏性动作（两段式确认），不以 connected 为前提
- [x] 7.10 补测：停用/启用/移除三条路径，及失败条目可移除
