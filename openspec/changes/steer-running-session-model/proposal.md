## Why

当前用户可以在会话任务运行中切换模型，但桌面端只更新本地的会话模型选择，正在运行的 OpenCode 会话不会收到新的模型指令。因此界面可能已经显示 `glm-5.3`，而后续工具回合与模型请求仍继续使用任务开始时最近一条用户消息记录的 `gpt-5.6-sol`，造成能力、成本与实际执行证据不一致。

OpenCode 1.18.15 的运行循环会在每个模型回合重新读取最新用户消息的模型，且 busy 会话接受 `prompt_async` 注入而不会启动并发运行循环。JuggleWork 可以利用该既有语义，在不 fork 引擎的前提下，让运行中的模型切换从下一个尚未开始的模型请求起生效。

## What Changes

- 新增会话模型转向（model steer）操作：当目标会话正在运行时，Server 向同一 OpenCode 会话注入一条携带新 provider/model/variant 的内部继续消息，使当前请求完成后、下一个模型请求改用新模型
- 桌面端的所有会话级模型选择入口统一在后台调用模型转向操作；会话空闲时保持现有“下一次发送生效”行为，运行中从下一个尚未开始的模型请求起透明应用
- 模型转向失败时保留用户的新模型选择并静默降级为“下一次用户发送生效”，不新增弹窗、状态、提示或错误打断
- 保持现有模型选择器和会话头部展示不变；不区分或展示“已选择模型”“待生效模型”和“当前实际执行模型”
- 将内部继续消息从普通用户 transcript、复制和导出中隐藏，但保留在引擎上下文与底层审计数据中，以维持任务连续性和可诊断性
- 增加竞态、分屏、多次快速切换、无效模型、运行结束边界、variant/reasoning 配置及 OpenCode 升级兼容的测试覆盖

## Capabilities

### New Capabilities

- `running-session-model-steering`: 规定运行中会话如何在不改变现有 UI 的前提下接受模型转向、从下一模型回合应用新模型并静默安全降级

### Modified Capabilities

（无）

## Impact

- Server API 与执行协调：`apps/server/src/routes/sessions.ts`、`apps/server/src/server.ts`、JuggleWork Server 客户端类型与对应路由/集成测试
- 桌面会话模型状态与选择入口：`apps/app/src/react-app/shell/session-route.tsx`、会话 client 接口与 model-steer 后台协调
- 会话 transcript 适配：内部继续消息过滤、任务分组及复制/导出边界；不新增实际模型或 pending 状态展示
- 依赖 OpenCode 1.18.15 的既有契约：`prompt_async` 在 busy 时持久化用户消息；运行循环逐轮读取 `lastUser.model`；同会话运行通过 `ensureRunning` 合并而非并发。无需修改或 fork OpenCode，但升级 sidecar 时必须通过兼容回归测试
- 非破坏性 API 增量；不改变空闲会话下一次发送模型、子代理自身模型配置或已在途 provider 请求的模型
