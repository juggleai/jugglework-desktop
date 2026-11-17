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

### Requirement: Chat loading always ends its spinner
聊天初始化与会话加载 SHALL 在脚本加载、SDK 建连和会话请求上设置有限等待；任一步骤失败、超时或来源失效时 MUST 结束 loading 状态并展示可操作错误，不得无限骨架屏或永久停留在"正在初始化"。

#### Scenario: IM connection never settles
- **WHEN** WebSocket 一直停在连接中，或 vendor 脚本标签已存在但尚未就绪
- **THEN** 到达等待上限后结束转圈，显示超时错误并提供重连入口

#### Scenario: A pending conversation load is retried
- **WHEN** 上一次会话加载超过等待上限仍未结束，用户重进消息页或触发刷新
- **THEN** 发起新的加载请求，旧请求的迟到结果不覆盖新结果
