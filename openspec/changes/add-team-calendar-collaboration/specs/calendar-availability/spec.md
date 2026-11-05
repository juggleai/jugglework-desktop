# Spec Delta

## Purpose

定义组织内部隐私安全的忙闲查询、排期冲突提示和共同可用时间建议，在支持团队协调的同时把信息披露限制为必要的时间区间。

## ADDED Requirements

### Requirement: Organization-internal availability subjects
忙闲与共同可用时间查询 SHALL 只接受调用方所在组织的当前有效成员和获授权团队日历作为查询主体。系统 MUST 拒绝跨组织成员、外部联系人、任意邮箱、会议室及其他资源，并不得以部分结果泄露无效主体状态。

#### Scenario: User queries colleagues in the same organization
- **WHEN** 有效组织成员查询一组同组织有效成员在给定范围内的可用性
- **THEN** 系统按每个主体的当前授权返回隐私安全的忙闲结果

#### Scenario: Query includes an external address
- **WHEN** 查询主体包含外部联系人、其他组织成员或任意邮箱
- **THEN** 系统拒绝该主体且不尝试外部同步或目录解析

#### Scenario: Query includes a room resource
- **WHEN** 调用方把会议室或其他组织资源作为可用性主体
- **THEN** 系统拒绝该查询，因为本能力仅处理组织成员和获授权日历

### Requirement: Busy intervals are the maximum free-busy disclosure
对仅有 `free-busy` 权限的查询，系统 SHALL 最多返回标准化的忙碌开始、结束和忙碌状态。结果 MUST 排除日历 ID、日程 ID、标题、描述、地点、参与人、组织者、响应、重复规则、提醒及可关联到具体日程的稳定标识。

#### Scenario: Free-busy query overlaps a private event
- **WHEN** 调用方仅有忙闲权限且查询范围覆盖一条私密日程
- **THEN** 系统返回合并后的忙碌区间，不返回任何日程详情或可用于再次查询该日程的标识

#### Scenario: Adjacent busy events are queried
- **WHEN** 同一主体在查询范围内有相邻或重叠的多个忙碌日程
- **THEN** 系统可以合并为最小必要区间，避免通过区间边界推断日程数量

#### Scenario: Detailed viewer uses free-busy endpoint
- **WHEN** 具有 `viewer` 或更高权限的调用方使用忙闲接口
- **THEN** 该接口仍只返回忙闲区间，不因更高角色附带日程详情

### Requirement: Default-deny availability authorization
系统 SHALL 对每个查询主体、日历和时间范围在服务端独立鉴权，未明确允许的结果 MUST 默认拒绝。批量查询不得因一个获授权主体而扩大到其他主体，也不得通过顺序、计数、错误文本或延迟差异暴露无权对象。

#### Scenario: Caller lacks permission for one requested calendar
- **WHEN** 批量忙闲查询包含一个有权日历和一个无权日历
- **THEN** 系统不返回无权日历的区间或存在性，并以不泄密的主体级结果表达不可用

#### Scenario: Caller uses a stale authorization cache
- **WHEN** 客户端认为仍有忙闲权限但服务端授权已撤销
- **THEN** 服务端拒绝该主体查询并返回权限失效信号，客户端不得展示旧缓存区间

#### Scenario: Membership becomes inactive during a query
- **WHEN** 调用方或目标成员在查询执行前失去组织有效性
- **THEN** 系统按无有效成员处理且不返回此前可见的忙闲数据

### Requirement: Time-bounded and normalized availability queries
忙闲查询 MUST 指定有限起止时间与 IANA 时区，并受服务端范围及主体数量上限约束。系统 SHALL 以明确的半开区间语义返回结果，正确处理全天、跨日、时区和重复实例，且不把提醒、任务叠加或自动化投影视为成员日历忙碌，除非其权威来源明确创建日历事件。

#### Scenario: Query crosses a daylight-saving transition
- **WHEN** 查询范围跨越目标时区的夏令时切换
- **THEN** 返回区间代表正确的绝对时刻，并可按请求时区一致显示

#### Scenario: Recurring event has an exception
- **WHEN** 查询范围包含重复日程及一个移动或取消的实例例外
- **THEN** 忙闲结果使用实际实例时间，不同时返回原实例与例外造成重复占用

#### Scenario: Query exceeds configured bounds
- **WHEN** 请求的时间跨度或主体数量超过服务端限制
- **THEN** 系统在计算前拒绝请求，并返回可操作但不泄露日历内容的范围错误

### Requirement: Conflict hints preserve privacy
创建、改期或调整时长的预览和写入 SHALL 能提示调用方有权查询主体的时间冲突。对于只有忙闲权限的冲突，提示 MUST 仅标明冲突主体和重叠区间，不得显示冲突日程的标题、参与人或来源日历；无权查询的主体 MUST 显示为可用性未知而非空闲。

#### Scenario: Proposed event conflicts with a free-busy-only colleague
- **WHEN** 拟议时段与某同事忙碌区间重叠且调用方无详情权限
- **THEN** 系统提示该同事在重叠区间忙碌，但不显示造成冲突的日程详情

#### Scenario: Availability cannot be authorized
- **WHEN** 拟议参与人的忙闲权限不可用或刚被撤销
- **THEN** 系统将其标记为可用性未知，不把缺失结果解释为无冲突

#### Scenario: User confirms a conflicting write
- **WHEN** 有写权限的用户看到冲突后明确确认继续创建或改期
- **THEN** 系统允许写入，但在最终写入前重新计算授权与冲突并返回最新提示

### Requirement: Common availability suggestions
系统 SHALL 能根据请求成员、时间范围、时长、工作时段、时区和粒度计算共同可用候选。候选 MUST 仅来自所有已授权主体都不忙的区间，按确定性规则排序，并仅返回候选时间及可用性状态，不返回用于计算的日程详情。

#### Scenario: A common slot exists
- **WHEN** 所有请求成员在工作时段内存在满足时长的共同空闲区间
- **THEN** 系统返回按约定排序的候选开始和结束时间，不附带任何忙碌日程详情

#### Scenario: No common slot exists
- **WHEN** 给定范围内没有满足时长的共同空闲区间
- **THEN** 系统返回空候选与不泄露具体日程的说明，而不是放宽成员或时长条件

#### Scenario: One subject has unknown availability
- **WHEN** 任一请求主体无权查询、成员失效或数据无法确认
- **THEN** 系统不把该主体视为空闲，并将结果标记为不完整或拒绝生成确定候选

#### Scenario: Members use different time zones
- **WHEN** 请求成员分处不同时区且调用方提供共同排期时区
- **THEN** 系统以绝对时间求交集，并按请求时区返回候选且保留每个成员工作时段约束

### Requirement: Availability reflects attendance and event state
忙闲计算 SHALL 使用当前有效日程实例及参与状态。已取消日程、已取消实例和成员已拒绝的邀请 MUST 不占用该成员；已接受、待定或未响应邀请的占用策略 MUST 一致且在响应变化后更新。参与人失效不得继续贡献该成员忙碌区间。

#### Scenario: Attendee declines an invitation
- **WHEN** 成员把活动邀请响应改为 `declined`
- **THEN** 后续该成员忙闲查询不再把该邀请时段视为忙碌，并通过增量同步使缓存失效

#### Scenario: Attendee marks an invitation tentative
- **WHEN** 成员将邀请响应设为 `tentative`
- **THEN** 忙闲结果按组织统一策略标为忙碌或待定占用，并在所有调用入口保持一致

#### Scenario: One recurring instance is cancelled
- **WHEN** 重复系列的单个实例被取消
- **THEN** 该实例不再贡献忙碌区间，系列其他活动实例不受影响

### Requirement: Availability caches obey authorization changes
忙闲和候选缓存 SHALL 按 deployment、organization、requesting member、target subject、权限版本和时间范围隔离。撤权、角色降级、组织成员失效、日程或响应变化 MUST 使相关缓存失效；离线客户端不得在重新鉴权前展示过期忙闲或候选。

#### Scenario: Free-busy permission is revoked
- **WHEN** 某成员对目标日历的忙闲权限被撤销
- **THEN** 服务端和所有客户端使相关区间与候选缓存失效，后续查询不返回旧结果

#### Scenario: Event changes on another device
- **WHEN** 目标成员在另一设备创建或移动一个忙碌日程
- **THEN** 相关在线客户端收到可用性失效信号，下一次冲突或候选计算使用新时间区间

#### Scenario: Offline client opens cached scheduling suggestions
- **WHEN** 客户端离线且无法验证参与主体当前授权及忙闲版本
- **THEN** 客户端将候选标记为过期且不可确认，不把缓存结果呈现为当前共同可用时间

### Requirement: Multi-member consistency under concurrent changes
共同可用时间和冲突预览 SHALL 携带其依据的可用性版本或计算令牌。最终创建或改期时，系统 MUST 重新校验所有主体的当前权限和可用性；并发变更导致候选失效时 SHALL 返回新冲突，而不是默默使用陈旧建议。

#### Scenario: A member becomes busy after a slot is suggested
- **WHEN** 系统建议共同空闲时段后、创建日程前，另一成员在该时段新增忙碌日程
- **THEN** 最终写入返回新冲突提示并要求调用方重新确认或选择其他候选

#### Scenario: Two organizers book the same common slot concurrently
- **WHEN** 两个组织者基于同一可用性快照为重叠成员并发创建日程
- **THEN** 每个写入都保留日历版本一致性，后提交者得到基于最新状态的冲突提示，系统不宣称两次预览都仍无冲突

#### Scenario: Permission changes after suggestion generation
- **WHEN** 候选生成后、确认前，调用方失去某主体的忙闲权限
- **THEN** 最终操作不返回该主体的新忙闲详情，并将其可用性视为未知或拒绝继续

### Requirement: Desktop and Agent availability parity
Desktop 排期界面与 Agent 能力 SHALL 使用同一忙闲、冲突和共同可用时间接口及授权投影。Agent 不得通过多轮查询、窄时间探测、工具组合或模型推断获得比 Desktop 更多的区间精度、字段或主体信息。

#### Scenario: Agent requests a common time
- **WHEN** 有权用户要求 Agent 为多个组织成员寻找共同时间
- **THEN** Agent 仅获得并展示同一接口返回的候选区间，不接收底层日程详情

#### Scenario: Agent probes a private event with narrow windows
- **WHEN** Agent 连续提交窄时间范围查询以尝试重建私密日程
- **THEN** 系统执行与 Desktop 相同的范围、频率和区间归并策略，并且始终不返回可关联日程的标识或字段

#### Scenario: Agent schedules after a stale suggestion
- **WHEN** 用户确认 Agent 使用先前候选创建日程
- **THEN** Agent 在写入时触发服务端重新校验，并把新冲突或权限变化呈现给用户而不是绕过确认

### Requirement: Availability abuse controls and audit
系统 SHALL 对大范围、高频、批量和枚举式忙闲查询实施组织策略、速率和规模限制，并记录调用方、主体数量、范围、用途入口和结果类型。审计记录 MUST 不包含日程详情或可用于重建个人时间表的完整区间集合。

#### Scenario: Caller enumerates many members repeatedly
- **WHEN** 调用方在短时间内对大量成员执行滑动窗口式忙闲探测
- **THEN** 系统限制或拒绝请求，返回不泄露目标状态的错误，并记录安全审计事件

#### Scenario: Normal scheduling query is audited
- **WHEN** Desktop 或 Agent 成功请求一组成员的共同可用时间
- **THEN** 系统记录最小化审计元数据，不复制标题、描述、参与人响应或完整忙闲结果
