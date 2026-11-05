# Spec Delta

## Purpose

定义组织内部团队日历的共享、四级角色、成员有效性与撤权传播契约，使 Desktop 和 Agent 在多端协作中遵守同一套最小权限和隐私边界。

## ADDED Requirements

### Requirement: Organization-scoped team calendars
系统 SHALL 仅允许在一个组织内创建和共享团队日历。创建者 MUST 是该组织的有效成员，团队日历 MUST 绑定该组织，并且任何成员、权限或内容操作 MUST 拒绝跨组织主体及外部联系人。

#### Scenario: Active member creates a team calendar
- **WHEN** 一个有效组织成员创建团队日历
- **THEN** 系统在该组织内创建日历，并将创建者设为初始 `manager`

#### Scenario: Cross-organization member is supplied
- **WHEN** 调用方尝试把其他组织成员或外部联系人加入团队日历
- **THEN** 系统拒绝操作，且不创建成员关系或泄露目标日历信息

### Requirement: Four-level calendar roles
团队日历成员角色 SHALL 为 `free-busy`、`viewer`、`editor`、`manager`，权限依次包含前一级能力。`free-busy` 只能读取忙闲区间，`viewer` 可读取获授权日程详情，`editor` 可管理日历内日程，`manager` 还可管理日历设置、成员和角色。

#### Scenario: Free-busy member requests event details
- **WHEN** `free-busy` 成员请求团队日历的日程列表、搜索结果或单项详情
- **THEN** 系统仅返回被占用的时间区间和必要的不透明标识，不返回标题、描述、地点、参与人、创建者、附件、提醒或其他详情字段

#### Scenario: Viewer attempts to change an event
- **WHEN** `viewer` 成员尝试创建、修改、移动或删除团队日历中的日程
- **THEN** 系统拒绝写入且日程版本不变

#### Scenario: Editor changes an event
- **WHEN** `editor` 成员以当前版本修改团队日历中的日程
- **THEN** 系统保存修改并产生可供其他获授权客户端同步的变更

#### Scenario: Manager changes membership
- **WHEN** `manager` 为有效组织成员授予或调整团队日历角色
- **THEN** 系统保存新的成员授权并发布权限变更，而不是把该成员自动加入任一日程的参与人列表

### Requirement: Default-deny authorization
团队日历的发现、查询、搜索、订阅、同步、缓存读取和写入 SHALL 在服务端按当前组织成员身份和日历角色逐次授权。缺少明确授权、身份失效、租户不匹配或角色不能满足操作时 MUST 默认拒绝，客户端状态不得扩大服务端权限。

#### Scenario: User has no calendar membership
- **WHEN** 有效组织成员通过已知日历 ID 查询未授权团队日历
- **THEN** 系统返回不暴露日历是否存在的拒绝结果，且不返回元数据、内容、成员或变更游标

#### Scenario: Stale client claims a higher role
- **WHEN** 客户端缓存仍显示旧的较高角色，但服务端当前角色不足以执行请求
- **THEN** 系统按当前服务端角色拒绝请求，并指示客户端刷新授权状态

#### Scenario: Batched query mixes authorized and unauthorized calendars
- **WHEN** 一个范围查询或搜索同时命中有权和无权访问的日历
- **THEN** 系统只返回调用方当前获授权且经过角色字段过滤的结果，不以计数、排序占位或错误明细暴露被过滤对象

### Requirement: Field-level privacy filtering
系统 SHALL 在数据离开授权边界前按角色构造响应与同步记录，不得依赖 Desktop 或 Agent 隐藏敏感字段。降级后的角色 MUST 立即适用更严格投影，日志、通知预览和冲突响应也 MUST 遵循相同字段遮蔽规则。

#### Scenario: Viewer is downgraded to free-busy
- **WHEN** 成员从 `viewer` 降级为 `free-busy` 后再次查询或同步
- **THEN** 新响应只包含忙闲区间，并明确使客户端清除先前缓存的详情字段

#### Scenario: Free-busy member receives a calendar notification
- **WHEN** 团队日历日程发生变化且 `free-busy` 成员需要接收刷新提示
- **THEN** 通知仅说明可用性发生变化，不包含日程标题、描述、地点或参与人

#### Scenario: Unauthorized write conflicts with a newer version
- **WHEN** 已失去写权限的调用方提交基于旧版本的修改
- **THEN** 系统优先返回权限拒绝，不在冲突响应中泄露当前版本或当前字段值

### Requirement: Current organization membership is mandatory
日历成员授权 SHALL 仅对当前有效的组织成员生效。系统 MUST 在授予权限及每次访问时校验成员有效性；成员离职、停用、移出组织或组织切换后，原授权不得继续生效。

#### Scenario: Manager grants access to an inactive member
- **WHEN** `manager` 尝试把已停用或已移出组织的主体加入团队日历
- **THEN** 系统拒绝授权且不创建待生效成员记录

#### Scenario: Organization membership becomes invalid
- **WHEN** 已获授权成员被停用或移出组织
- **THEN** 系统将其所有该组织团队日历授权视为失效，并触发与显式撤权相同的同步和缓存清理流程

#### Scenario: Member is later reactivated
- **WHEN** 一个已失效成员重新成为组织有效成员
- **THEN** 系统不会自动恢复历史团队日历授权，必须由 `manager` 重新显式授予

### Requirement: Membership and attendance are independent
日历成员关系与日程参与人关系 SHALL 使用独立生命周期和权限判断。授予、调整或撤销日历角色不得隐式创建、修改或删除参与人；邀请、响应或移除参与人也不得改变日历成员角色。

#### Scenario: Calendar member is not an attendee
- **WHEN** 一个成员获得团队日历 `viewer` 权限但未被邀请参加某日程
- **THEN** 该成员可以按角色查看日程，但参与人列表和响应统计中不存在该成员

#### Scenario: Attendee loses calendar membership
- **WHEN** 一个受邀参与人被撤销团队日历成员权限
- **THEN** 系统保留其独立参与人记录及可响应邀请的最小访问，除非组织成员也失效或组织者另行移除该参与人

### Requirement: Safe membership administration
只有 `manager` SHALL 能管理团队日历成员、角色和共享设置。系统 MUST 防止删除或降级最后一个有效 `manager`，并以版本化、幂等方式处理并发管理操作。

#### Scenario: Last manager is removed
- **WHEN** 调用方尝试移除或降级团队日历最后一个有效 `manager`
- **THEN** 系统拒绝操作并保持原管理关系

#### Scenario: Two managers update the same member concurrently
- **WHEN** 两个 `manager` 基于同一成员版本提交不同角色变更
- **THEN** 系统只接受一个变更，另一个收到不含敏感数据的版本冲突并可重新读取当前授权

#### Scenario: Membership request is retried
- **WHEN** 客户端以同一幂等键重试同一成员授权变更
- **THEN** 系统返回同一结果且不重复产生授权事件或用户通知

### Requirement: Revocation takes effect across all read paths
成员被移除、降级或失效后，系统 SHALL 立即以新的权限状态处理详情查询、范围查询、搜索、导出、通知读取和增量同步。任何尚未处理的旧权限通知 MUST 在投递或打开时重新过滤或撤销。

#### Scenario: Revoked member performs a direct query
- **WHEN** 已撤权成员使用已知事件 ID 或旧链接读取团队日历日程
- **THEN** 系统拒绝访问且不返回缓存版本、删除状态或当前版本信息

#### Scenario: Revocation races with notification delivery
- **WHEN** 一条包含日程详情的通知已排队但收件人在投递前被降级为 `free-busy` 或被撤权
- **THEN** 系统在投递时重新授权，降级为隐私安全提示或取消投递

#### Scenario: Revoked member resumes from an old sync cursor
- **WHEN** 已撤权成员用撤权前游标请求增量同步
- **THEN** 系统不返回撤权后的内容变更，并返回权限失效信号以驱动本地清除该日历及其敏感缓存

### Requirement: Permission-aware cache invalidation and multi-device sync
授权变更 SHALL 产生组织与成员范围内有序、可重放的权限事件。每个在线设备 MUST 最终收到角色变更或撤权信号；离线设备下次同步时 MUST 在展示旧数据前验证权限，并删除超出当前权限的详情、搜索索引、通知预览和派生缓存。

#### Scenario: User is revoked while two devices are online
- **WHEN** 一个 `manager` 撤销某成员权限且该成员有两个在线 Desktop 客户端
- **THEN** 两端都停止展示该日历，清除敏感缓存，并使进行中的详情或编辑界面进入无权访问状态

#### Scenario: Revoked device reconnects after being offline
- **WHEN** 撤权期间离线的设备重新联网
- **THEN** 设备在允许读取旧缓存前完成授权检查，清除失效日历数据，并且不短暂展示旧详情

#### Scenario: Role is downgraded without full revocation
- **WHEN** 成员从 `editor` 降级为 `viewer` 或 `free-busy`
- **THEN** 所有设备撤销不再具备的写入能力，并按新角色重建或裁剪本地投影

### Requirement: Desktop and Agent authorization parity
Desktop UI、后台同步与 Agent 日历能力 SHALL 调用同一服务端授权和字段投影契约。Agent 不得因会话、工具授权、工作区权限或模型能力获得高于当前组织成员及日历角色的访问。

#### Scenario: Agent acts for a viewer
- **WHEN** `viewer` 要求 Agent 修改团队日历日程
- **THEN** Agent 操作被拒绝，与 Desktop 中同一修改的结果一致

#### Scenario: Agent acts for a free-busy member
- **WHEN** `free-busy` 成员要求 Agent 总结团队日历安排
- **THEN** Agent 只能使用忙闲区间回答，不接收或推断标题、描述、地点与参与人详情

#### Scenario: Permission changes during an Agent confirmation flow
- **WHEN** Agent 预览操作后、用户确认前，调用方角色被降级或撤销
- **THEN** 最终执行重新鉴权并拒绝超出新角色的操作，而不是沿用预览时权限

### Requirement: Auditable permission changes
系统 SHALL 为团队日历创建、成员授予、角色变更、撤权和成员失效记录组织范围审计事件，包含操作者、目标成员、前后角色、日历、时间和结果，但不得在审计摘要中复制日程敏感字段。

#### Scenario: Manager revokes a member
- **WHEN** `manager` 成功撤销一个成员的团队日历权限
- **THEN** 系统记录可由组织授权管理员追溯的撤权事件，并关联用于多端失效的权限版本

#### Scenario: Unauthorized membership change is attempted
- **WHEN** 非 `manager` 尝试修改日历成员
- **THEN** 系统记录不含日程详情的拒绝审计结果且不改变成员关系
