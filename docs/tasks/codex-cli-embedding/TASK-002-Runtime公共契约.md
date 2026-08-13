# TASK-002：Runtime 公共契约与类型

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [IFACE] |
| 职责层 | 接口契约层 |
| 所属模块 | MOD-002 运行时领域模型与会话数据契约 |
| 状态 | DONE |
| 依赖任务 | TASK-001 |
| 解锁任务 | TASK-005、TASK-006 |
| 预计工作量 | 10–16 小时 |

## 任务描述

建立 OpenCode 与 Codex 共用的运行时、事件、内容、能力、错误和会话记录类型。契约同时供 Server、Desktop Main 和 Renderer 使用，任何公共 DTO 都不能泄漏 OpenCode SDK 类型或 Codex JSON-RPC 原始结构。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `packages/types/src/agent-runtime.ts` | `AgentRuntimeContract`、`RuntimeEvent`、`RuntimeCapabilities` | 创建 | 运行时公共类型与 schema |
| `packages/types/src/runtime-session.ts` | `RuntimeSessionRecord`、`RuntimeAttachmentRef` | 创建 | 会话、thread 映射和附件元数据 |
| `packages/types/src/index.ts` | 公共导出 | 修改 | 暴露新增类型 |
| `packages/types/package.json` | 子路径 exports | 修改 | 支持 Electron runtime 构建引用 |
| `packages/types/test/agent-runtime.test.ts` | schema fixtures | 创建 | 序列化、未知事件、校验测试 |
| `packages/types/test/runtime-session.test.ts` | migration fixtures | 创建 | 旧 OpenCode 数据兼容测试 |

## 上下文与约束

**架构引用**：架构文档 §4 Runtime Adapter、§5 会话模型、§11 统一错误。

**核心契约**：

```ts
type RuntimeKind = "opencode" | "codex";

interface AgentRuntimeContract {
  startWorkspace(input: StartWorkspaceInput): Promise<RuntimeWorkspace>;
  stopWorkspace(workspaceId: string): Promise<void>;
  createThread(input: CreateThreadInput): Promise<RuntimeThread>;
  resumeThread(input: ResumeThreadInput): Promise<RuntimeThread>;
  sendTurn(input: SendTurnInput): Promise<void>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  respondToApproval(input: ApprovalDecisionInput): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}
```

**技术约束**：

- 事件 schema 必须可版本化、可运行时校验并支持未知事件向前兼容。
- `RuntimeSessionRecord` 必须绑定 `orgId + workspaceId + runtimeKind`。
- `backendThreadId` 只作为运行时续跑指针，不是应用会话主键。
- 附件保存引用和元数据，不在 DTO 中持久化大体积 base64。

## Done Definition

- [x] 公共类型覆盖 thread、turn、文本、reasoning、工具、命令、文件变化、审批、usage、附件和终态。
- [x] capabilities 至少覆盖 images、MCP、Skills、approvals、steering 和 reasoning stream。
- [x] 统一错误码覆盖启动、协议、网关认证、模型、工作区权限、中断和崩溃。
- [x] 所有公共 DTO 不导入 `@opencode-ai/sdk`，也不暴露 Codex JSON-RPC method/event。
- [x] 旧 OpenCode 会话 fixture 可迁移为带稳定 JuggleWork Session ID 的新记录。
- [x] `@jugglework/types` 构建、typecheck、相关测试和 `git diff --check` 通过。

## 执行快照

**中断时间**：  
**已完成文件**：`agent-runtime.ts`、`runtime-session.ts`、公共导出/构建入口及 2 个测试文件。  
**未完成文件**：无。  
**当前卡点**：无。  
**下一步行动**：执行 TASK-003 组织 Token 与网关认证。  
**关键决策记录**：公共 DTO 只使用 JuggleWork 领域命名；未知事件解析为受控 `unknown` 诊断事件，不透传原始运行时 payload。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 14:02 +08:00 | 完成公共契约 | Runtime schema/interface、会话记录、附件引用和 OpenCode 迁移 | 新增公共接口 | TASK-005、TASK-006 |
