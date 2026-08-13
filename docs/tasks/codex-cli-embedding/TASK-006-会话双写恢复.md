# TASK-006：权威会话账本与双写恢复

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [FEATURE] |
| 职责层 | 会话数据与恢复层 |
| 所属模块 | MOD-006 权威会话账本、双写与恢复 |
| 状态 | DONE |
| 依赖任务 | TASK-002、TASK-005 |
| 解锁任务 | TASK-007 |
| 预计工作量 | 16–20 小时 |

## 任务描述

在现有 Runtime SQLite 和 session routes 上建立 JuggleWork 权威事件账本、运行时会话映射、幂等投影与恢复机制。Codex thread 仅作为续跑副本；异常退出、重复事件或 thread 丢失都不能覆盖或破坏 JuggleWork 历史。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/server/src/runtime-session-store.ts` | `RuntimeSessionStore` | 创建 | 会话映射、事件账本、投影和事务 |
| `apps/server/src/runtime-session-recovery.ts` | `reconcileRuntimeSession` | 创建 | 启动对账、未完成 turn 收敛、thread 重建 |
| `apps/server/src/runtime-db.ts` | DB 初始化 | 修改 | 注册会话账本 schema/migration |
| `apps/server/src/routes/sessions.ts` | 会话读写路由 | 修改 | 返回运行时无关 snapshot/messages |
| `apps/server/src/session-read-model.ts` | read model | 修改 | 从权威投影构建 UI 会话数据 |
| `apps/app/src/react-app/domains/session/sync/session-sync.ts` | sync projection | 修改 | 消费标准事件而非后端原始消息 |
| `apps/server/src/runtime-session-store.test.ts` | 存储测试 | 创建 | 幂等、事务、迁移、附件引用测试 |
| `apps/server/src/runtime-session-recovery.test.ts` | 恢复测试 | 创建 | crash、乱序、thread 丢失、跨组织测试 |

## 上下文与约束

**需求锚点**：架构文档 §5.1–§5.4、执行计划 MOD-006。

**数据契约**：

- session 主键为 JuggleWork Session ID。
- 后端幂等键为 `runtimeKind + backendThreadId + backendEventId`；无稳定后端 ID 时保存 Adapter 生成映射。
- 会话记录绑定 `orgId + workspaceId + runtimeKind + backendThreadId`。
- 图片只保存受控对象引用、MIME、size、hash、展示名，不保存 base64 正文。

**技术约束**：

- 事件必须逐条幂等落盘，UI 收到流事件不等于已经完成持久化。
- 读取、搜索、归档、同步和审计只使用 JuggleWork 投影。
- Codex thread 丢失时用规范历史/摘要新建 thread，不反向覆盖权威历史。

## Done Definition

- [x] schema/migration 可从现有 OpenCode 数据确定性无损升级，且拒绝高于当前支持版本的 schema。
- [x] 用户/助手消息、tool call/result、审批、文件摘要、usage 和 turn 终态按标准事件幂等落盘。
- [x] 重复、乱序、断流重连和串行化并发投递不会产生重复历史或非法终态。
- [x] 应用异常退出后可收敛未完成 turn；Codex thread 丢失可从权威记录建立新映射。
- [x] 任何读取或恢复都严格校验 org/workspace/session，跨组织历史和内联附件正文被拒绝。
- [x] 归档、恢复、搜索和附件展示可从 JuggleWork read model 工作，并提供 Main 私有 list/snapshot 查询。
- [x] Server/App/Desktop typecheck、数据库/会话/恢复测试、完整 Electron 回归和 `git diff --check` 通过。

## 执行快照

**中断时间**：  
**已完成文件**：`runtime-session-store.ts`、`runtime-session-recovery.ts`、版本化 SQLite schema、Host-only routes、Main ledger client、read model 与测试。  
**未完成文件**：无；Renderer 主链路消费在 TASK-007 完成。  
**当前卡点**：无。  
**下一步行动**：进入 TASK-007，将 `actions-store/session-sync` 接到统一 runtime 与权威 snapshot。  
**关键决策记录**：先持久化权威映射再迁移 Renderer 主链路，冷启动不依赖进程内 thread map。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 17:02 +08:00 | 完成权威账本与恢复闭环 | Server store/routes/read model、Main ledger client | 新增/修改 | 解锁 TASK-007；Node SQLite 7/7、Electron 400/1/0 |
