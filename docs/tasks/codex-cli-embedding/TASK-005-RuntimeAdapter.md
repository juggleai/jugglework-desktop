# TASK-005：双运行时 Adapter 与安全 IPC

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [REFACTOR] |
| 职责层 | 跨运行时核心框架层 |
| 所属模块 | MOD-005 Runtime Adapter、事件标准化与安全 IPC |
| 状态 | DONE |
| 依赖任务 | TASK-002、TASK-004 |
| 解锁任务 | TASK-006、TASK-007、TASK-008 |
| 预计工作量 | 16–20 小时 |

## 任务描述

用统一 Runtime Adapter 封装现有 OpenCode HTTP/SSE 和 Codex App Server JSON-RPC，使 Renderer 会话链路不再直接依赖任一后端协议。事件排序、去重、能力协商、作用域校验和统一错误在同一切片内完成并通过双后端 fixture 验证。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/desktop/electron/agent-runtime-service.mjs` | `createAgentRuntimeService` | 创建 | Main 侧运行时注册、路由和作用域校验 |
| `apps/desktop/electron/codex-runtime-adapter.mjs` | `createCodexRuntimeAdapter` | 创建 | Codex RPC 到统一事件映射 |
| `apps/desktop/electron/runtime-ipc.mjs` | runtime handlers | 修改 | 增加 typed runtime 操作与 allowlist |
| `apps/desktop/electron/preload.mjs` | runtime bridge | 修改 | 暴露最小安全 IPC |
| `apps/app/src/react-app/domains/session/sync/agent-runtime-client.ts` | `AgentRuntimeClient` | 创建 | Renderer 后端无关客户端 |
| `apps/app/src/react-app/domains/session/sync/opencode-runtime-adapter.ts` | `OpenCodeRuntimeAdapter` | 创建 | 包装现有 SDK 行为 |
| `apps/app/src/react-app/domains/session/sync/runtime-sync.tsx` | `ReactSessionRuntime` | 后移至 TASK-007 | 在权威映射完成后迁移主订阅链路 |
| `apps/desktop/electron/runtime-ipc.test.mjs` | IPC 测试 | 修改 | 越权、unknown runtime、DTO 校验 |
| `apps/desktop/electron/codex-runtime-adapter.test.mjs` | fixture tests | 创建 | Codex 事件映射与错误测试 |

## 上下文与约束

**架构引用**：架构文档 §4、§9、§11；公共类型来自 `packages/types/src/agent-runtime.ts`。

**层间契约**：实现 TASK-002 的 `AgentRuntimeContract`，支持 start/stop workspace、create/resume/archive thread、send/steer/interrupt turn、approval response 和 subscribe。

**技术约束**：

- Adapter 原始 metadata 只能进入受控诊断，UI 不得依赖。
- 所有操作校验 `orgId + workspaceId + sessionId/threadId` 作用域。
- 先完成 OpenCode Adapter 并建立行为基线，再接 Codex Adapter。
- unknown notification 被记录并忽略，不能导致订阅或 Renderer 崩溃。

## Done Definition

- [x] OpenCode 与 Codex 均通过同一 `AgentRuntimeContract` 完成 create/resume/send/interrupt/approve/archive。
- [x] Renderer 使用后端无关 `AgentRuntimeClient`；主链路替换在 TASK-006 权威映射完成后由 TASK-007 验收，避免临时内存映射导致恢复错绑。
- [x] 两套 Adapter fixture 覆盖 delta、重复/乱序、未知事件、审批、终态和错误标准化。
- [x] IPC 拒绝无效 DTO、未知 runtime、远端 Codex 和跨 org/workspace/session 的调用。
- [x] capabilities 统一承载 images、MCP、Skills、approvals、steering、reasoning，Renderer 不接触后端原始协议。
- [x] OpenCode/Codex Adapter 与现有 Electron 回归测试通过。
- [x] App/Desktop typecheck、Codex tests 和 `git diff --check` 通过。

## 执行快照

**中断时间**：  
**已完成文件**：TASK-002 公共契约、TASK-004 Main 进程与 App Server 客户端；`agent-runtime-service.mjs` 严格作用域路由；`codex-runtime-adapter.mjs` 锁定 v0.147.0 协议映射及 fixture tests；typed runtime IPC/preload；Renderer `AgentRuntimeClient`；OpenCode SDK Adapter 基线。  
**未完成文件**：无；`actions-store.ts` / `runtime-sync.tsx` 的产品主链路迁移按依赖调整到 TASK-007。  
**当前卡点**：无。  
**下一步行动**：进入 TASK-006，先建立 `sessionId ↔ backendThreadId` 权威映射和事件账本。  
**关键决策记录**：Codex Adapter 只通过 TASK-004 `CodexProcessManager` 获取 App Server；Renderer 不接触 JSON-RPC 客户端；通知映射以本地锁定版 schema 为准，未知 payload 仅输出无原文诊断。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 15:08 +08:00 | 完成 TASK-005 第一段 | Main runtime service、Codex Adapter、fixtures | 新增 | 为安全 IPC 和 Renderer 迁移建立入口；Codex/Runtime 39/39 |
| v2 | 2026-08-12 15:18 +08:00 | 完成统一桥接骨架 | typed IPC/preload、AgentRuntimeClient、OpenCode Adapter | 新增/修改 | Desktop/App typecheck 通过；OpenCode Node fixture 1/1 |
| v3 | 2026-08-12 16:02 +08:00 | 完成双 Adapter 事件与安全路由 | OpenCode event mapper、双 fixture、scope/order/dedupe | 新增/修改 | Codex 40/40；OpenCode 2/2；主链路迁移在 TASK-007 完成 |
