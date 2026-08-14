## Why

市场插件的「已启用 · 在云端运行」徽标是写死的：`connect-delivery.ts` 只看 `importedLocally`，`cloud-marketplaces-view.tsx:821` 还把 `connected` 恒设为 `true`。真实判据在 MCP 组件创建时就已确定——webconsole 的 `McpTransport = "remote" | "local"`（remote 走 HTTPS 端点、local 在桌面端拉子进程），落库为配置对象 `normalizedPayloadJson.mcp.<serverName>.type`——但桌面端从未消费它。

后果（实测于本地组织 `org_jugglework`）：插件「插件1」只含一个 `type: "local"` 的 stdio MCP（`npx -y jugglework-vision-mcp`），仍显示「已启用 · 在云端运行」；而它在没装到工作区之前根本不可用。一个插件包含多个 MCP（例如 GitHub 这类 remote + vision 这类 local）时，单一二元徽标无法表达"一半云端一半需本地"，用户无法判断插件到底能不能用。

## What Changes

- **投递方式下沉到组件粒度**：桌面端按每个 MCP 组件的 transport 判定承载位置（`cloud` / `desktop`），不再对整个插件做二元判断。
- **插件层按"最弱环节"聚合**：全 remote → 云端运行；全 local → 需在桌面端安装；混合 → 部分需在桌面端安装。徽标颜色与文案取最弱那一环，卡片副标题给出组成明细（如 `2 MCP · 1 云端 · 1 需本地`）。
- **插件详情按组件展开**：逐行列出每个 MCP 的承载位置与就绪状态，操作入口跟着行走（云端待授权 → 去授权；桌面端未安装 → 安装到工作区），取代整插件一个按钮。
- **导入按 transport 分流**：`installPlugin` 只把 `desktop` 组件写进工作区 opencode 配置，`cloud` 组件继续走云端网关；卸载与安装记录不再假设每个 MCP 组件都有本地文件。
- **消费服务端新增的 `cloudReadiness.components`**：有该字段时以它为准；缺失时回退到已解析的配置对象 payload 自行推断，保证旧服务端下行为不退化。
- **BREAKING**: 无。`cloudReadiness.components` 为新增可选字段；已导入插件的本地文件记录格式不变，仅新安装的 `cloud` 组件不再落地本地配置。

## Capabilities

### New Capabilities

- `plugin-mcp-delivery`: MCP 组件投递方式的判定与聚合、插件卡片与详情的展示契约、会话 MCP 列表的状态口径、以及安装时按 transport 分流的落盘规则。

### Modified Capabilities

无。会话右侧扩展面板的规格仍在 `openspec/changes/2026-08-06-redesign-session-extensions-panel` 内未归档，本变更只在其渲染层追加投递方式展示，不改动其既有要求。

## Impact

- 受影响代码：
  - `apps/app/src/react-app/domains/settings/connect-delivery.ts`：`resolveMarketplaceDeliveryAction` 从"是否有本地副本"改为按组件投递方式聚合。
  - `apps/app/src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx`：卡片 `connected` / `connectedLabel` 改为聚合结果，副标题追加组成明细；详情弹窗按组件展开。
  - `apps/app/src/react-app/domains/settings/connect-cloud-readiness.ts`：新增组件级投递与就绪度的解析与聚合函数。
  - `apps/app/src/app/lib/den.ts` / `den-types.ts`：`DenPluginCloudReadiness` 增加可选 `components`，解析器对未知字段保持宽容。
  - `apps/app/src/react-app/domains/session/surface/connect-capability-inventory.ts`：`remoteMcpSpecs` 已识别 `mcp` / `mcpServers` 双格式，改为优先采用服务端下发的 components。
  - `apps/server/src/cloud-plugins.ts`：`pluginMcpConfigsFromPayload` 与导入/卸载链路按 transport 分流。
- 受影响服务端契约：依赖 jugglework-server 新增 `cloudReadiness.components`（见该仓库 `openspec/changes/add-plugin-mcp-delivery-readiness`）；缺失时桌面端自行推断。
- i18n：新增「需在桌面端安装」「部分需在桌面端安装」及组成明细文案。
- 无数据迁移；无新增依赖。
