# TASK-007：Composer 与会话运行时交互

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [FEATURE] |
| 职责层 | Renderer 产品交互层 |
| 所属模块 | MOD-007 Composer、会话与运行时交互 |
| 状态 | DONE |
| 依赖任务 | TASK-005、TASK-006 |
| 解锁任务 | TASK-010、TASK-011 |
| 预计工作量 | 14–20 小时 |

## 任务描述

在现有 Composer 和会话页面中提供运行时选择、会话锁定、新建切换、模型能力和错误恢复交互。该切片包含从新建会话到发送、停止、审批、恢复和归档的用户可见闭环，并保持现有工作区与 OpenCode 行为稳定。

“默认智能体”位置的具体入口、菜单视觉和可访问性交互由 TASK-011 单独验收；本任务负责向该入口提供运行时选择状态与动作。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` | `Composer` | 修改 | Runtime/Agent/Model 选择与 capability UI |
| `apps/app/src/react-app/shell/session-route.tsx` | `SessionRoute` | 修改 | 新会话运行时绑定、发送、恢复和错误提示 |
| `apps/app/src/react-app/domains/session/sync/actions-store.ts` | session actions | 修改 | 后端无关 send/steer/stop/approve |
| `apps/app/src/react-app/domains/session/sync/runtime-sync.tsx` | `ReactSessionRuntime` | 修改 | runtime subscription 生命周期 |
| `apps/app/src/react-app/domains/session/surface/composer-state-store.ts` | draft/runtime state | 修改 | 新会话运行时选择与会话快照 |
| `apps/app/src/react-app/domains/session/modals/model-picker-modal.tsx` | model picker | 修改 | JuggleWork 网关模型与视觉能力 |
| `apps/app/src/react-app/domains/session/sidebar/session-management-store.ts` | session lifecycle | 修改 | 切换新建、归档与恢复 |
| `apps/app/src/react-app/domains/session/sync/runtime-selection.test.ts` | interaction tests | 创建 | 锁定、新建、远端禁用和焦点测试 |

## 上下文与约束

**需求锚点**：架构文档 §5.2、§6、§12、§16；执行计划 MOD-007。

**业务规则**：

- 空会话可自由选择 OpenCode/Codex；首次发送后锁定 `runtimeKind`。
- 已开始会话切换运行时必须创建新的 JuggleWork Session ID，不修改原会话。
- Codex 只在本地工作区可选；远端工作区不展示或明确禁用。
- 用户不看到 Codex/OpenAI 登录、个人 API Key 或购买入口。
- 默认值优先级为会话快照 > 工作区默认 > 应用全局默认。

## Done Definition

- [x] 本地新会话具备 OpenCode/Codex、网关模型与推理强度状态/动作；具体“默认智能体”入口由 TASK-011 验收。
- [x] 首次创建后运行时绑定 JuggleWork Session ID；不同运行时创建独立会话，原会话不被改写。
- [x] 远端工作区强制 OpenCode，Main 仍拒绝远端 Codex 启动。
- [x] Codex 会话支持 send、steer/stop、审批、冷启动懒恢复和归档。
- [x] runtime capabilities 已作为统一契约；图片与 MCP/Skills 的产品展示由 TASK-008 专项验收。
- [x] 新建/打开会话沿用既有 `focusPromptSoon`，工作区列表按 ID 合并且不改变工作区顺序。
- [x] App/Desktop typecheck、runtime fixtures、sessions/session-switch 和完整 Electron 回归通过。

## 执行快照

**中断时间**：  
**已完成文件**：runtime selection/locking store、Codex create/resume/send/steer/stop/approval/archive、权威 snapshot、侧栏合并和 tests。  
**未完成文件**：无；运行时菜单 UI 在 TASK-011，图片/MCP/Skills 在 TASK-008。  
**当前卡点**：无。  
**下一步行动**：进入 TASK-008，完成图片、MCP、Skills 的能力闭环。  
**关键决策记录**：

- TASK-005 只交付统一 Adapter、事件标准化与安全 IPC；本任务在 TASK-006 权威映射可用后负责彻底移除主会话链路对 `session.create`、`promptAsync`、`event.subscribe` 和 OpenCode 原始类型的直接依赖。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| （执行后填写） | | | | | |
| v1 | 2026-08-12 18:06 +08:00 | 完成双运行时会话交互闭环 | runtime selection、session route、runtime sync、surface | 新增/修改 | App/Desktop typecheck；fixtures 4/4；sessions/session-switch 通过 |
