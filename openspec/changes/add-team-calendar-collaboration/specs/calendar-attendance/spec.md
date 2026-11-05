# Spec Delta

## Purpose

定义组织内部日程参与人的邀请、响应、更新、取消与重复实例范围，使参与人生命周期独立于日历共享成员并在多端保持一致、可审计。

## ADDED Requirements

### Requirement: Organization-internal attendee model
日程参与人 SHALL 是与日历成员独立的记录，并绑定日程、组织内有效成员、参与角色与响应状态。本能力 MUST 拒绝外部联系人、跨组织主体和任意邮箱占位；成为参与人不得自动获得所属日历的共享角色。

#### Scenario: Organizer invites an active organization member
- **WHEN** 有权编辑日程的组织成员邀请同组织的有效成员
- **THEN** 系统创建独立参与人记录，其初始响应为 `needs-action`，且不创建或提升日历成员权限

#### Scenario: Organizer invites an external contact
- **WHEN** 组织者提交外部邮箱、其他组织成员或无有效组织成员身份的主体
- **THEN** 系统拒绝该参与人且不发送邀请

#### Scenario: Calendar viewer is added as attendee
- **WHEN** 一个已有 `viewer` 日历角色的成员被加入某日程参与人
- **THEN** 系统保留其 `viewer` 角色不变，并另行创建参与人记录

### Requirement: Organizer authority and attendee self-service
有权编辑日程的 `editor` 或 `manager` SHALL 能添加和移除参与人、更新邀请内容或取消日程。普通参与人 SHALL 只能读取其邀请所需的允许字段并修改自己的响应，不得修改他人响应、参与人名单或日程内容。

#### Scenario: Attendee changes another attendee response
- **WHEN** 普通参与人尝试代表另一参与人接受、拒绝或标记待定
- **THEN** 系统拒绝操作且双方响应均不改变

#### Scenario: Calendar editor manages attendees
- **WHEN** `editor` 在其可编辑团队日历日程中添加或移除有效组织成员
- **THEN** 系统更新参与人集合并产生相应邀请或取消通知

#### Scenario: Revoked calendar member responds to an existing invitation
- **WHEN** 仍是有效组织成员的参与人失去日历共享权限后响应已有邀请
- **THEN** 系统允许其通过参与人身份修改自己的响应，但只暴露完成邀请决策所需且经策略允许的日程字段

### Requirement: Invitation response lifecycle
每个参与人响应 SHALL 为 `needs-action`、`accepted`、`declined` 或 `tentative`。参与人 MUST 能从当前状态切换到接受、拒绝或待定；重复请求 SHALL 幂等，成功变更 SHALL 形成版本化响应并同步到组织者和该参与人的设备。

#### Scenario: Attendee accepts an invitation
- **WHEN** 参与人对当前邀请版本选择接受
- **THEN** 系统将该参与人的响应设为 `accepted`，记录响应时间，并向组织者同步最新状态

#### Scenario: Attendee marks an invitation tentative
- **WHEN** 参与人选择待定
- **THEN** 系统将状态设为 `tentative`，且不把它解释为接受或拒绝

#### Scenario: Response is retried with the same idempotency key
- **WHEN** 客户端重试已成功的相同响应请求
- **THEN** 系统返回原结果且不重复发送响应通知

#### Scenario: Two devices respond concurrently
- **WHEN** 同一参与人的两个设备基于同一响应版本分别提交不同状态
- **THEN** 系统只接受一个写入，另一个收到当前状态和新版本的冲突结果，不覆盖已接受写入

### Requirement: Invitation delivery and pending state
新增参与人 SHALL 生成可追踪的邀请通知，并在参与人处理前保持 `needs-action`。通知和邀请列表 MUST 支持多端去重与已读同步；通知投递失败不得回滚参与人记录，但 SHALL 形成可重试投递状态。

#### Scenario: New attendee is added
- **WHEN** 日程写入成功并新增一个组织内参与人
- **THEN** 该参与人在邀请列表中看到一条待响应邀请，并至多收到一条逻辑邀请通知

#### Scenario: Invitee is offline during delivery
- **WHEN** 邀请创建时参与人的所有设备均离线
- **THEN** 系统保留待响应邀请和可重试通知，参与人下次同步后可见且不会因重试产生多个参与人记录

#### Scenario: Invitation is read on one device
- **WHEN** 参与人在一个设备上打开或标记邀请为已读
- **THEN** 已读状态同步到该参与人的其他设备，但不改变邀请响应

### Requirement: Material update notifications
已邀请日程的时间、时区、重复规则、标题、地点或组织者定义的关键内容发生实质更新时，系统 SHALL 向仍有效的参与人产生去重更新通知。参与人响应默认保持不变；时间或重复范围变化 MUST 明确标记需要重新确认，而不得悄然把旧响应当作新安排的确认。

#### Scenario: Event title changes
- **WHEN** 组织者只修改已邀请日程的标题
- **THEN** 系统保留参与人响应，并发送包含当前可见字段的更新通知

#### Scenario: Event time changes after acceptance
- **WHEN** 组织者修改一个已有 `accepted` 参与人的日程开始或结束时间
- **THEN** 系统保留历史响应供审计、将当前邀请标记为需要重新确认，并发送时间变更通知

#### Scenario: Attendee lacks calendar detail permission
- **WHEN** 一个仅凭参与人身份访问的成员收到更新通知
- **THEN** 通知只包含邀请决策所需且被参与人策略允许的字段，不授予日历范围查询或搜索能力

### Requirement: Cancellation and attendee removal notifications
取消受邀日程或从日程移除参与人 SHALL 产生不可恢复为活动邀请的取消状态，并通知受影响参与人。取消操作 MUST 幂等；撤权、成员失效或字段遮蔽发生在投递前时，通知 MUST 重新鉴权并最小化内容。

#### Scenario: Organizer cancels an invited event
- **WHEN** 组织者取消包含参与人的日程
- **THEN** 所有仍有效参与人的邀请标记为已取消，后续响应被拒绝，并收到去重取消通知

#### Scenario: One attendee is removed
- **WHEN** 组织者只从活动日程移除一个参与人
- **THEN** 该参与人的邀请被取消并收到移除通知，其他参与人的记录与响应不变

#### Scenario: Cancellation request is retried
- **WHEN** 客户端用同一幂等键重试已成功的取消操作
- **THEN** 系统返回原结果且不产生重复取消通知

### Requirement: Recurring attendance scope
对重复日程添加或移除参与人、更新邀请或取消邀请时，调用方 MUST 显式选择 `this-instance` 或 `entire-series` 范围。本阶段 MUST 拒绝 `this-and-following`。实例级参与人和响应 SHALL 覆盖该实例而不改写系列其他实例。

#### Scenario: Attendee is added to one occurrence
- **WHEN** 组织者以 `this-instance` 范围把成员加入某个重复实例
- **THEN** 只有该实例创建参与人邀请，系列其他实例的参与人集合不变

#### Scenario: Attendee is added to the entire series
- **WHEN** 组织者以 `entire-series` 范围添加参与人
- **THEN** 参与人适用于系列及其未来生成实例，但已有显式实例例外保持其覆盖语义

#### Scenario: Attendee responds to one occurrence
- **WHEN** 参与人对某重复实例以 `this-instance` 范围接受、拒绝或待定
- **THEN** 该响应只作用于目标实例，不改变系列默认响应或其他实例响应

#### Scenario: Unsupported following scope is requested
- **WHEN** 调用方对参与人变更或响应请求 `this-and-following`
- **THEN** 系统拒绝请求并明确仅支持单次实例或整个系列

### Requirement: Recurring update and cancellation notifications
重复日程更新或取消通知 SHALL 标识其作用范围与受影响实例。系列级变更 MUST 与实例例外合并后计算实际影响，避免向不受影响参与人发送通知或将单实例取消误报为整个系列取消。

#### Scenario: One occurrence time changes
- **WHEN** 组织者只调整某个重复实例的时间
- **THEN** 该实例的参与人收到单实例更新通知，其他实例不产生更新通知

#### Scenario: Entire series is cancelled
- **WHEN** 组织者取消整个重复系列
- **THEN** 所有未结束且仍活动的受邀实例转为取消，并以可去重的系列取消通知告知参与人

#### Scenario: One occurrence is cancelled
- **WHEN** 组织者取消一个重复实例
- **THEN** 只有该实例邀请被取消，参与人仍可访问系列中其他活动邀请

### Requirement: Organization membership validity for attendance
参与人必须持续是事件组织的有效成员。成员停用、离职或移出组织后，系统 SHALL 阻止新邀请和新响应、使其活动参与资格失效，并对组织者同步该状态；成员恢复时不得自动恢复已失效邀请。

#### Scenario: Invitee leaves the organization before responding
- **WHEN** `needs-action` 参与人在响应前失去组织成员资格
- **THEN** 系统使参与资格失效、拒绝后续响应，并向组织者同步成员已失效而非普通拒绝

#### Scenario: Accepted attendee becomes inactive
- **WHEN** 已接受参与人在日程开始前被组织停用
- **THEN** 系统不再把其计为有效参与人，并撤销其邀请访问与待投递详情通知

#### Scenario: Former attendee rejoins the organization
- **WHEN** 已失效参与人之后重新加入组织
- **THEN** 历史邀请不会自动恢复，组织者必须重新显式邀请

### Requirement: Attendance visibility and privacy
参与人列表、响应状态和响应统计 SHALL 只向按日历角色或参与人策略获授权的主体开放。忙闲查询不得携带参与人身份或响应；无权主体不得通过响应计数、通知或冲突错误推断参与人。

#### Scenario: Free-busy member queries an invited event
- **WHEN** 非参与人的 `free-busy` 日历成员查询包含邀请的时间段
- **THEN** 系统只返回忙闲区间，不返回参与人、响应状态或参与人数

#### Scenario: Attendee views invitation details
- **WHEN** 有效参与人打开自己的邀请
- **THEN** 系统返回被邀请者决策所需字段和其自身响应，并仅在策略允许时返回其他参与人及其响应

#### Scenario: Unauthorized user guesses attendee identifier
- **WHEN** 无权主体使用已知参与人记录 ID 查询响应
- **THEN** 系统返回不泄露记录存在性的拒绝结果

### Requirement: Attendance change synchronization
邀请、响应、移除、更新和取消 SHALL 产生版本化增量变更，并同步到组织者与受影响参与人的在线和离线设备。各设备 MUST 按服务端版本收敛，且通知已读状态不得覆盖更新的邀请响应或取消状态。

#### Scenario: Attendee responds on mobile-equivalent second client
- **WHEN** 参与人在一个客户端接受邀请而另一个 Desktop 客户端在线
- **THEN** 另一个客户端更新为 `accepted`，不再展示待响应操作

#### Scenario: Offline organizer reconnects
- **WHEN** 参与人响应期间组织者设备离线并随后恢复同步
- **THEN** 组织者设备通过增量变更获得最新响应，且不会把本地旧状态写回覆盖

#### Scenario: Cancellation races with acceptance
- **WHEN** 组织者取消日程与参与人接受旧邀请并发发生
- **THEN** 取消后的邀请不可被重新激活，接受请求失败或收敛为已取消状态

### Requirement: Desktop and Agent attendance parity
Desktop 与 Agent SHALL 使用相同的参与人授权、范围、版本、幂等和组织成员校验。Agent 对邀请、移除、批量更新或取消等高影响操作 MUST 先展示参与人及作用范围并取得确认，执行时重新鉴权。

#### Scenario: Agent invites an organization member
- **WHEN** 有权编辑日程的用户要求 Agent 添加参与人并确认预览
- **THEN** Agent 通过同一参与人写入契约创建邀请，结果与 Desktop 操作一致

#### Scenario: Agent attempts an external invitation
- **WHEN** 用户要求 Agent 邀请没有本组织有效成员身份的联系人
- **THEN** Agent 拒绝该请求且不尝试以邮箱或自由文本绕过组织范围

#### Scenario: Agent updates an entire recurring series
- **WHEN** 用户要求 Agent 修改重复日程参与人但未说明实例范围
- **THEN** Agent 要求选择 `this-instance` 或 `entire-series`，不得自行推断或使用不支持的范围
