# 连接器的工作区级开关（桌面端）

配套文档：`jugglework-server/docs/plugin-mcp-authoring-and-workspace-scope.md`（服务端）。

本文覆盖桌面端一项改动：**把「哪些组织 MCP 连接在这个工作区生效」从不可表达变为设置 › 连接器里的一个开关。**

---

## 1. 问题

一个会话里真正在用的 MCP，和这个成员被授权的 MCP，往往不是同一批。当前桌面只有两种开关，粒度都不对：

| 开关 | 位置 | 作用对象 | 问题 |
| --- | --- | --- | --- |
| MCP 条目 `enabled` | 会话右侧设置 › 连接器 | 单个本地/自定义 MCP，工作区级 | 管不到 Cloud MCP 连接策略 |
| `jugglework-cloud` 条目 | 引擎内部维护 | **整条云连接** | 关掉即失去全部 Cloud MCP，没有中间态 |

于是「这个项目只用 GitHub，不想让 Notion 的 12 个工具挤占搜索结果」这件事，今天做不到。

---

## 2. 设置 › 连接器

### 2.1 位置

Cloud MCP 的工作区开关落在会话右侧**设置 › 连接器**的「已连接」MCP 行，不进入个人设置导航。个人设置不出现工作区分组；其中全局分组的「连接器」只管理全局 OpenCode MCP 配置，并提供全局添加、启停与移除操作。

会话右侧设置里的「连接器」是当前会话已配置/已授权 MCP 的管理入口，按「已连接 / 本工作区已关闭」分组，不展示未连接、待授权、待配置或未安装目录项，不向用户暴露“组织连接”这一后端概念，也不按来源拆页签。关闭工作区开关后，条目从「已连接」移动到「本工作区已关闭」，并保留开关供重新打开。

会话输入栏的 MCP 展开列表与右侧连接器共享同一工作区真值：都隐藏 `jugglework-cloud` 内部 transport，都保留全局/本工作区 scope，并同时应用普通 MCP `disabledServerNames` 与 Cloud connection workspace policy。输入栏是选择视图，只展示“当前工作区开启且当前连接成功”的严格子集；关闭、断开、异常、待授权、待配置和未安装项均只留在右侧管理视图完成修复、安装或开关操作。

`jugglework-cloud` 是自动维护的 Cloud capability transport，只承载 `search_capabilities` / `execute_capability`，不是一条业务连接器。会话列表不得展示或提供它的普通工作区开关，避免用户误关整条 Cloud 能力轨道；具体 Cloud MCP 仍按各自连接行显示策略开关。

### 2.2 列表

一张两列列表，不按状态分组——连接器的状态写在每一行上，用小标题切成三段只会让「我的连接器有哪些」需要读三处。排序把可以直接用的排在前面，其次是等你授权的，最后是等管理员配置的。

```
┌─ 设置 › 连接器 ───────────────────────────────────────────────────────────┐
│                                                                           │
│  开关只作用于本设备的当前工作区：关闭后，这个连接器的工具不会出现在此工作区的 │
│  模型工具列表里。                                                          │
│                                                                           │
│  ┌──────────────────────────────────┐ ┌──────────────────────────────────┐│
│  │ ◆ GitHub              [ ●———— ]  │ │ ◆ Notion              [ ————○ ]  ││
│  │   由你的组织管理                  │ │   使用你的账户 · 本工作区已关闭   ││
│  └──────────────────────────────────┘ └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐ ┌──────────────────────────────────┐│
│  │ ◆ 客户简报（插件）     [ ●———— ]  │ │ ◆ 内部知识库        ［ 连接 ］   ││
│  │   1 个 skill · 1 个 MCP          │ │   使用你的账户                    ││
│  └──────────────────────────────────┘ └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐                                     │
│  │ ◆ Jira            ［ 设置连接 → ］│                                     │
│  │   需要 Jira Cloud                 │                                     │
│  └──────────────────────────────────┘                                     │
└───────────────────────────────────────────────────────────────────────────┘
```

| 行的状态 | 右侧控件 |
| --- | --- |
| 已连接（`ready`） | **工作区开关**；可断开的原生提供商账号额外给一个「断开」 |
| 需要你授权（`needs_signin`） | 「连接」/「重新连接」按钮 |
| 需要管理员配置（`needs_admin_setup`） | 「设置连接 →」或一个状态标签 |

已连接的行用开关代替原来的「就绪」标签：状态本身就写在开关上，再挂一个标签是重复。

工作区开关落在具体的已连接 Cloud MCP 行，并按该行的 `connectionId` 写入策略。插件包不是工作区开关载体；插件贡献的 MCP 最终仍投影为具体 MCP 行。

统一列表中的全局项带「全局」标识且不能误用工作区写接口，工作区项带「本工作区」标识。个人设置的全局「连接器」页面仍只展示并管理全局 MCP。

全局「连接器」同样分为「已连接 / 未连接」：已连接只看当前运行环境的全局配置与 `config.global` 投影；未连接来自真实 MCP 快速连接目录，仅与全局名称去重。工作区存在同名 MCP 不会隐藏全局未连接项；`jugglework-cloud` 及不含 MCP resource 的 Provider、浏览器、Voice 等扩展不进入该目录。连接目录项必须写全局配置，OAuth 条目写入后复用现有授权弹窗，不得调用工作区 MCP 写接口。

### 2.3 workspaceKey

Cloud MCP 工作区开关需要一个稳定的工作区标识发给服务端。JuggleWork 服务端按工作区生成一次并持久化（`apps/server/src/workspace-key.ts`）：

```
workspaceKey = "ws_" + sha256(workspace.id + "\0" + installId).slice(0, 32)
```

- 用 `workspace.id` 而非目录路径：移动目录不应重置策略。
- 混入 `installId`（`<runtime>/install-id`，首次读取时生成）：不同机器上的同名工作区互不干扰，也避免把本地路径信息带上云。
- 存于 jugglework 工作区配置的 `workspaceKey`，与工作区同生命周期；**已存的值优先于重新派生**，派生规则日后变化也不会让云端已有策略失配。
- 由服务端而非渲染进程生成：同一工作区在多个窗口里必须拿到同一个键，否则云端会把它们当成不同工作区，策略与令牌都会分叉。客户端通过
  `GET /workspace/:id/mcp/jugglework-cloud/workspace-key` 读取并进程内缓存。

铸造 MCP token 时带上：

```
POST /v1/mcp/token  { scopes: [...], workspaceKey }
```

服务端把它写进令牌记录，此后该令牌的每次能力搜索与执行都自带工作区身份（服务端文档 §A.4）。**这意味着每个工作区需要独立的 MCP token**——`cloud-mcp-health.ts` 的 desired 配置构造需按工作区分别铸造，不再复用 host 级单一 token。

### 2.4 令牌生命周期

改为每工作区一个令牌会把现有令牌维护的问题按工作区数放大，必须与服务端改造配套落地。

**现存的一处配对错误。** 服务端默认 `tokenTTLSeconds: 3600`（1 小时），桌面 `CLOUD_MCP_REFRESH_MARGIN_MS` 是 24 小时。令牌因此永远落在刷新窗口内，`isCloudMcpSyncMarkerFresh` 短路从不生效，每次维护都退化为一次网络健康探测。今天只探测一条，改成每工作区一条后就是 N 条。服务端把 TTL 调到 **6 天**后这个短路才真正开始工作，24 小时余量也才有意义。

不是 7 天：令牌由会话背书，服务端校验要求 MCP 令牌 TTL 严格短于会话 TTL（默认同为 7 天），写 7 天会直接启动失败。

**重铸即轮换。** 服务端把铸造从 INSERT 改为按 `(会话, 组织, workspaceKey)` upsert，并保留 60 秒宽限摘要。桌面这一侧因此**不需要**先撤销再铸造，也不需要担心「写配置 → POST 引擎」这段窗口里引擎拿旧令牌调用失败——旧摘要在 60 秒内仍然有效。

**分层复用现有机制，不新增循环：**

```
维护循环 (5 分钟一次 / online / focus / visibilitychange)
    │
    ▼
runSessionMcpMaintenanceSingleflight({ targetKey })
    │  targetKey 已按工作区分片 ── 同一工作区不会并发重铸
    ▼
repairCloudMcp
    ├─ 健康探测 usable ────────────────▶ unchanged，不铸造   ← 主短路
    ├─ 同步标记仍在刷新余量内 ─────────▶ unchanged，不铸造   ← TTL 修正后才生效
    └─ 否则 mintAndPost(workspaceKey)
           └─ 首次结果是鉴权类失败时重铸一次（既有 reminted 逻辑，保留）
```

**只维护「活跃」工作区。** 后台不为所有已知工作区轮询铸造，只覆盖当前打开会话所属的工作区。关闭很久的工作区令牌自然过期，下次打开时由第一轮维护重铸。这把铸造量与实际使用挂钩，而不是与工作区总数挂钩。

**目录令牌与执行令牌分离。** `connect-state.json` 的 host 级 `cloudMcp` 保留，但改为只承载 `workspaceKey` 为空的**目录令牌**，供 `readJuggleWorkConnectSkillCatalog` 做账号级技能目录读取。各工作区的执行令牌只存在于该工作区的 runtime 配置里。两者用途不同，不再互相提升（`readJuggleWorkConnectSkillCatalog` 把工作区副本提升为 server 级的逻辑已移除，否则会把某个工作区的执行令牌变成账号级目录令牌）。

目录令牌整个账号一枚，铸造节奏与执行令牌解耦：桌面用独立的到期标记
（`jugglework.den.mcp.catalogTokenMarker`）判断新鲜度，只在缺失或临近过期时随本轮
reconcile 一并铸造，并通过请求体的 `catalog.config` 交给 JuggleWork 服务端写入 host 级。
不带 `catalog` 的 reconcile 不动 host 级那一份。

**登出与切组织。** 服务端在每次 MCP 请求上实时校验会话与活跃组织，因此登出或切组织会让全部工作区令牌同时失效。桌面无需逐个清理，下一轮维护自然重铸；UI 上这批工作区会短暂显示「检查中」而非「失败」。

### 2.5 数据来源

```
连接器列表按「已连接 / 未连接」分组
    domains/connections/use-org-mcp-connections.ts + 市场插件
    → buildConnectRows：插件吸收它绑定的连接，同一条不出现两次

会话右侧 MCP 列表
    connectionsSnapshot.mcpServers
    → config.global（全局）+ config.project/config.remote（本工作区）
    → buildProjectConnectors：保留作用域并与可添加目录去重

行上的工作区开关
    GET /v1/mcp-connections/workspace-policy?workspaceKey=<key>
    → [{ connectionId, name, connectedForMe, enabled, toolCount }]
    按 connectionId 与行对齐；策略里没有的行不显示开关
```

两路独立拉取：策略失败只让开关消失并在列表顶部给一条错误，连接器列表本身照常展示。

---

## 3. 开关行为

### 3.1 普通工作区 MCP 的无重载软策略

工作区 runtime MCP 的开关只在 runtime SQLite 保存关闭的 `serverName`，不写 `enabled`、不停止 transport、也不触发 OpenCode 重载。下一轮 prompt 通过 `tools=false` 隐藏对应工具，常驻 `tool.execute.before` 插件在真正调用前再按最新策略拦截。全局 MCP 在会话列表中只读，只能在个人设置的全局连接器页修改。已连接 Cloud MCP 的工作区开关仍使用服务端 capability 过滤，同样不触发引擎重载。

普通 MCP 软策略目前只在本机受管 OpenCode 上展示：服务端与常驻 plugin 能共同证明目录过滤和执行拦截均可用。远程/外部 OpenCode 在完成版本化 plugin 握手之前隐藏该开关，避免界面显示“已关闭”而远程执行仍可绕过。`config.project` 与 `config.remote` 都使用同一软策略；历史 `config.remote.enabled=false` 会幂等迁移为软策略关闭项并恢复 transport 配置。

| | 生效时机 | UI 处理 |
| --- | --- | --- |
| 当前工作区 MCP 行上的开关 | 下一轮模型请求 | 乐观更新，请求失败才回滚；不显示重载提示 |
| 已连接 Cloud MCP 行上的工作区开关 | 下一次搜索（立即） | 乐观更新，请求失败才回滚 |

### 3.2 Cloud MCP 连接

```
拨动开关
    │
    ▼
PUT /v1/mcp-connections/workspace-policy
    { workspaceKey, disabledConnectionIds: [...] }        ← 全量替换，避免竞态
    │
    ▼
服务端 workspace_policy 落库
    │
    ▼
下一次 search_capabilities 即刻生效
    （轨道内部过滤，不依赖桌面本地过滤）
```

写入是**全量替换**（提交整个关闭集合）而不是逐条 PATCH：连续拨动多个开关时，逐条写入会因请求乱序产生错误终态，全量替换的最后一次提交总是对的。

### 3.3 边界

- 关闭最后一条 Cloud MCP 时**不**额外提示。成员知道自己在做什么，确认对话框只会拖慢反复调整的场景。
- 尚未授权的连接**不给开关**，给「连接」按钮：这一行此刻要解决的是授权，一个此时拨动也看不出效果的开关只会分散注意。授权完成后它变成已连接行，开关随之出现，默认开启。
- 关掉的连接在搜索里是一条 `disabled_in_workspace` 伪匹配，而不是静默消失（服务端文档 §A.4）。成员自己关掉的东西如果表现为「搜不到」，用户只会以为授权坏了。

---

## 4. 与提示词的关系

这项改动不改变提示词注入逻辑，但改变它描述的事实。三处需要同步：

**① steering 的连接列表**
`jugglework-extensions-preview-steering.ts` 注入的 `JUGGLEWORK_CLOUD_CONNECTION_INSTRUCTION` 目前不枚举具体连接。工作区关闭一部分连接后，模型仍可能按用户提到的服务名去搜。服务端的过滤会让它搜不到——**这正是需要 `needs_connection` 伪匹配的场景**（见迁移文档批 2）。在那之前，搜索为空的兜底文案需补一句：该连接可能已在本工作区关闭，可在设置 › 连接器中开启。

**② `search_capabilities` 入参**
steering 文案中「只接受 query 与 limit」在服务端批 2 加入 `type` 参数后必须同步修改，否则模型被反向误导。此处与本文改动无关，但同属一次发布，一并核对。

**③ 开关与 `available_skills` 的一致性**
`connect-skill-catalog.ts` 注入的远程技能来自云端 `skill://index.json`，不经过工作区策略。关闭一条 Cloud MCP 不会让它关联的技能从 `available_skills` 消失——**这是当前的已知不一致**，待服务端在技能索引上同样应用工作区策略后消除。

---

## 5. 升级、删除与兼容

服务端与桌面独立发布，**服务端先行**。

| 服务端 | 桌面 | 行为 |
| --- | --- | --- |
| 新 | 新 | 完整能力 |
| 新 | 旧 | 旧桌面不带 `workspaceKey`，落空值，不参与工作区策略；与升级前逐字节一致 |
| 旧 | 新 | `/v1/mcp-connections/workspace-policy` 返回 404 → **只隐藏开关**，已连接的行退回「就绪」标签，连接器列表与连接/断开动作照常 |
| 旧 | 旧 | 不变 |

404 降级必须只针对开关：连接器页的其余部分不依赖服务端新路由，没有理由被一起禁用。

**明确删除：**

| 删除项 | 位置 | 理由 |
| --- | --- | --- |
| 工作区副本提升为 server 级的逻辑 | `connect-skill-catalog.ts` `readJuggleWorkConnectSkillCatalog` | 会把某个工作区的执行令牌变成账号级目录令牌，与令牌分层冲突 |
| host 级 `cloudMcp` 作为执行配置来源的回退路径 | `connect-cloud-mcp-rpc.ts`、`connect-state.ts` | 执行令牌此后只从工作区 runtime 配置读；host 级仅保留目录令牌 |

**不删除**：`cloud-mcp-health.ts` 的 desired / applied revision 比对与投递状态机。它按工作区已经是分片的，per-workspace 令牌正好落在同一套结构里。

**回滚**：桌面回滚到旧版本时，工作区 runtime 配置里多出的 `jugglework.workspaceKey` 字段被旧代码忽略；已铸造的带工作区令牌照常可用（旧桌面不读策略，服务端按令牌里的 `workspaceKey` 过滤——**这意味着回滚后关掉的连接仍然是关的**）。若需要彻底还原，在回滚前于连接器页把全部开关打开，或由服务端 `DELETE /v1/mcp-connections/workspace-policy` 清空。此行为需写进发布说明。

---

## 6. 落点

| 文件 | 改动 |
| --- | --- |
| `apps/server/src/workspace-key.ts` | **新增**，`installId` 与 `workspaceKey` 的派生和持久化 |
| `apps/server/src/routes/cloud-mcp.ts` | **新增** `GET /workspace/:id/mcp/jugglework-cloud/workspace-key` |
| `apps/server/src/cloud-mcp-health.ts` | `persistDesiredConfig` 不再把工作区副本提升为 host 级；host 级只由请求体的 `catalog.config` 写入 |
| `apps/server/src/connect-cloud-mcp-rpc.ts` | `listCloudMcpCandidates` 只返回 host 级目录配置 |
| `apps/server/src/connect-skill-catalog.ts` | 移除工作区副本提升为 server 级的逻辑 |
| `apps/server/src/mcp.ts` | `addMcp` 新增 `preserveEnabled`：投递不覆盖成员自己拨过的开关 |
| `apps/server/src/cloud-plugins.ts` | 插件 MCP 组件投递改用 `preserveEnabled` |
| `apps/server/src/opencode-plugins/jugglework-extensions-preview-steering.ts` | 补 `disabled_in_workspace` 伪匹配与搜索为空的工作区开关提示 |
| `app/lib/den.ts` | `mintMcpToken` 支持 `workspaceKey`；新增 `getMcpWorkspacePolicy` / `replaceMcpWorkspacePolicy` / `clearMcpWorkspacePolicy` |
| `app/lib/jugglework-server.ts` | 新增 `getCloudMcpWorkspaceKey`；reconcile 请求体新增 `catalog` |
| `domains/connections/workspace-mcp-key.ts` | **新增**，workspaceKey 读取与进程内缓存（404 即降级） |
| `domains/connections/use-workspace-mcp-policy.ts` | **新增**，工作区策略拉取与全量替换提交 |
| `domains/connections/cloud-mcp-reconciler.ts` | 统一解析 workspaceKey；执行令牌带键铸造，目录令牌按标记按需铸造 |
| `domains/connections/cloud-mcp-user-state.ts` | **新增**目录令牌到期标记 |
| `domains/settings/connect-workspace-scope.ts` | **新增**，连接器行到策略条目的纯映射 |
| `domains/settings/pages/connect-view.tsx` | 两列列表、不再只显示已连接行、已连接行的工作区开关 |
| `domains/settings/shell/settings-page.tsx` | 个人设置不展示工作区分组；全局分组保留只管理全局 MCP 的「连接器」入口 |
| `domains/settings/pages/project-extensions/connector-picker-modal.tsx` | 会话右侧「连接器」以一套已连接/未连接列表展示 MCP，并在已连接 Cloud MCP 行显示工作区开关 |
| `shell/settings-route.tsx` | 将 Cloud MCP 连接合并到当前会话 MCP 列表，并按 connectionId 叠加当前工作区策略 |

---

## 7. 添加 MCP 表单的对齐

本地 MCP 的添加表单仍是 `domains/connections/modals/add-mcp-modal.tsx`（设置 › 扩展），本文改动不涉及。

服务端控制台的插件 MCP 编排表单以此为样式基线（服务端文档 §B.5），两边保持一致的：分段切换位置、类型分段、键值对表格、OAuth 折叠区、占位符清空提示、JSON 占位示例。

一处**有意的不一致**需记录：桌面在 JSON 模式下禁用提交，强制先「解析到表单」；控制台因引入 `preservedExtras`（表单无法表达的字段原样保留）而允许两页均可直接提交。桌面是否跟进这一模型，待控制台侧稳定后再评估——桌面的约束更严，是因为本地 MCP 配置错误会以运行时静默失败的形式暴露，而控制台的配置在下发前还有一道服务端校验。

---

## 8. 验收

1. 设置 › 连接器以两列展示全部连接器，已连接、待授权、待管理员配置在同一张列表里，已连接的行带开关。
2. 关闭已连接 MCP 行上的 Notion 工作区开关后，同一会话内下一次提问，模型的 `search_capabilities` 搜不到 Notion 工具；切到另一个工作区的会话仍能搜到。
3. 关闭的行在描述行显示「本工作区已关闭」，重开后立即消失。
4. 绑定多条连接的插件行，一次拨动同时开关它的全部连接。
5. 待授权的行显示「连接」而不是开关；授权完成后变为已连接行并出现开关，默认开启。
6. 断网时开关消失并在列表顶部给出错误，连接器列表本身仍在；恢复后自动刷新。
7. 同时打开 5 个工作区运行 30 分钟：服务端令牌行数稳定为 5，不随时间增长；健康探测命中短路，期间没有重复铸造。
8. 触发一次重铸后立即在该工作区发消息，引擎不出现一次 401——旧令牌处于 60 秒宽限窗口内。
9. 关闭某工作区一小时后重新打开，第一轮维护完成即可用，无需手动重连。
10. 登出再登入，5 个工作区依次恢复，UI 显示「检查中」而非「失败」。
11. 旧服务端上运行新桌面：开关不出现，已连接的行退回「就绪」标签，连接/断开照常可用。
12. 会话右侧「连接器」同时显示 `config.global` 全局 MCP、当前工作区的 `config.project` / `config.remote` MCP 和 Cloud MCP，不显示其他工作区专属项；行上分别标明作用域。
13. 会话右侧不出现「组织连接」页签；已授权 Cloud MCP 位于「已连接」，工作区开关直接显示在该 MCP 行上。
14. 会话右侧的全局 MCP 为只读状态，不得调用工作区启停、删除或编辑接口制造同名工作区覆盖。
15. 会话右侧「连接器」使用宽弹窗和响应式两列：统一 MCP 列表在足够宽时按两列完整展示，窗口高度不足时列表区域独立滚动，不得被弹窗裁切。
