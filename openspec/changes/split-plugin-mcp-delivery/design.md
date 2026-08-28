## Context

现状三处事实：

1. **徽标写死**：`connect-delivery.ts` 的 `resolveMarketplaceDeliveryAction({ importedLocally })` 只返回 `cloud_active` / `cloud_active_local_copy`；`cloud-marketplaces-view.tsx:821` 的卡片把 `connected` 恒设 `true`，文案取 `extensions.marketplace_active_cloud_label`（「已启用 · 在云端运行」）。任何市场插件都会这样显示。
2. **就绪度字段永不到达**：`DenPluginCloudReadiness` 的四个状态分支（`ready` / `needs_signin` / `needs_admin_setup` / `desktop_only`）在当前部署里全是死代码——jugglework-server 的 `apis/distribution.go` 不序列化 `cloudReadiness`，`apis/cloud_contract_test.go:120` 与 `integration/phase_b_test.go:727` 明确断言不得输出无法验证的该字段。
3. **真实判据已存在但未被消费**：webconsole `mcp-component-payload.ts` 的 `McpTransport = "remote" | "local"` 在创建 MCP 组件时就已确定，落库为 `normalizedPayloadJson.mcp.<serverName>.type`。桌面端 `connect-capability-inventory.ts` 的 `remoteMcpSpecs` 已能解析该 payload（含 `mcp` / `mcpServers` 双键名与 `command`），但插件卡片链路没用上。

同时，`apps/server/src/cloud-plugins.ts:620` 的导入逻辑对每个 `objectType === "mcp"` 组件一律 `addMcp`，不区分 transport：混合插件安装后，remote 组件也会落一份本地配置、改为本地直连，组织统一凭据退化成各机器各自持有。

约束：`parsePluginCloudReadiness`（`den.ts:1881`）对未知 `state` 值是**整份 readiness 丢弃**，未知的额外字段则安全忽略。因此服务端只能在既有 `state` 枚举内取值，明细必须走新增字段。

## Goals / Non-Goals

**Goals:**

- 投递方式与就绪状态在**组件粒度**成为一等概念，插件层只做聚合展示。
- 混合插件（remote + local）能被准确表达：整插件"最弱环节"徽标 + 组件级明细与操作入口。
- 桌面端在服务端尚未下发 `components` 时行为不退化（自行推断，展示一致）。
- 安装只落地真正需要本地承载的组件。

**Non-Goals:**

- 不改动 `cloudReadiness.state` 的枚举集合（新增值会让旧客户端整份丢弃）。
- 不新增桌面端到 SkillHub / 组织连接的新鉴权链路，授权仍复用现有 org MCP 连接流程。
- 不处理 skill / command / agent 组件的投递差异——它们是指令类内容，本变更只覆盖 MCP。
- 不改动会话 MCP 列表的既有去重与状态逻辑（已在 `mergeConnectLocalMcpServers` 落地），只让它复用同一份组件判定。

## Decisions

**D1：投递方式以服务端 `components` 为准，payload 推断作为回退。**
服务端最了解全部配置对象，且能一并给出连接绑定与授权态；但桌面端必须能独立工作（旧服务端、私有部署未升级）。因此定义单一判定函数，输入优先取 `cloudReadiness.components[]`，缺失时用 `remoteMcpSpecs()` 的解析结果推断。
备选：只做桌面端推断——放弃了服务端已有的连接绑定/授权信息，`cloud` 组件无法区分「需登录」与「需管理员配置」；只信服务端——旧部署直接退回今天的错误展示。

**D2：聚合规则取"最弱环节"，不引入 `mixed` 状态值。**
插件层聚合出三种展示：全 `cloud` → 在云端运行；全 `desktop` → 需在桌面端安装；混合 → 部分需在桌面端安装。其中"混合"是**桌面端展示层概念**，`cloudReadiness.state` 仍落在既有枚举（含 local 时给 `desktop_only`），保证旧客户端至少显示「需桌面端」而不是丢弃整份 readiness。
备选：服务端新增 `state: "mixed"`——被 D1 约束否决。

**D3：卡片给聚合 + 明细，组件级操作只在详情里。**
卡片空间有限且是列表密度敏感位置，因此卡片只承载「聚合徽标 + `N MCP · X 云端 · Y 需本地`」；授权、安装这类需要目标明确的动作放进详情的组件行。
备选：卡片直接放多个按钮——列表里出现多个歧义按钮，且插件含 3+ 组件时无法排布。

**D4：导入按 transport 分流，且分流以插件来源为条件（实施阶段修正）。**
实施时发现 `installCloudPlugin` 同时服务两类来源：组织云端插件（远程组件有 Connect 网关兜底）与
GitHub 导入的 Claude plugin bundle（没有任何网关，远程 MCP 必须落本地才可用）。因此分流不能只看
transport，还要看来源：调用方通过 `cloudGatewayHosted` 显式声明，默认 false 保持 bundle 行为不变。
`pluginMcpConfigsFromPayload` 增加 transport 判定，只为 `desktop` 组件产出 `addMcp` 配置与 `files` 记录；`cloud` 组件不落盘。卸载/更新链路本就按 `files` 驱动，收窄集合后天然一致，但需去掉"每个 mcp 组件必有本地文件"的隐含假设（`cloud-plugins.ts:664`、`:721` 的 `cloudPluginMcpNameFromPath` 分支）。
备选：继续全量落盘——保留今天的凭据分散问题，且与会话列表的去重语义冲突。

**D5：文案与配色沿用既有状态色板。**
「在云端运行」= 就绪绿；「部分需在桌面端安装」/「需在桌面端安装」= 中性/提示色；未就绪（需登录、需管理员配置、未安装）= 琥珀；真实故障保留红色。避免为新概念引入新色。

**D6：会话能力 token 显式区分 `mcp` 与 `cloud-mcp`。**
`origin === "jugglework-connect" && config.type === "remote"` 的条目由 Cloud 网关承载，选择后必须先通过 `jugglework-cloud_search_capabilities` 搜索所需工具，再用搜索结果返回的完整名称调用 `jugglework-cloud_execute_capability`。其他已连接 MCP 沿用直接调用 `<server>_*` 工具的路径。Cloud 条目使用独立 `cloud-mcp` token，使草稿恢复或登记 prompt 丢失时仍能选择正确兜底，不把能力前缀误当成可执行工具名。

**D7：所有会话能力条目服从右侧内容列宽。**
弹层沿用现有默认宽度，右侧内容列显式禁止横向溢出。Agent、指令、技能、MCP、Extensions 与插件文件的行容器、正文列和标题行统一允许收缩；标题、描述、市场归属、URL 或命令以内容列可用宽度为边界保持单行并显示省略号，不允许长文本撑开弹层或产生横向滚动。完整值通过 `title` 保留，鼠标悬浮仍可查看。

## Risks / Trade-offs

- **旧服务端上的推断精度有限** → `cloud` 组件在缺 `components` 时无法区分「需登录」与「需管理员配置」，统一显示为待补齐；服务端升级后自动细化。
- **组件命名与本地 server 名不一致导致误判"未安装"** → 已有 `mergeConnectLocalMcpServers` 的双重匹配（server 名 + 启动命令逐项比对）兜底；仍改名且改命令的极端情况按未安装处理，属保守方向。
- **已安装插件的历史记录含 cloud 组件文件** → 分流只作用于新安装；卸载仍按已有 `files` 记录清理，不遗留。必要时在下一次"同步到工作区"时自然收敛。
- **混合插件的可用性表达仍是概括** → 用户要看具体哪一个组件缺什么，必须进详情；接受这一层跳转，换取列表可读性。
- **Cloud MCP 的 capability 前缀不是最终工具名** → 前缀仅作为搜索提示，执行阶段必须采用 `search_capabilities` 返回的完整名称，避免调用不存在的伪工具。

## Migration Plan

1. 桌面端先落地：判定函数 + 回退推断 + 卡片/详情展示 + 导入分流，行为在旧服务端下即已修正（不再谎称云端运行）。
2. jugglework-server 侧发布 `cloudReadiness.components`（见该仓库 `openspec/changes/add-plugin-mcp-delivery-readiness`）后，桌面端自动切换到服务端明细，无需再次发版。
3. 回滚：`components` 消费是可选路径，回滚桌面端改动即恢复旧展示；服务端新增字段对旧客户端无害（未知字段被忽略）。

## Open Questions

- 混合插件安装时，是否要在确认弹窗里明确"仅安装 N 个需本地运行的组件"？倾向要，但文案待定。
- `cloud` 组件已在历史安装记录中落盘的插件，是否需要一次性迁移清理（移除本地副本、改回网关）？本变更暂不做，需产品确认是否影响既有用户。
