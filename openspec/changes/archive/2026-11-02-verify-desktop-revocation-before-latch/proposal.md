## Why

生产事故（2026-09-03）：海外服务端从未执行撤销（设备行 enrolled、审计零撤销事件），但桌面端远程控制在昨晚 02:35 永久闩锁「已撤销」并自毁本地凭据（`desktop-remote-control-credentials.json` 被删除、设置被禁用）。根因是客户端把服务端连接层的 `device.revoked` / `device_revoked` 协议错误 / token 签发 404 一律当作权威撤销，立即不可逆地删除凭据、禁用远程控制——任何一次伪信号（服务端簿记竞态、瞬时错误、错误环境）都会让用户被锁在门外，只能重新注册。服务端配套变更（jugglework-server `fix-desktop-agent-revocation-signaling`）消除伪信号源，本变更为客户端加上第二层防线：**撤销必须经服务器权威确认后才允许不可逆的本地自毁**。

## What Changes

- 已认证 WebSocket 上的 `device.revoked` 信封直接作为权威撤销终态；`protocol.error(device_revoked)` 与 token/challenge HTTP 拒绝仍先以设备身份做一次**权威状态核验**
- 核验结果分级：匹配凭据的 challenge 或有效签名后的 token exchange 明确返回 `device_revoked` → 维持现有永久闩锁行为（删凭据、禁用设置、通知用户）；挑战/token 签发成功 → 设备仍 enrolled/enabled，直接使用新 token 重连；明确 `device_disabled` → 走可逆停用路径
- 核验不可用（网络错误、5xx）→ 按可重试处理并限频重试，fail-open 到重连路径而不是自毁
- 正向核验复用设备凭据的挑战/token 签发；通用 401/404 无法区分凭据/成员失效、删除、路由缺失或错误环境，因此一律不得作为不可逆清理依据。连续通用 404 探测有界，随后保留凭据、停用本地连接并明确要求重新注册
- 状态面板对"核验中/信号待确认"给出区分展示，避免用户看到伪「已撤销」
- 不改变真实撤销的最终权限与自毁语义；不改变 `device.disabled` 可逆停用与 `credentials_context_mismatch` 清理路径

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `desktop-remote-control-lifecycle`: 新增「云端撤销信号须权威核验后才可触发不可逆本地状态」需求；与既有「Cloud suspension is retryable」「Re-registration fails closed and remains retryable」形成可重试/不可逆对称语义。

## Impact

- 影响面：`apps/desktop/electron/remote-control-agent.mjs`（revoked 闩锁三处触发点的核验前置）、`remote-control-cloud-client.mjs`（核验调用与错误分类）、`desktop-remote-control-section.tsx`（状态展示）与对应测试
- 兼容性：与未升级服务端组合时，挑战/token 探测只能证明"签发成功=设备健在"；通用拒绝保持未决并限频重试，不会误自毁。已认证 WS `device.revoked` 仍按传输权威性直接生效
- 风险：未升级服务端若只返回通用拒绝，客户端会保持凭据但立即清会话、撤销授权且无法重新认证，不扩大访问权限；连续 404 最终要求重新注册。核验限频需防失效设备形成探测风暴
