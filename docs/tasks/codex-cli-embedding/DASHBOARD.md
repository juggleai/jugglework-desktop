# 任务看板 — JuggleWork Desktop 内置 Codex CLI

> 此文件是执行清单。每完成一项，将状态由 `[ ]` 改为 `[x]`，并把任务从“待执行”移动到“已完成”，记录完成时间和验证证据。  
> 最后更新：2026-08-13 08:40 +08:00 | 当前执行：TASK-009（TASK-008 等待部署/Provider Responses 502 解除） | 进度：8/11  
> 开发计划：[codex-cli-embedding-execution-plan.md](../../codex-cli-embedding-execution-plan.md)

---

## 进度总览

```text
████████░░░  8/11 完成
```

| 状态 | 数量 |
| --- | ---: |
| ✅ DONE | 8 |
| 🔄 IN_PROGRESS | 1（最多同时 1 个） |
| ⛔ BLOCKED | 1 |
| ⬜ TODO | 1 |

## 执行清单

- [x] [TASK-001 Codex 技术 Spike 与版本锁定](./TASK-001-Codex技术Spike.md)
- [x] [TASK-002 Runtime 公共契约与类型](./TASK-002-Runtime公共契约.md)
- [x] [TASK-003 组织 Token 与网关认证](./TASK-003-组织Token网关.md)
- [x] [TASK-004 Codex Sidecar 与 Credential Broker](./TASK-004-Codex进程代理.md)
- [x] [TASK-005 双运行时 Adapter 与安全 IPC](./TASK-005-RuntimeAdapter.md)
- [x] [TASK-006 权威会话账本与双写恢复](./TASK-006-会话双写恢复.md)
- [x] [TASK-007 Composer 与会话运行时交互](./TASK-007-会话运行时交互.md)
- [ ] [TASK-008 MCP、Skills 与图片分析](./TASK-008-首版智能体能力.md)
- [ ] [TASK-009 跨平台打包、安全与诊断](./TASK-009-跨平台打包.md)
- [ ] [TASK-010 全链路验收、灰度与发布](./TASK-010-集成发布验收.md)
- [x] [TASK-011 Composer 智能体切换 UI 入口](./TASK-011-智能体切换UI入口.md)

## 🔄 进行中

| ID | 类型 | 任务 | 所属模块 | 开始时间 |
| --- | --- | --- | --- | --- |
| TASK-009 | [INFRA] | 跨平台打包、安全与诊断 | MOD-009 | 2026-08-12 23:42 +08:00 |

## ⛔ 阻塞中

| ID | 任务 | 阻塞原因 | 等待解除条件 | 最近检查 |
| --- | --- | --- | --- | --- |
| TASK-008 | 图片真实语义回答 | 锁定版 Codex 已接收受控 `input_image`，当前部署或 Provider 上游对真实 Responses 请求返回 502 | 结合服务端部署日志修复配置/部署并重跑四类视觉夹具 | 2026-08-13 08:40 +08:00 |

## ⬜ 待执行（按拓扑顺序）

| ID | 类型 | 任务 | 所属模块 | 依赖 |
| --- | --- | --- | --- | --- |
| TASK-010 | [TEST] | 全链路验收、灰度与发布 | MOD-010 | TASK-007、TASK-008、TASK-009、TASK-011 |

## ✅ 已完成

| ID | 类型 | 任务 | 完成时间 | 验证证据 |
| --- | --- | --- | --- | --- |
| TASK-001 | [TEST] | Codex 技术 Spike 与版本锁定 | 2026-08-12 13:55 +08:00 | Codex tests 12/12；20/20 provider lifecycle；Desktop 366/1/0；Spike GO |
| TASK-002 | [IFACE] | Runtime 公共契约与类型 | 2026-08-12 14:02 +08:00 | Types test 23/23；typecheck/build/Electron runtime build/diff check 通过 |
| TASK-003 | [FEATURE] | 组织 Token 与网关认证 | 2026-08-12 14:43 +08:00 | Server `go test ./...`；Types 28/28；Codex Desktop 18/18；Responses 多图/SSE/usage/限流契约通过 |
| TASK-004 | [INFRA] | Codex Sidecar 与 Credential Broker | 2026-08-12 15:01 +08:00 | Codex 34/34；Electron Main 392/391/0（1 skip）；Desktop/App typecheck；Server `go test ./...`；双仓库 diff check |
| TASK-005 | [REFACTOR] | 双运行时 Adapter 与安全 IPC | 2026-08-12 16:02 +08:00 | Codex 40/40；OpenCode Adapter 2/2；App/Desktop typecheck；scope/order/dedupe/unknown fixture；diff check |
| TASK-006 | [FEATURE] | 权威会话账本与双写恢复 | 2026-08-12 17:02 +08:00 | Node SQLite/read model 7/7；Electron 401/400/0（1 skip）；App/Desktop/Server typecheck；diff check |
| TASK-007 | [FEATURE] | Composer 与会话运行时交互 | 2026-08-12 18:06 +08:00 | App/Desktop typecheck；runtime fixtures 4/4；sessions/session-switch；Electron 401/400/0（1 skip） |
| TASK-011 | [UI] | Composer 智能体切换 UI 入口 | 2026-08-12 21:12 +08:00 | runtime picker/state 5/5；附件/切换专项 23/23；App typecheck；本地/远端/会话锁定/分屏契约；diff check |

## 依赖关系速查

| 任务 | 依赖（需先完成） | 解锁（完成后可开始） |
| --- | --- | --- |
| TASK-001 | 无 | TASK-002、TASK-003 |
| TASK-002 | TASK-001 | TASK-005、TASK-006 |
| TASK-003 | TASK-001 | TASK-004、TASK-008 |
| TASK-004 | TASK-001、TASK-003 | TASK-005、TASK-008、TASK-009 |
| TASK-005 | TASK-002、TASK-004 | TASK-006、TASK-007、TASK-008 |
| TASK-006 | TASK-002、TASK-005 | TASK-007 |
| TASK-007 | TASK-005、TASK-006 | TASK-010、TASK-011 |
| TASK-008 | TASK-003、TASK-004、TASK-005 | TASK-010 |
| TASK-009 | TASK-004 | TASK-010 |
| TASK-011 | TASK-007 | TASK-010 |
| TASK-010 | TASK-007、TASK-008、TASK-009、TASK-011 | 首版发布 |

## 状态维护规则

1. 开始任务：任务文件和本看板状态改为 `IN_PROGRESS`，填写开始时间；同一时间只能有一个任务进行中。
2. 完成任务：逐条勾选任务文件的 Done Definition，执行验证，将本页对应清单改为 `[x]`，并把任务移入“已完成”。
3. 验证证据：至少记录测试/构建命令及结果；涉及 UI、签名或跨平台时追加截图、产物或 CI 链接。
4. 阻塞任务：记录具体阻塞、已经尝试的检查和解除条件，不用“待确认”代替技术证据。
5. 接口变更：更新任务文件“变更历史”，检查并更新所有下游任务假设。
6. 未满足全部 Done Definition 时不得标记 DONE。
