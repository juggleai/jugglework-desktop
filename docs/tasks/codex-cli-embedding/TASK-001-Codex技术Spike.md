# TASK-001：Codex 技术 Spike 与版本锁定

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [TEST] |
| 职责层 | 技术验证层 |
| 所属模块 | MOD-001 Codex 技术 Spike 与协议锁定 |
| 状态 | DONE |
| 依赖任务 | 无 |
| 解锁任务 | TASK-002、TASK-003 |
| 预计工作量 | 12–18 小时 |

## 任务描述

建立可重复运行的 Codex App Server 验证工具，锁定 CLI 版本、资产哈希和协议 schema。使用真实 JuggleWork Responses 网关验证文本、工具、审批、中断、Token 刷新以及图片识别，而不是只验证 HTTP 请求成功。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `apps/desktop/scripts/codex-spike.mjs` | `runCodexSpike` | 创建 | 启动 App Server 并执行协议场景 |
| `apps/desktop/electron/codex-app-server-client.mjs` | `createCodexAppServerClient` | 创建 | 最小 JSON-RPC stdio 客户端，后续可复用 |
| `apps/desktop/electron/codex-app-server-client.test.mjs` | App Server fixtures | 创建 | RPC、乱序、未知事件和退出测试 |
| `apps/desktop/electron/codex-provider-config.mjs` | OpenCode Provider 转换 | 创建 | 将组织 Provider 转为隔离 Codex Responses 配置 |
| `apps/desktop/electron/codex-provider-config.test.mjs` | Provider config fixtures | 创建 | URL、模型、Token 隔离和 TOML 契约测试 |
| `apps/desktop/resources/sidecars/codex-versions.json` | 版本清单 | 创建 | 记录版本、target、SHA-256、schema 版本 |
| `apps/desktop/package.json` | `spike:codex` | 修改 | 注册可重复运行的 Spike 命令 |
| `docs/pr-proof/codex-spike/report.md` | Go/No-Go 报告 | 创建 | 保存平台、协议、网关和视觉测试证据 |

## 上下文与约束

**需求锚点**：架构文档 §13 Phase 0、§14 测试矩阵、执行计划 MOD-001。

**技术约束**：

- 使用 `codex app-server --stdio`，不解析 TUI/ANSI。
- CLI 版本与资产 SHA 必须固定，不能使用浮动 `latest`。
- 使用隔离临时 `CODEX_HOME`，不得读取或修改 `~/.codex`。
- 图片测试必须包含单图、多图、UI 截图、报错截图和不支持 MIME。
- Spike 不接入正式 Renderer，不改变现有 OpenCode 会话行为。

## 实现指引

- 客户端负责 request ID、超时、notification 分发、stderr 截断和子进程退出收敛。
- 场景覆盖 initialize、thread create/resume、turn start、stream、tool、approval、interrupt、usage 和终态。
- 报告记录 macOS arm64、Windows x64 的连续运行结果、首 token 延迟和残留进程检查。
- 将锁定版生成的 schema 或 schema 哈希保留为后续 Adapter 契约输入。

## Done Definition

- [x] 固定 Codex CLI 版本、三类目标资产名称、SHA-256 和 App Server schema/version，并写入版本清单。
- [x] macOS arm64 连续完成 20 次隔离 App Server initialize + thread/start，确认进程退出和独立 `CODEX_HOME`。
- [x] JSON-RPC response、notification、反向 request、错误、超时、非法 JSON 和退出回收有可重复 fixture 测试。
- [x] 复用 OpenCode 组织 Provider 连接结构生成 Codex Responses Provider 配置，配置文件不包含组织 Token。
- [x] 自定义 `jugglework` Provider 配置被锁定版 Codex 解析并在 20/20 次 thread/start 中实际选中。
- [x] `codex-app-server-client`、Provider 配置测试、Desktop 现有测试和 `git diff --check` 通过。
- [x] 报告给出架构 Spike GO，并将真实认证/网关、图片语义、Windows 门禁分别下沉到 TASK-003、TASK-008、TASK-009/010。

## 执行快照

**中断时间**：  
**已完成文件**：
- `apps/desktop/electron/codex-app-server-client.mjs`：已实现 newline-delimited JSON-RPC、initialize、通知、反向请求、超时、stderr 截断和退出收敛。
- `apps/desktop/electron/codex-app-server-client.test.mjs`：7 个协议客户端测试通过（2026-08-12）。
- `apps/desktop/resources/sidecars/codex-versions.json`：已根据 OpenAI `rust-v0.147.0` Release 元数据锁定 macOS arm64/x64、Windows x64 资产与 SHA-256，并记录本机二进制和 App Server schema 哈希。
- `apps/desktop/scripts/codex-spike.mjs`：已实现版本/schema 校验及隔离 `CODEX_HOME` 的 20 次 initialize + ephemeral thread/start 循环；本机 20/20 通过。
- `apps/desktop/package.json`：已注册 `spike:codex` 并将协议客户端测试加入 Desktop test suite。
- `apps/desktop/electron/codex-provider-config.mjs`：已复用 OpenCode 组织 Provider 的 API/模型结构生成 Codex Responses 配置，Token 仅注入子进程环境。
- `apps/desktop/electron/codex-provider-config.test.mjs`：5 个 Provider 转换、隔离和拒绝场景通过。
- `docs/pr-proof/codex-spike/report.md`：已记录本地证据与尚未满足的 Go 门禁。
- 本机验证：Codex 客户端 7/7、隔离进程生命周期 20/20；Desktop 全量测试 366 通过、1 跳过、0 失败；`git diff --check` 通过。
**未完成验证**：无（本 Spike 收敛后的 Done Definition 已完成）。真实模型 turn/认证刷新归 TASK-003，图片语义归 TASK-008，Windows 归 TASK-009/010。  
**当前卡点**：无。  
**下一步行动**：执行 TASK-002 Runtime 公共契约与类型。  
**关键决策记录**：2026-08-12 用户确认 Codex 可参考 OpenCode 调用逻辑继续；沿用组织 Provider `/connect` 的 API/模型来源，但 Token 由 Desktop Main 注入隔离 Codex 子进程，不进入 Renderer 或 `config.toml`。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 13:55 +08:00 | 完成技术 Spike | App Server 客户端、版本清单、Provider 配置转换、测试与报告 | 新增协议/配置基线 | TASK-002、TASK-003 |
