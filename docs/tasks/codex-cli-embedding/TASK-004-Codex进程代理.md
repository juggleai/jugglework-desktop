# TASK-004：Codex Sidecar 与 Credential Broker

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [INFRA] |
| 职责层 | Desktop Main 基础设施层 |
| 所属模块 | MOD-004 Codex Sidecar、App Server 与 Credential Broker |
| 状态 | DONE |
| 依赖任务 | TASK-001、TASK-003 |
| 解锁任务 | TASK-005、TASK-008、TASK-009 |
| 预计工作量 | 16–20 小时 |

## 任务描述

在 Electron Main 中完整托管 Codex 工作区进程、App Server RPC 和本地 Credential Broker。该切片必须形成登录、懒启动、Token 刷新、登出、组织切换、崩溃和应用退出的闭环，Renderer 只得到脱敏状态。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/desktop/electron/codex-app-server-client.mjs` | `createCodexAppServerClient` | 修改 | 将 Spike 客户端收敛为正式实现 |
| `apps/desktop/electron/codex-process-manager.mjs` | `createCodexProcessManager` | 创建 | 工作区级进程生命周期与隔离 `CODEX_HOME` |
| `apps/desktop/electron/codex-credential-broker.mjs` | `createCodexCredentialBroker` | 创建 | loopback Responses/SSE 代理与 Token 刷新 |
| `apps/desktop/electron/codex-runtime-config.mjs` | `writeCodexRuntimeConfig` | 创建 | 生成固定自定义 Provider、MCP/Skills 配置根 |
| `apps/desktop/electron/main.mjs` | 生命周期装配 | 修改 | 接入登录/登出/组织切换/退出 |
| `apps/desktop/electron/codex-process-manager.test.mjs` | 生命周期测试 | 创建 | 懒启动、崩溃、回收、隔离测试 |
| `apps/desktop/electron/codex-credential-broker.test.mjs` | Broker 测试 | 创建 | secret、流式、刷新、重放和脱敏测试 |

## 上下文与约束

**架构引用**：架构文档 §7、§8.4–§8.9、§9。

**对上层接口**：

```ts
interface CodexProcessManager {
  startWorkspace(input: { orgId: string; workspaceId: string; cwd: string }): Promise<CodexWorkspaceHandle>;
  stopWorkspace(workspaceId: string): Promise<void>;
  stopOrganization(orgId: string): Promise<void>;
  status(workspaceId?: string): CodexRuntimeStatus;
  dispose(): Promise<void>;
}
```

**技术约束**：

- 每个活跃本地工作区一个 App Server，首用懒启动；远端工作区拒绝启动。
- `CODEX_HOME` 位于 Electron `userData`，不得读取/修改 `~/.codex`。
- Broker 只绑定 `127.0.0.1`，随机端口、随机路径、高熵 secret，不启用 CORS。
- 真实组织 Token 仅保存在 Main 内存；Codex 子进程只获得本地 secret。
- 只有尚未输出响应字节且带稳定幂等键时，401 才可刷新后重放一次。

## Done Definition

- [x] 本地工作区首次选择 Codex 时懒启动，重复激活复用健康进程，远端工作区启动被拒绝。
- [x] Codex 使用隔离 `CODEX_HOME`，测试证明用户全局配置、auth、sessions、MCP 和 Skills 未被读写。
- [x] Broker 正确校验本地 secret、动态注入/刷新组织 Token，并以背压方式转发 Responses/SSE。
- [x] 登出、组织切换、工作区关闭、应用退出和 sidecar crash 均收敛状态并回收完整进程树。
- [x] Renderer、IPC 状态和日志中不出现组织 Token、本地 secret、Prompt、响应正文或随机 URL path。
- [x] 401 安全重放/不可重放、429/5xx、断流、超时和取消测试通过。
- [x] Desktop typecheck、相关 node tests 和 `git diff --check` 通过。

## 执行快照

**中断时间**：  
**已完成文件**：`codex-app-server-client.mjs`、`codex-credential-broker.mjs`、`codex-runtime-config.mjs`、`codex-process-manager.mjs`、`codex-main-session.mjs` 及对应测试；`main.mjs`、`desktop-config-provider.tsx`、typed Desktop IPC 已接入登录/登出/组织切换/退出闭环。  
**未完成文件**：无。  
**当前卡点**：  
**下一步行动**：TASK-005 通过统一 Runtime Adapter 调用 `startWorkspace`，把真实会话操作接到该基础设施。  
**关键决策记录**：Broker 远端 URL 使用 Token 响应的 Provider 实例 gatewayBaseUrl；Renderer 仅单向同步其现有登录会话，派生组织 Token、Broker secret、随机 URL 均不返回 IPC；配置按组织和工作区哈希隔离。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 15:01 +08:00 | 完成 Sidecar/Broker 生命周期闭环 | Electron Main、App session sync、runtime config/process manager/Broker 及测试 | 新增/修改 | 解锁 TASK-005、TASK-008、TASK-009 |
