# 目标模式（Goal Mode）技术方案

状态：v2，入口与范围已确认（2026-11-28）；P1 已实现，未提交
关联：`openspec/changes/add-persistent-goal-mode/`（规格已按本版同步，未开始实现）

## 1. 背景与要解决的问题

现在每次发送都是一次独立 run。计划模式（OpenCode 内置 `plan` agent）只负责先出计划、不改文件，计划和 todo 都只属于当前 run：

- run 结束、上下文自动压缩、应用重启后，没有一个持久的"我到底要达成什么"。
- 用户要一直盯着对话，手动说"继续"。
- run 结束（空闲、报错、额度用完）容易被误认为目标已完成。

目标模式要做的是：用户定义一个目标和可验证的完成标准，JuggleWork 在多个 run 之间持续推进，直到达成、被用户叫停，或者遇到必须由人处理的阻塞。

## 2. 已确认的决策

| 问题 | 决定 |
|---|---|
| 入口 | + 菜单新增"目标"，与"计划模式"平级。目标不是 OpenCode agent，不改会话 agent；目标 run 用普通执行 agent |
| 预算 | 首版不做 token 预算，只做续跑次数上限 |
| 续跑上限 | 连续自动续跑默认 10 次。创建后的首个 run 不计入；用户点"继续"或"恢复"时清零 |
| 范围 | 首版只支持本地工作区。远程、云端、沙箱工作区不显示入口，服务端也拒绝创建 |

## 3. 用户流程

1. 用户在 + 菜单选"目标"，弹出设置面板：目标描述、完成标准（每条可验证，可增删）。
2. 点"开始"：服务端创建目标并立即发起第一次目标 run。如果当前选中了计划模式，同时清除计划模式选择，因为计划 agent 不能改文件，目标无法推进。
3. 输入框上方常驻"目标卡"：目标、标准进度、当前动作、已用续跑次数（如 3/10）、暂停/继续/取消。
4. 每次 run 结束，服务端判断是否续跑；连续续跑到 10 次进入"等待用户"，卡片显示"继续"。
5. 所有必需标准满足且模型提交了证据，目标完成；或用户取消；或进入阻塞/等待用户。

用户在目标进行中正常发消息，按现有插话/排队路径处理，不会替换目标；修改目标和标准只能通过目标卡的"编辑"。

## 4. 总体架构

```
渲染端                         服务端 (apps/server)                    引擎 (opencode)
─────────                     ─────────────────────                  ─────────────
+ 菜单「目标」/设置面板 ──►   Goal API (创建/编辑/暂停/继续/取消)
目标卡                  ◄──   GoalStore (runtime.sqlite)
                              GoalCoordinator + pump  ──runs/start──►  session.prompt
                                 ▲  监听 run 终态                      (执行 agent,
                                 │                                       system=目标信封)
                              lifecycle journal ◄── 终态/空闲观测 ──
                              opencode 插件 jugglework-goal
                                 goal.read / goal.progress /   ◄────  模型调用工具
                                 goal.blocker / goal.complete
```

关键原则（沿用已有 OpenSpec 设计）：

- 目标是服务端拥有的领域对象，不是 agent，也不是隐藏提示。
- 目标状态只能由结构化操作改变，模型的自然语言不改状态。
- 续跑统一走现有 `startSessionRun` 和 mutation coordinator，不绕开 generation 栅栏和忙碌检查。
- 目标模式不增加任何权限。

## 5. 数据模型（runtime.sqlite）

放在 `apps/server/src/goal-store.ts`，建表方式参照 `session-run-journal.ts`（`CREATE TABLE IF NOT EXISTS` + 迁移表）。

`session_goals`

| 字段 | 说明 |
|---|---|
| id, workspace_id, session_id | 部分唯一索引：同一会话最多一个未终结目标 |
| objective | ≤ 4KB |
| criteria_json | `[{id, text, required, status: pending/met/waived, evidence?}]`，1 到 20 条，至少 1 条必需 |
| status | `active / paused / blocked / completed / cancelled` |
| execution | `idle / queued / running / waiting_user / retrying / usage_limited` |
| checkpoint_json | 最近一次进度：已完成要点、下一步，≤ 8KB |
| continuation_total | 总续跑次数 |
| continuation_streak | 连续自动续跑次数，上限 10，用户继续/恢复时清零 |
| no_progress_count | 检查点指纹连续不变的次数 |
| blocker_fingerprint, blocker_count | 同一阻塞连续 3 次进入 blocked |
| active_run_id, version | 乐观锁 |
| created_at, updated_at, completed_at | |

`session_goal_runs`：`goal_id, ordinal, idempotency_key = <goalId>:<ordinal>, run_id, trigger(create/auto/user_continue), state(queued/dispatching/running/ended), outcome`。

`session_goal_events`：只存状态码、计数、run id、时间，不存对话、工具参数、文件内容。

首版不建预算字段。以后加预算时新增可空列即可，空值表示不限，现有目标不用迁移。

## 6. 服务端组件

### 6.1 Goal API（`apps/server/src/routes/goals.ts`）

- `GET  /workspace/:id/sessions/:sessionId/goal` 当前目标
- `POST /workspace/:id/sessions/:sessionId/goal` 创建：已有未终结目标返回 409 和现有目标；非本地工作区返回 400
- `PATCH .../goal/:goalId` 编辑目标和标准（带 version）
- `POST .../goal/:goalId/{pause,resume,cancel,continue,complete}`：`complete` 是用户手动判定完成；`resume`/`continue` 清零连续续跑计数
- `GET  .../goal/:goalId/runs`

鉴权沿用 `addRoute(..., "client", ...)`。本地工作区判断复用现有工作区类型字段。

### 6.2 模型侧工具（opencode 插件）

新增插件 `apps/server/src/opencode-plugins/jugglework-goal.ts`，接入方式参照 `jugglework-extensions-preview.ts` 的 affordance：

- `goal.read`：读当前目标、标准、检查点
- `goal.progress`：`{criteriaUpdates:[{id,status,evidence}], checkpoint, madeProgress}`
- `goal.blocker`：`{reason, needsUser: boolean}`
- `goal.complete`：只有所有必需标准都已 met 才成功，否则返回未满足项

插件按 sessionID 回调服务端（与 `product_tasks.list` 同一通道），服务端校验版本和状态迁移。工具只在会话存在活动目标时注入，普通会话看不到。

### 6.3 目标信封注入

每次目标 run 由服务端在 `runs/start` 的 `system` 字段拼一段目标信封（`promptBodySchema.system` 已支持）。内容包括目标、标准及状态、最近检查点、第几次续跑、距上限还剩几次，以及固定规则：先检查工作区现状再动手、每完成一条标准调用 `goal.progress`、不要重复已完成工作、不能自行扩大权限。

信封每次从数据库重建，不依赖对话历史，所以上下文压缩不会丢目标。

上次分析过 Claude 很少调用 `todowrite`。目标进度改走 `goal.progress`，信封里写明调用时机，目标卡不依赖模型的 todo 习惯。

### 6.4 GoalCoordinator（`apps/server/src/goal-coordinator.ts`）

结构参照 `session-pending-operation-pump.ts`：

- 触发：run 终态（lifecycle journal 的 `run_terminal`）、权威空闲观测、用户回答权限或问题、用户点"继续"、启动时恢复。
- 派发条件需全部满足：status=active；没有待处理的权限或问题；连续续跑未到 10 次；账号额度可用；会话没有活动 root run；上一个 run 已有终态。
- 先写 `session_goal_runs(queued)`，再调用 `startSessionRun`，传入执行 agent、目标信封，以及一条带 `goal` 元数据的短续跑指令。幂等键防止重复派发。
- 上限：常量 `GOAL_MAX_CONSECUTIVE_CONTINUATIONS = 10`。每次自动续跑 +1；到 10 进入 `waiting_user`；用户继续或恢复时清零。
- 防空转：检查点指纹连续不变计入 no_progress；同一阻塞连续 3 次进入 blocked。
- 暂停/取消在同一事务里撤销 queued 记录；正在跑的 run 走现有 `abortSessionRun`。
- 依赖已提交的 60 秒空闲收敛（`36baa1ec5`），保证 run 一定会结束，协调器不会一直等。

## 7. 渲染端

| 位置 | 改动 |
|---|---|
| `composer.tsx` + 菜单 | 在 agent/模式分组新增 `kind: "goal"` 条目，排在"计划模式"旁；仅本地工作区显示（`isRemoteWorkspace`、`isSandboxWorkspace` 都为假） |
| 新 `goal-setup-dialog.tsx` | 目标描述和完成标准列表；确认时若选中计划模式则清除 |
| 新 `goal-card.tsx` | 输入框上方常驻：目标、标准进度、当前动作、续跑次数 n/10、编辑/暂停/继续/取消；todo 进度条放在它下面 |
| 新 `use-session-goal.ts` | React Query；会话 SSE 事件和重连时失效；目标活动时 5 秒兜底刷新 |
| 消息列表 | 带 goal 元数据的续跑消息折叠为"目标继续 #n"，不显示为用户气泡 |
| i18n | 中英文案；其他语言先回退英文 |

## 8. 分期

| 阶段 | 内容 | 可见效果 |
|---|---|---|
| P1 | 数据表、Goal API、+ 菜单入口、设置面板、目标卡、手动"继续" | 能建目标、看进度、手动推进，不自动续跑 |
| P2 | 插件工具 + 目标信封 | 进度由模型结构化上报，上下文压缩不丢目标 |
| P3 | GoalCoordinator 自动续跑、10 次上限、防空转、交互挂起 | 无人值守持续推进 |
| P4 | 重启恢复、上下文压缩、断线 E2E；macOS/Windows 验收；去掉功能开关 | 正式发布 |

自动续跑（P3）单独开关，出问题可以只关派发不删数据。

## 9. 风险

- **自动续跑空转或重复改文件**：检查点指纹、10 次上限、幂等键，以及信封里"先看工作区现状"的规则。
- **模型误报完成**：`goal.complete` 由服务端校验必需标准，并保留用户手动判定完成。
- **没有预算，长目标耗费 token**：首版只靠 10 次上限兜底，每 10 次需要用户确认一次。
- **续跑消息让对话变乱**：用元数据折叠展示。
- **与自动化、远程控制抢会话**：全部走 mutation coordinator，权威空闲后才派发。

## 10. 待确认

1. 用户在计划模式下确认新目标时，自动清除计划模式选择。这是我根据"计划 agent 不能改文件"推出来的，需要确认是否接受。
2. 完成标准至少填一条必需标准，否则 `goal.complete` 无法校验。是否接受这个约束？

## 11. 规格同步

`openspec/changes/add-persistent-goal-mode/` 已按本版更新，`openspec validate --strict` 通过：

- 新增需求：目标与计划模式平级的 + 菜单入口；首版仅本地工作区。
- 预算需求改为"首版不支持 token 预算，只受账号额度限制"。
- 续跑上限明确为默认 10 次，以及清零规则。

## 12. P1 实现记录

已实现（仅本地工作区）：
- 服务端：`apps/server/src/goal-store.ts`（`session_goals` / `session_goal_runs` / `session_goal_events`），`apps/server/src/routes/goals.ts`（查询、创建、编辑、暂停、恢复、取消、完成、继续、运行记录）。创建后立即通过 `startSessionRun` 发起首次运行，目标信封走 `system` 字段。运行结束（lifecycle `run_terminal`）把目标执行状态改回空闲，不会标记完成。删除会话时一并删除目标。
- 渲染端：`use-session-goal.ts`、`goal-panel.tsx`（设置面板 + 目标卡），+ 菜单「目标」紧跟「计划模式」，确认时自动退出计划模式。
- 测试：`apps/server/src/goal-store.test.ts`、`session-mutation.e2e.test.ts` 中的 "session goal APIs"、`apps/app/tests/goal-mode.test.tsx`。

P1 刻意未做：自动续跑（GoalCoordinator）、模型侧 `goal.*` 工具、检查点写入、续跑消息折叠。目标卡上的完成标准状态在 P2 之前只会由用户手动"标记完成"改变。
