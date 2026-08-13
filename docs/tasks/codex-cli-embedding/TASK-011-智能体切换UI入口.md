# TASK-011：Composer 智能体切换 UI 入口

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [UI] |
| 职责层 | Renderer 产品交互层 |
| 所属模块 | MOD-007 Composer、会话与运行时交互 |
| 状态 | DONE |
| 依赖任务 | TASK-007 |
| 解锁任务 | TASK-010 |
| 预计工作量 | 6–10 小时 |

## 任务描述

在 Composer 输入框下方现有“默认智能体”位置增加 OpenCode/Codex 运行时切换入口。保留 OpenCode 内部 Agent 选择能力，清晰区分“运行时”和“运行时内的 Agent”，并落实新会话可切换、已开始会话切换即新建会话的规则。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` | `Composer` | 修改 | 在“默认智能体”入口展示并切换 OpenCode/Codex |
| `apps/app/src/react-app/shell/session-route.tsx` | `SessionRoute` | 修改 | 注入运行时状态、新建会话动作和本地/远端可用性 |
| `apps/app/src/react-app/domains/session/surface/composer-state-store.ts` | runtime draft state | 修改 | 保存新会话选择，不覆盖已开始会话快照 |
| `apps/app/src/i18n/locales/zh.ts` | Composer 文案 | 修改 | 增加运行时名称、切换新建和不可用提示 |
| `apps/app/src/i18n/locales/en.ts` | Composer copy | 修改 | 英文基线文案 |
| `apps/app/tests/composer-runtime-picker.test.tsx` | UI tests | 创建 | 入口位置、菜单、锁定和远端禁用测试 |

## 上下文与约束

**需求锚点**：架构文档 §3.2、§5.2、§6；执行计划 MOD-007；用户指定入口位置为 Composer 当前“默认智能体”。

**交互契约**：

- 入口沿用当前“默认智能体”触发区域，不新增第二排常驻控件。
- 一级选择为 OpenCode/Codex；OpenCode 自定义 Agent 作为 OpenCode 下的二级选择，不能与 Runtime 共用同一个字段。
- 空白本地会话切换只更新草稿运行时；首次发送后运行时锁定。
- 已开始会话选择另一运行时，明确提示并创建新 JuggleWork 会话，原会话保持不变。
- 远端工作区不展示 Codex，或显示禁用项并说明仅支持本地工作区。
- Codex 不展示 OpenAI 登录、API Key 或付费入口。

## Done Definition

- [x] “默认智能体”位置可打开运行时菜单，并清晰展示当前为 OpenCode 或 Codex。
- [x] OpenCode 的默认/自定义 Agent 选择保持可用，且运行时与 Agent Profile 状态没有混用。
- [x] 本地空会话切换运行时不新建冗余会话；已开始会话切换会明确新建会话并保留原历史。
- [x] 远端工作区无法选择 Codex，禁用/隐藏表现与键盘导航、屏幕阅读语义一致。
- [x] 选择结果与模型、推理强度、图片 capability 联动，加载/失败状态不会让入口跳动。
- [x] 中英文核心文案完整；Composer 截图评审通过。
- [x] UI 单元测试、App typecheck、现有 Composer/session-switch 回归测试和 `git diff --check` 通过。

## 执行快照

**中断时间**：2026-08-12 21:12 +08:00  
**已完成文件**：Composer、SessionSurface、SessionRoute、runtime selection store、中英文文案、runtime picker tests  
**未完成文件**：无  
**当前卡点**：无  
**下一步行动**：进入 TASK-010 时随完整应用验收补最终发布截图  
**关键决策记录**：入口复用 Composer 的“默认智能体”位置；不把 Codex 伪装成 OpenCode 自定义 Agent。

**UI 证据**：2026-08-12 21:45 +08:00 通过 Electron CDP 实例确认菜单为“OpenCode / Codex”一级选择和“OpenCode 智能体”二级选择；本地 Codex 项可用，截图位于本次执行临时证据 `/tmp/jugglework-codex-runtime-menu.png`。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 21:12 +08:00 | 用户要求增加默认智能体入口 | Composer/session route/runtime state/i18n/tests | 新增 | TASK-010 |
