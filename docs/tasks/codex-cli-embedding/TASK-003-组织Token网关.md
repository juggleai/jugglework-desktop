# TASK-003：组织 Token 与网关认证

## 基本信息

| 属性 | 内容 |
| --- | --- |
| 类型 | [FEATURE] |
| 职责层 | Server/Gateway 业务层 |
| 所属模块 | MOD-003 组织 Token 与模型网关服务 |
| 状态 | DONE |
| 依赖任务 | TASK-001 |
| 解锁任务 | TASK-004、TASK-008 |
| 预计工作量 | 14–20 小时 |

## 任务描述

提供登录 JuggleWork 后自动换取短期模型 Token 的完整服务端切片，包括 Token 交换、组织/设备/权限绑定、Codex 模型目录、Responses 网关校验和免费能力用量保护。若模型网关位于外部仓库，本任务仍负责在当前仓库固化客户端/服务端契约与集成测试。

## 包含文件

| 文件路径 | 类/导出 | 操作 | 说明 |
| --- | --- | --- | --- |
| `packages/types/src/den/codex-gateway.ts` | Token、model catalog DTO/schema | 创建 | 跨端网络契约 |
| `packages/types/src/index.ts` | 公共导出 | 修改 | 暴露网关契约 |
| `apps/desktop/electron/codex-gateway-token-provider.mjs` | Main-only exchange/cache | 创建 | 复用 Den 登录组织语义，刷新派生 Token；不向 Renderer 返回凭据 |
| `apps/desktop/electron/codex-gateway-token-provider.test.mjs` | Token provider tests | 创建 | 单飞、刷新、失效、组织/设备/scope 和脱敏测试 |
| `apps/desktop/package.json` | `test:codex` | 修改 | 纳入网关客户端契约测试 |
| `/Applications/work/jugglework-server/apis/codex_gateway.go` | Codex control routes | 创建 | 短期 Token 交换、组织模型目录和稳定错误 |
| `/Applications/work/jugglework-server/services/codex_gateway.go` | Codex gateway service | 创建 | Provider 授权、能力投影、并发和滚动速率保护 |
| `/Applications/work/jugglework-server/services/gateway_tokens.go` | token issuer | 修改 | Codex source、短 TTL 和设备绑定 |
| `/Applications/work/jugglework-server/services/gateway_relay.go` | Responses relay | 修改 | 保持 Codex Responses 请求字节及 SSE 语义 |
| `/Applications/work/jugglework-server/services/gateway_sse.go` | usage parser | 修改 | 解析 Responses `response.completed` usage |
| `/Applications/work/jugglework-server/apis/codex_gateway_test.go` 等 | gateway tests | 创建/修改 | 交换、目录、scope、图片、SSE、usage、限流测试 |

## 上下文与约束

**需求锚点**：架构文档 §8.2–§8.9、执行计划 MOD-003。

**网络契约基线**：

```text
POST /v1/codex/gateway-token
GET  /v1/codex/models
POST /v1/responses  （模型网关）
```

最终路径需遵循当前 Server 的 `/jwork` 路由前缀和部署规范，并在编码前固化；不能同时保留两个模糊别名。

**技术约束**：

- 派生 Token 至少绑定 `sub`、`org_id`、`device_id`、`aud`、`scope`、`exp`。
- 不得把 JuggleWork 主登录 Token 原样转发给模型网关。
- 模型目录必须声明 images、tools、reasoning efforts 和 enabled 状态。
- 免费权益必须有服务端并发、速率、滚动用量和滥用保护。

## Done Definition

- [x] 有效登录态可为当前组织/设备换取短期、最小权限的模型网关 Token。
- [x] 过期、跨组织、错误设备、audience 或 scope 的 Token 均被拒绝且错误结构稳定。
- [x] 登出或组织切换后不能继续签发旧组织 Token，既有 Token 按确定的撤销/短过期语义失效。
- [x] 模型目录只返回组织可用模型并正确声明图片、工具和推理能力。
- [x] Responses/SSE 的文本、工具、reasoning、单图/多图、usage、401/429/5xx 契约测试通过。
- [x] 用量保护和审计不记录 Prompt、模型正文或凭据。
- [x] Server/type packages 的 typecheck、测试和 `git diff --check` 通过。

## 执行快照

**中断时间**：不适用（已完成）  
**已完成文件**：Desktop types/Main client；`/Applications/work/jugglework-server` 的 Codex 控制路由、短期 Token、模型目录、Responses/SSE usage、scope、限流及测试。  
**未完成文件**：无。真实部署凭据的外部冒烟保留到 TASK-010 发布验收。  
**当前卡点**：无。  
**下一步行动**：TASK-004 将 Main-only token provider 接入 loopback Credential Broker，Codex 子进程只持有本地 secret。  
**关键决策记录**：复用 OpenCode 的登录态、活动组织与组织 Provider 授权语义；`providerId` 必须是组织 Provider 实例 ID，而不是目录键。Codex Token 固定短 TTL、source 和 Responses/models scope；切组织由 Main 立即清缓存，服务端按短过期收敛。

## 变更历史

| 版本 | 时间 | 触发原因 | 变更文件 | 变更类型 | 影响的下游任务 |
| --- | --- | --- | --- | --- | --- |
| v1 | 2026-08-12 | 开始执行并核对 OpenCode 调用链 | types、Desktop Main token provider、测试 | 新增 | TASK-004 使用冻结后的 provider 接口 |
| v2 | 2026-08-12 | 用户提供正确 Server 仓库 | Server token/models/Responses/usage/limits + Desktop catalog loader | 完成 | TASK-004、TASK-008 契约已验证 |
