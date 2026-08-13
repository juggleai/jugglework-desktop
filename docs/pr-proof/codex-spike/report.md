# Codex App Server Spike 报告

> 日期：2026-08-12  
> 任务：TASK-001  
> 当前结论：**GO（允许进入 Runtime/认证实现；不代表达到发布条件）**

## 已完成验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 本机平台 | macOS arm64（Darwin 25.2.0） | `uname -srm` |
| Codex 版本 | 0.147.0 | `codex --version` |
| 本机二进制 SHA-256 | `19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37` | `shasum -a 256 /opt/homebrew/bin/codex` |
| App Server schema SHA-256 | `babfd5c98cd978dd858b4762cdfbc9fba941e1a0e4053de0050e4082ae1f075a` | `codex app-server generate-json-schema --experimental` |
| 官方 Release 资产 | macOS arm64/x64、Windows x64 名称/大小/SHA 已锁定 | `apps/desktop/resources/sidecars/codex-versions.json` |
| JSON-RPC 客户端 | 7/7 测试通过 | `node --test apps/desktop/electron/codex-app-server-client.test.mjs` |
| 协议循环 | 20/20 initialize + ephemeral thread/start 通过 | `node apps/desktop/scripts/codex-spike.mjs --iterations 20 --json` |
| `CODEX_HOME` 隔离 | 20/20 返回路径与临时隔离目录一致，执行后目录清理 | Spike JSON 报告 |
| OpenCode Provider 转换 | 组织 Provider API/模型可转换为 Codex `model_providers.jugglework`，凭据不进入配置 | `codex-provider-config.test.mjs` 5/5 |
| 自定义网关配置解析 | 20/20 返回 `modelProvider: jugglework` | `node apps/desktop/scripts/codex-spike.mjs --iterations 20 --json` |
| Desktop 全量测试 | 366 通过、1 跳过、0 失败（共 367） | `CI=true corepack pnpm@10.27.0 --dir apps/desktop test`（Node 24.18.0） |
| 变更格式检查 | 通过 | `git diff --check` |

最新 20 次协议循环总耗时 3790 ms；单次 initialize + thread/start 为 75–458 ms。每轮均使用新 App Server 进程、新的隔离 `CODEX_HOME` 和自定义 `jugglework` Responses Provider，并在 finally 中等待进程退出。

## 协议客户端覆盖

- newline-delimited JSON-RPC request/response。
- `initialize` 后发送 `initialized` notification。
- Server notification 分发与消费者异常隔离。
- App Server 反向 request 路由，可用于后续审批处理。
- 未注册反向 request 返回 JSON-RPC `-32601`。
- RPC error、请求超时、非法 JSON 后恢复。
- stderr 有界截断、进程异常退出、SIGTERM/SIGKILL 回收。

## 后续任务保留的发布门禁

1. TASK-003 使用 OpenCode 相同的登录态、活动组织和 Provider `/connect` 来源，实现短期 Token 获取，并验证真实文本 turn、reasoning、tool call/output、usage、401 刷新和不可安全重放。
2. TASK-008 使用首发候选视觉模型验证单图、多图、UI 截图、报错截图和非法 MIME/大小限制。
3. TASK-009/010 在 Windows x64 执行连续 thread/turn、安装签名和残留进程验证。
4. 当前 Spike 的 20 次循环只证明协议、进程隔离和自定义 Provider 配置选择；不计作真实模型 turn 或最终发布验收。

## GO 决策依据

- 锁定版 App Server 协议和目标资产可重复验证。
- 自定义 Responses Provider 是 Codex 官方配置能力，现有组织 Provider 的 API/模型结构可直接转换。
- Token 不需要写入全局 Codex、用户配置或 Renderer；后续由 Main/Credential Broker 注入隔离子进程。
- 外部环境验收已由对应实现任务承接，不再阻塞 Runtime 公共契约开发。
