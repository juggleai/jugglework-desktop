## 1. 类型与判定核心

- [x] 1.1 `app/lib/den-types.ts` 为 `DenPluginCloudReadiness` 增加可选 `components: Array<{ configObjectId; serverName; delivery: "cloud" | "desktop"; url?; command?; connectionId?; credentialMode?; connectedForMe? }>`
- [x] 1.2 `app/lib/den.ts` 的 `parsePluginCloudReadiness` 解析 `components`，单条非法只丢该条，不影响整份 readiness；`state` 白名单保持不变
- [x] 1.3 `connect-cloud-readiness.ts` 新增 `resolvePluginMcpComponents(plugin, resolved?)`：优先取 `cloudReadiness.components`，缺失时用配置对象 payload（`mcp` / `mcpServers` 双键名）推断 `delivery`
- [x] 1.4 同文件新增 `aggregatePluginDelivery(components, installedFiles)`：产出 `{ kind: "cloud" | "desktop" | "mixed"; weakest: "ready" | "needs_signin" | "needs_admin_setup" | "not_installed"; cloudCount; desktopCount }`
- [x] 1.5 为 1.3 / 1.4 写单测：纯 remote、纯 local、混合、无 components 回退、payload 键名为 `mcp` 与 `mcpServers` 两种

## 2. 卡片与详情展示

- [x] 2.1 `connect-delivery.ts` 的 `resolveMarketplaceDeliveryAction` 改为接收聚合结果，返回 `cloud_active` / `desktop_install_required` / `mixed_partial_desktop` / `cloud_active_local_copy`
- [x] 2.2 `cloud-marketplaces-view.tsx` 的 `MarketplaceCard` 用聚合结果决定 `connected` 与 `connectedLabel`，去掉恒为 `true` 的硬编码
- [x] 2.3 卡片副标题追加组成明细 `N MCP · X 云端 · Y 需本地`，仅在含 MCP 组件时展示
- [x] 2.4 `MarketplacePackageDetailModal` 增加组件清单区块：逐行显示 server 名、承载位置、就绪状态
- [x] 2.5 组件行绑定操作：`desktop` 未安装 → 安装入口，已装标「已安装」；`cloud` 未授权 → 定向授权入口（用服务端下发的 `connectionId`），已授权标「已授权」
- [x] 2.6 i18n（zh/en）新增：需在桌面端安装、部分需在桌面端安装、组成明细、组件行的承载位置与状态文案

## 3. 会话侧口径复用

- [x] 3.1 `connect-capability-inventory.ts` 的 `toMcpEntries` 改为消费 1.3 的判定结果，`remoteMcpSpecs` 仅作为回退推断路径
- [x] 3.2 校验 `mergeConnectLocalMcpServers` 与新判定的一致性：`desktop` 未安装 → `not_installed`，已安装 → 并入本地条目
- [x] 3.3 补测：同一插件内 `cloud` + `desktop` 组件同时存在时，两条状态互不污染

## 4. 安装分流

- [x] 4.1 `apps/server/src/cloud-plugins.ts` 的 `pluginMcpConfigsFromPayload` 增加 transport 判定，`cloud` 组件不产出本地配置
- [x] 4.2 导入链路只为落盘组件写 `files` 记录；`cloud` 组件不写文件条目
- [x] 4.3 卸载/更新链路移除"每个 mcp 组件必有本地文件"的假设（`cloudPluginMcpNameFromPath` 两处分支）
- [x] 4.4 补测：安装混合插件只落地 `desktop` 组件；卸载该插件不因缺失文件失败

## 5. 验证与收尾

- [x] 5.1 `apps/app` 与 `apps/server` 双 `tsc --noEmit` 通过
- [x] 5.2 `apps/app` 与 `apps/server` 相关测试通过
- [x] 5.3 用本地组织 `org_jugglework` 的「插件1」实测：服务端已返回 `desktop_only` + 一条 desktop 明细，桌面端据此展示
- [x] 5.4 混合插件实测：`vision-plugin`（vision=stdio + gmail=remote）在渲染进程里跑通判定链路，聚合为 mixed(1 云端/1 需本地)、投递表述为 `mixed_partial_desktop`
