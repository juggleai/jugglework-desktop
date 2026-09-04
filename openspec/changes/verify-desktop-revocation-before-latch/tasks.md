## 1. 触发点收敛与核验前置

- [x] 1.1 在 `remote-control-agent.mjs` 中把 revoked 触发收敛到单一入口：已认证 `device.revoked` 直接权威清理；`protocol.error(device_revoked)` 与 token/challenge 拒绝先核验
- [x] 1.2 实现核验探针：复用挑战→token 签发链路；结果映射为 `healthy`（签发成功）/ `revoked`（匹配凭据的明确 `device_revoked`）/ `disabled` / `unavailable`（含模糊 401/404、网络/5xx）；`device_deleted` 不作为权威证明
- [x] 1.3 对非权威撤销信号插入 `verifying_revocation` 中间态：清活跃控制会话与授权，但保留凭据、设置与 enrollment，等待核验结论
- [x] 1.4 已认证 WS 或核验明确确认为撤销时执行既有不可逆清理（清授权、删凭据、删 E2EE 密钥、禁用设置、置 revoked 终态、通知用户），并终止一切后续调度

## 2. 退避、限频与终态

- [x] 2.1 核验 `unavailable` 时按指数退避重试（封顶默认 5 分钟）；通用 404 最多探测 3 次后保留凭据、关闭设置并要求重新注册；状态不闩锁 revoked
- [x] 2.2 探针成功（healthy）时直接用新 token 进入重连；伪信令计数写入日志（含来源 code），便于观测服务端信令质量
- [x] 2.3 核验结论为 enrolled 但 disabled 时，走既有 `device.disabled` 可逆退避路径，不闩锁
- [x] 2.4 确认撤销后不再发起任何探针/重连（终态语义与现状一致）

## 3. 状态展示

- [x] 3.1 IPC status 增加 `revocationPending`（或等价字段），`packages/types/src/desktop-ipc.ts` 的 `DesktopRemoteControlAgentStatus` 同步扩展
- [x] 3.2 `desktop-remote-control-section.tsx` 的 `statusPresentation`：「核验中」未决态展示为中性/警示样式与文案（中英 i18n），确认撤销才显示「已撤销」错误样式

## 4. 测试与联调

- [x] 4.1 单测（remote-control-agent.test.mjs）：伪信令+健在设备 → 不自毁、使用探针 token 重连、UI 不显示已撤销
- [x] 4.2 单测：明确确认撤销 → 清理齐全且停调度；模糊 401/404 与 `device_deleted` → 不得确认或删凭据
- [x] 4.3 单测：探针不可用 → 退避限频、凭据保留、状态未决；明确 disabled → 可逆路径
- [x] 4.4 状态快照/IPC 契约测试更新（类型与渲染快照）
- [x] 4.5 与服务端完成源码契约联调与两侧聚焦测试：已认证 WS 撤销终态；匹配凭据 challenge/token 明确 revoked/disabled；伪 protocol revoked 健康恢复；deleted/generic 404 保留凭据且有界要求重新注册（真实部署环境观察仍未完成）

## 5. 验证与发布

- [x] 5.1 `apps/desktop` electron 全量测试、Electron/app typecheck 与本变更相关 app 测试全绿
- [ ] 5.2 手工验证矩阵：正常连接、手动停用/启用、控制台撤销、控制台禁用→恢复、断网恢复，各场景凭据/设置/状态符合规范
