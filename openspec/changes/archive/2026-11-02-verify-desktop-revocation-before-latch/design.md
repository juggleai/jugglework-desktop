## Context

- `apps/desktop/electron/remote-control-agent.mjs` 中有三处置 `revoked = true` 并执行不可逆清理（删凭据、禁设置、清 E2EE）：`device.revoked` 信封、`protocol.error` code 为 `device_revoked`、token 签发 HTTP 404（`lastErrorCode: "device_deleted"`）。
- 服务端权威状态源是 `desktop_devices` 行。配套服务端契约只在 challenge 匹配持久化 `(deviceId, keyId)`，或 token exchange 已验证绑定 challenge 的 Ed25519 签名后，返回明确 `device_revoked`/`device_disabled`。签发成功证明设备健在且 enabled；通用 401/404 仍可能表示无效 proof、凭据/成员失效、删除、路由缺失或错误环境，不具权威性。
- 既有对称语义：`device.disabled` 可逆（保留凭据、退避重连）；`credentials_context_mismatch` 清理是本地账号上下文切换，不属云端信号。
- 状态面板 `desktop-remote-control-section.tsx` 的 `statusPresentation` 以 `status.revoked || state === "revoked"` 显示「已撤销」。

## Goals / Non-Goals

**Goals:**
- 撤销触发统一进入一个权威入口：已认证 WS 信封直接确认；其他路径仅由匹配凭据的明确 `device_revoked` 才走不可逆清理
- 核验失败（网络/5xx）fail-open 到可重试路径，绝不自毁
- 核验探测限频，通用 not-found 的探测次数有界
- UI 区分「已撤销」（确认）与「核验中」（未决），不再把未决渲染成已撤销
- 对未升级服务端保持只增安全性：成功核验无需新 API；模糊拒绝保持未决，不误自毁

**Non-Goals:**
- 不新增依赖用户会话的核验接口（核验只用设备凭据可完成的调用）
- 不改服务端信令（由 jugglework-server `fix-desktop-agent-revocation-signaling` 负责）
- 不改 `device.disabled`、`credentials_context_mismatch`、重注册（replace identity）路径
- 不做撤销恢复功能（撤销后依旧只能重新注册）

## Decisions

1. **权威层级。** 已认证 WebSocket 的 `device.revoked` 由服务端撤销事务成功后通过当前设备连接下发，直接终态清理。其他撤销提示以设备凭据走 challenge→token 核验：匹配 `(deviceId, keyId)` 的 challenge 可明确返回 `device_revoked`/`device_disabled`；token exchange 只有在验证有效签名后才可返回同样状态。成功签发即设备健在且 enabled，并直接复用新 token。裸/通用 401、404、网络、5xx、`not_found` 与 `device_deleted` 均非权威，不触发自毁。
   - 删除会级联删除服务端公钥凭据，服务端已无法验证请求持有被删身份，因此不存在安全的 `device_deleted` 证明；错误环境/路由也可能返回相同 404。客户端保留本地凭据，连续 3 次通用 404 后停止探测、持久化关闭本地设置并展示重新注册入口。
2. **状态机插入 `verifying_revocation` 中间态。** 收到撤销类信号 → 置中间态、清活跃会话与授权（保守）→ 探针确认 → 走 revoked 不可逆清理或回到退避重连。中间态对 IPC status 暴露 `revocationPending: true`，UI 渲染「核验中」而非「已撤销」。
3. **限频与终止。** 探针失败（含模糊 401、网络/5xx）按独立指数退避重试且封顶周期（默认上限 5 分钟）；连续通用 404 最多探测 3 次，之后以 `device_reregistration_required` 停止调度并保留凭据；明确 `device_revoked` 即终止一切后续调度。未决使用 `revocation_unconfirmed`。
4. **不可逆清理动作集中在单一函数。** 各触发点收敛到同一个 `confirmAndApplyRevocation(source, authoritative)` 入口；权威 WS 跳过探针，其他路径先核验，避免路径间行为漂移。
5. **测试策略。** electron 层以 `.test.mjs` 单测驱动：伪信令+健在设备→不自毁；确认撤销→清理且停调度；探针不可用→退避且 UI 未决；disabled 设备→可逆路径。不发新协议、不依赖真实服务端。

## Risks / Trade-offs

- 探针成功即直接重连，可能在服务端真有问题（如信令 bug 未修）时掩盖故障——通过日志与 `revocationPending` 计数暴露伪信令频率，为服务端修复提供观测数据
- 明确状态支持上线后，真实撤销多一次探针往返才自毁，窗口内控制会话已被清空，无安全放大
- 未升级服务端 + 设备真被撤销：探针只返回模糊 401，客户端不做永久本地清理，但已停止控制并且服务端拒绝新 token；需要跨仓库明确状态支持才能完成 revoked 闩锁
