# TASK-010：全链路验收、灰度与发布

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [TEST] |
| 职责层 | 集成验证与发布层 |
| 所属模块 | MOD-010 全链路测试、灰度与发布验收 |
| 状态 | TODO |
| 依赖任务 | TASK-007、TASK-008、TASK-009、TASK-011 |
| 解锁任务 | 首版发布 |
| 预计工作量 | 16–20 小时 |

## 任务描述

建立并执行首版完整验收矩阵，覆盖协议、认证、双写恢复、MCP、Skills、图片分析、OpenCode 回归、跨平台安装升级和安全边界。通过功能开关分阶段灰度，并完成自动暂停与回滚演练后才允许全量。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `evals/codex/runtime-contract.eval.mjs` | runtime eval | 创建 | 文本、工具、审批、恢复和错误评测 |
| `evals/codex/image-analysis.eval.mjs` | visual eval | 创建 | UI、报错、流程图、多图语义验收 |
| `evals/codex/security-boundaries.eval.mjs` | security eval | 创建 | org/workspace/path/secret 边界 |
| `apps/app/src/react-app/domains/session/sync/codex-e2e.test.ts` | session E2E | 创建 | 新建、切换、发送、恢复、归档 |
| `apps/server/src/codex-gateway.release.e2e.test.ts` | gateway E2E | 创建 | Token、Responses、限流和撤销 |
| `scripts/release/codex-readiness.mjs` | release gate | 创建 | 汇总版本、测试、签名和灰度条件 |
| `docs/pr-proof/codex-release/report.md` | 发布证据 | 创建 | 平台矩阵、风险接受、回滚结果 |
| `docs/support/codex-runtime-diagnostics.md` | 支持文档 | 创建 | 用户安全诊断和恢复流程 |

## 上下文与约束

**需求锚点**：架构文档 §14–§17、执行计划 §六首版验收矩阵和 MOD-010。

**发布阶段**：

```text
开发/内部 → 指定测试组织 → 小比例组织 → 扩大灰度 → 全量
```

**技术约束**：

- 任一阶段可通过服务端/客户端开关禁用 Codex，不影响 OpenCode 使用和历史读取。
- 自动暂停至少监控启动失败率、网关认证失败率、turn 失败率、崩溃率和双写不一致率。
- 遥测只记录版本、耗时、状态码和哈希标识，不记录 Prompt、回复、Token 或真实路径。
- 高危安全问题、跨组织访问、历史破坏或不可回滚升级均为发布阻断。

## Done Definition

- [ ] macOS arm64/x64、Windows x64 的文本、工具、审批、停止、恢复、归档、MCP、Skills、单图/多图主流程全部通过。
- [ ] Token 过期、401/429/5xx、登出、组织切换、跨组织请求、SSE 断流和 sidecar crash 场景全部符合契约。
- [ ] 双写重复/乱序/异常退出/thread 丢失恢复通过，且没有 JuggleWork 权威历史被 Codex 状态覆盖。
- [ ] UI 截图、报错截图、流程图和多图比较语义评测达到评审冻结的通过阈值。
- [ ] 现有 OpenCode 会话、工作区、排序、loading、通知、归档、附件和输入焦点回归全部通过。
- [ ] 安全评审无高危问题；安装、签名、升级、回滚、残留进程和包体证据齐全。
- [ ] 内部和测试组织灰度指标达标，自动暂停与回滚演练成功，发布报告获得产品/架构/安全确认。

## 执行快照

**中断时间**：  
**已完成文件**：  
**未完成文件**：  
**当前卡点**：  
**下一步行动**：  
**关键决策记录**：

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| （执行后填写） | | | | | |
