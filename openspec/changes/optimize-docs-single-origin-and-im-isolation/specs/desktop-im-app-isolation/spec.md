## ADDED Requirements

### Requirement: Ordinary chat reuses existing AppKey isolation without Docs classification
Desktop SHALL 直接使用当前组织既有 AppKey 连接，移除分类前置及整群过滤，复用现有 scope／epoch／在途加载，不重建服务端 AppKey 或客户端隔离系统。

#### Scenario: Docs is disabled or unavailable
- **WHEN** Docs 关闭、宕机或旧分类接口失败
- **THEN** 普通会话加载、收发、历史及未读正常，分类请求数为 0

#### Scenario: Organization changes while an old callback is pending
- **WHEN** 用户切换至不同 AppKey 的组织，旧回调随后到达
- **THEN** 现有范围检查拒绝旧结果，不显示旧应用缓存或借用旧凭据

### Requirement: Docs actions retain existing validation independently of chat loading
Docs 卡片 SHALL 复用现有解析与接收来源绑定，只移除分类上下文依赖；点击 SHALL 继续使用既有事件／会话验证及 Docs 授权。

#### Scenario: A forged or forwarded card arrives
- **WHEN** 卡片不符合当前连接来源或真实事件会话
- **THEN** 卡片兜底或打开被拒，普通群与未读不受影响
