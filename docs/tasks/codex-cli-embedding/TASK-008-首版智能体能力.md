# TASK-008：MCP、Skills 与图片分析

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [FEATURE] |
| 职责层 | 首版智能体能力层 |
| 所属模块 | MOD-008 MCP、Skills 与图片分析 |
| 状态 | BLOCKED |
| 依赖任务 | TASK-003、TASK-004、TASK-005 |
| 解锁任务 | TASK-010 |
| 预计工作量 | 16–20 小时 |

## 任务描述

在隔离的 Codex 环境内交付 MCP、Skills 和图片视觉理解三个首版能力。复用现有 Composer 附件、JuggleWork MCP/Skill 管理和统一审批体系，并确保组织、工作区、路径、凭据及模型能力边界完整。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/desktop/electron/codex-capability-config.mjs` | `projectCodexCapabilities` | 创建 | 将 MCP/Skills 投影到隔离 `CODEX_HOME` |
| `apps/desktop/electron/jugglechat-skill-bridge.mjs` | skill inventory | 修改 | 复用应用内置 Skills 清单与版本 |
| `apps/desktop/electron/codex-capability-config.test.mjs` | isolation tests | 创建 | 组织/工作区隔离、全局目录不读取 |
| `apps/app/src/react-app/domains/session/sync/attachment-support.ts` | media capability | 修改 | 运行时/模型图片支持判定 |
| `apps/app/src/react-app/domains/session/sync/attachment-file-part.ts` | image input adapter | 修改 | 路径、MIME、大小、数量和对象引用 |
| `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` | attachment UX | 修改 | 上传、粘贴、拖入和能力提示 |
| `apps/app/src/react-app/domains/session/surface/mcp-chat-reconnect.ts` | MCP lifecycle | 修改 | Codex MCP 连接、断连和重试 |
| `apps/app/src/react-app/domains/session/sync/codex-image-analysis.test.ts` | visual fixtures | 创建 | 单图、多图和安全边界测试 |

## 上下文与约束

**需求锚点**：架构文档 §7.5、§8.2、§14；执行计划 MOD-008 与“图片分析专项验收”。

**业务规则**：

- 图片能力是识别、理解和分析，不包含图片生成。
- 支持上传、粘贴、拖入、单图和多图；发送前检查模型 `supportsImages`。
- MCP 配置/凭据按 `orgId + workspaceId` 隔离，组织切换必须关闭旧连接并清理凭据。
- 应用内置 Skills 随版本发布；受信任工作区 Skills 可被发现；不读取 `~/.codex/skills`。
- 图片仅能来自当前工作区或应用受控临时目录；普通日志和 IPC 不复制 base64 正文。

## 实现指引

- 优先复用 Composer 现有图片压缩、附件 token 和工作区 inbox 能力，避免另建一套附件系统。
- Main 对真实路径、symlink/junction、MIME、大小、数量和 hash 做最终校验，Renderer 校验只用于体验。
- Skill 快照记录 id、来源、版本；MCP 凭据通过 Main 安全注入，不写入 TOML、历史或日志。
- 视觉测试必须断言模型回答与图片事实相关，不能只断言请求成功。

## Done Definition

- [x] Codex 可发现并调用批准的 MCP，审批、超时、断连、重连和组织切换清理行为通过测试。
- [x] Codex 可发现应用内置和受信任工作区 Skills，并记录来源/版本；测试证明用户全局 Skills 未被读取。
- [x] 用户可上传、粘贴或拖入支持格式的图片，并完成单图与多图分析。
- [ ] UI 截图、报错截图、流程图和多图差异均得到与可见内容相关的有效回答。
- [x] 无视觉模型、伪造 MIME、超限、工作区外、symlink/junction 越界和跨组织附件均在发送前被拒绝。
- [x] IPC、日志和事件账本不包含图片 base64、MCP 凭据或组织 Token；历史可通过受控引用恢复图片展示。
- [x] App/Desktop typecheck、MCP/Skills/附件/视觉测试和 `git diff --check` 通过。

## 执行快照

**中断时间**：2026-08-12 23:42 +08:00  
**已完成文件**：`codex-capability-config.mjs`、`codex-image-input.mjs`、Codex profile/process 配置、Composer 图片 pointer 转换、模型图片能力校验、会话 capability 快照及对应测试  
**未完成文件**：真实组织网关返回图片事实回答的验收记录  
**当前卡点**：锁定版 Codex 0.147.0 已真实创建 thread，Skills 来源/哈希已写入权威台账；UI PNG 也通过 inbox、realpath、MIME、大小与 magic bytes 校验进入 App Server `input_image`。仓库 Responses 透传契约通过，但当前部署或该 Provider 上游对真实 Responses 请求返回 502，模型没有产生语义回答，不能勾选最后一项。  
**下一步行动**：结合服务端部署日志修复 Responses 部署/Provider 上游配置，再执行 UI 截图、报错截图、流程图和多图差异四类真实语义夹具  
**关键决策记录**：图片字节先复用 workspace inbox，IPC/账本只传受控绝对路径；Main 校验 realpath、inbox 边界、大小与 magic bytes；子进程同时隔离 `CODEX_HOME`、`HOME`、`USERPROFILE`，只投影 bundled/workspace Skills；MCP secret 仅通过子进程环境注入；App Server `error` 标准化为 `turn.failed/gateway_unavailable`

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 19:41 +08:00 | 首版能力实现 | capability/image/config/composer/tests | 新增 | TASK-010 |
| v2 | 2026-08-12 23:42 +08:00 | 真实 sidecar/图片/网关验收 | process/adapter/ledger/evidence | 修改 | TASK-010 |
