# Change: 新本地工作区冷启动提速

## Why

新打开本地工作区后，状态栏长时间停在 Checking，会话模型列表一开始为空，首个会话创建偏慢。在隔离的 dev 环境实测（新建空工作区，已登录，单次采样）：

- 云 provider 同步每个 provider 各做一次引擎 dispose，最后再做一次，共 7 次；每次配置变更约 1.5 秒后又触发一次自动重载，共 4 次 `engine/reload`，每次约 2 秒。同步总时长约 22 秒，模型列表要等同步整轮结束才出现。
- MCP 维护在每次重载期间被打断并重跑，状态栏 Checking 时间被放大。
- `reconcile` 成功路径对同一份状态做两次完整健康探测。
- 引擎进程启动后第一次初始化任何目录要 8 到 16 秒（单线程 JS 占 CPU，与登录、云和 MCP 无关），此前要等用户创建工作区时才触发，并与云同步、MCP 注册同时打到同一个正在初始化的目录，造成 10 秒超时和整轮同步重试。

## What Changes

- 云 provider 同步：循环内只写配置，循环结束后统一做一次引擎 dispose；同步中途失败时补一个重载标记，避免引擎一直使用旧配置。
- `reconcile` 成功后直接复用第一次健康探测的结果，只用最新的投递状态覆盖 `delivery`。
- 引擎预热：受信任的托管引擎启动后，后台对启动目录发一次只读 `GET /config`；创建或激活本地工作区时对该工作区做同样的预热。同目录并发合并为一次，60 秒内不重复，引擎 dispose 后失效，失败不缓存。

## Impact

- Affected specs: cloud-provider-import, server-owned-runtime
- Affected code: `apps/app` 云 provider 同步与 MCP 维护，`apps/server` 的 `server.ts`、`embedded.ts`、`routes/workspaces.ts`、`cloud-mcp-health.ts`、`workspace-engine-warmup.ts`。计时埋点和对照测量开关只用于测量，没有随本变更提交。
- 不涉及数据迁移、HTTP 接口形状或授权合同。预热只发只读请求，不会 dispose 引擎，也不会中止运行中的任务。

## Status

实现并通过单元与 e2e 测试。实测对比见 `docs/workspace-cold-start-analysis.md`（工作区根目录）。

已测量：合并 dispose 后同步耗时约 22 秒降到约 3 秒；已登录新建工作区时，模型列表可用约 3.3 秒，首次 `inventory` 不再超时。

未证实：启动预热本身的收益。已登录且配置过云 MCP 的环境里，启动时的 MCP 同步本来就会触发引擎首次初始化，所以对这类用户启动预热可能是重复的。关闭预热的对照轮次受机器负载干扰（引擎首次初始化 8.8 到 24.5 秒波动），没有得到有效的 A/B 数据。`session.create` 与 `activateWorkspace` 的耗时只有旁证。
