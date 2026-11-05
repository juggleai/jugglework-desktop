# Spec Delta

## Purpose

定义面向外部访客的预约类型、隐私安全可用时段与预约生命周期，使公开访问可控、时区明确并能抵御重复预订和滥用。

## ADDED Requirements

### Requirement: Appointment type management
系统 SHALL 允许获授权成员创建、发布、暂停和归档预约类型，并配置稳定公开标识、标题、说明、时长、可预约日期范围、最短提前期、最远预约期、前后缓冲、主办日历和取消改期策略。

#### Scenario: Publish a valid appointment type
- **WHEN** 主办人发布配置完整且其主办日历可用的预约类型
- **THEN** 系统生成不暴露内部对象 ID 的稳定公开入口并开始提供可预约时段

#### Scenario: Pause public booking
- **WHEN** 主办人暂停预约类型
- **THEN** 系统停止接受新预约，同时保留已有预约及其取消改期入口

### Requirement: Timezone-explicit public availability
系统 SHALL 使用 IANA 时区定义预约规则和主办人可用窗口，并 SHALL 允许访客选择显示时区；返回的每个时段 SHALL 包含明确瞬时时间和显示时区，且正确处理夏令时跳变与重复。

#### Scenario: Visitor changes display timezone
- **WHEN** 访客把公开预约页从默认时区切换到另一 IANA 时区
- **THEN** 系统展示相同可预约瞬时集合在新时区中的本地时间，而不移动实际时段

#### Scenario: Local time does not exist
- **WHEN** 预约规则经过夏令时跳变产生不存在的本地时间
- **THEN** 系统不提供该无效时段，也不自动映射到不同瞬时

### Requirement: Availability with buffers and holds
系统 SHALL 基于主办人授权后的忙闲、预约规则、现有预约、前后缓冲、资源约束和短期提交占位计算可用时段，并 SHALL 在公开响应中只返回可预约时段而不返回底层日程详情。

#### Scenario: Existing event consumes buffer
- **WHEN** 候选时段本身不重叠日程但其配置缓冲与忙碌时间重叠
- **THEN** 系统不将该候选时段公开为可预约

#### Scenario: Public caller probes unavailable time
- **WHEN** 访客请求一个不在公开结果中的任意时间
- **THEN** 系统只返回不可预约结果，不披露是私密日程、策略、资源还是其他预约造成阻塞

### Requirement: Atomic appointment booking
系统 SHALL 在服务端权威事务中重新验证时段、策略、缓冲和所需资源，再原子创建预约及其主办日程；同一容量单位的冲突预约 SHALL 至多一个成功。

#### Scenario: Two visitors race for one slot
- **WHEN** 两名访客并发提交同一单容量时段
- **THEN** 系统只确认一个预约，并向另一访客返回时段已不可用及可重新查询的结果

#### Scenario: Slot expires before confirmation
- **WHEN** 访客打开的时段在提交前因新忙碌或策略变化失效
- **THEN** 系统拒绝预约且不创建孤立日程、会议或资源预订

#### Scenario: Booking request is retried
- **WHEN** 访客使用相同幂等标识重试相同预约请求
- **THEN** 系统返回原确认结果而不创建重复预约

### Requirement: Minimal invitee data and consent
系统 SHALL 仅收集预约类型明确配置且完成预约所必需的访客字段，展示用途和隐私说明，并 SHALL 限制访客数据的可见范围、日志内容和保留期限。

#### Scenario: Submit required invitee information
- **WHEN** 访客提交姓名、联系渠道及预约类型声明的必要答案
- **THEN** 系统只将这些字段提供给获授权主办人，并在日志和指标中排除其原文

#### Scenario: Request undeclared sensitive data
- **WHEN** 预约类型尝试新增未经允许的敏感字段
- **THEN** 系统拒绝发布该配置，直到完成适用的隐私与安全评审

### Requirement: Capability-bound access links
系统 SHALL 为预约确认、取消和改期提供随机、可撤销、可轮换且用途受限的访问能力，并 SHALL NOT 通过公开标识或可枚举参数授予预约详情权限。

#### Scenario: Open a valid cancellation link
- **WHEN** 访客使用尚未撤销且未过期的取消能力访问预约
- **THEN** 系统仅展示执行取消所需的最小预约信息和允许的操作

#### Scenario: Reuse a rotated link
- **WHEN** 访客在改期后使用已轮换的旧访问能力
- **THEN** 系统拒绝访问且不披露当前预约详情

### Requirement: Appointment cancellation and rescheduling
系统 SHALL 按预约类型策略支持访客和主办人取消或改期，并 SHALL 将关联日程、资源和可选会议副作用作为可恢复工作流处理；改期失败 SHALL 保留原预约。

#### Scenario: Reschedule to an available slot
- **WHEN** 获授权访客选择新时段且事务复检成功
- **THEN** 系统以单次业务转换确认新时段、释放旧时段、更新访问能力并触发关联副作用

#### Scenario: Reschedule target conflicts
- **WHEN** 新时段在提交时已不可用
- **THEN** 系统保留原预约和原时段，并要求访客重新选择

#### Scenario: Cancel with an external side-effect failure
- **WHEN** 预约取消已提交但关联会议取消暂时失败
- **THEN** 系统保持预约已取消，隐藏该时段，并将外部副作用交给补偿流程而不要求访客重复取消

### Requirement: Public endpoint abuse controls
系统 SHALL 对公开可用性、预约、取消和改期端点实施按来源及预约类型的限流、异常检测、请求大小限制和可配置挑战，并 SHALL 避免通过响应差异支持用户、日历或预约枚举。

#### Scenario: Availability scraping exceeds limits
- **WHEN** 单一来源持续高频枚举公开时段并超过策略阈值
- **THEN** 系统限制请求并返回不含主办人私密信息的通用响应

#### Scenario: Repeated invalid token attempts
- **WHEN** 来源反复提交无效取消或改期能力
- **THEN** 系统提高限制或要求挑战，并记录不含能力值的安全事件

### Requirement: Independently gated appointment delivery
系统 SHALL 通过独立 feature flag 控制公开预约，并 SHALL 在前三个日历阶段的必需契约、公开端点安全评审和容量测试通过后才允许灰度启用。

#### Scenario: Enable appointment scheduling alone
- **WHEN** 公开预约子能力满足依赖和发布门禁
- **THEN** 系统可单独启用预约类型与公开页面，且不要求视频会议、资源目录或外部日历互操作同时启用
