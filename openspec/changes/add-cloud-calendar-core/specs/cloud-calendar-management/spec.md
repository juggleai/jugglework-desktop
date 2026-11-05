# Spec Delta

## Purpose

定义由 JuggleWork 云端唯一权威管理的个人日历与日程行为，使成员能在组织边界内安全地创建、查询、更新、删除并跨设备同步日历数据。

## ADDED Requirements

### Requirement: 云端是日历数据的唯一权威
系统 SHALL 仅以云端已持久化并确认的 Calendar、CalendarEvent、版本和删除状态作为权威状态，客户端本地状态不得替代云端提交结果。

#### Scenario: 成功写入后返回权威状态
- **WHEN** 已授权成员提交有效的日历或日程写入
- **THEN** 系统持久化写入并返回云端生成的稳定 ID、当前版本和权威字段值

#### Scenario: 未获云端确认的写入
- **WHEN** 写入因网络中断、校验失败或服务端错误而未获得成功响应
- **THEN** 系统不得将该写入表示为已保存的云端状态

### Requirement: Calendar 与 CalendarEvent 是独立资源
系统 SHALL 将 Calendar 与 CalendarEvent 建模为具有各自稳定 ID、版本、生命周期和变更记录的独立资源，并由 CalendarEvent 通过 calendarId 归属一个 Calendar。

#### Scenario: 日程归属日历
- **WHEN** 成员创建 CalendarEvent 并提供其有权访问的有效 calendarId
- **THEN** 系统创建独立日程资源且返回的 calendarId 与目标 Calendar 一致

#### Scenario: 无效日历归属
- **WHEN** 成员使用不存在、已删除或无权访问的 calendarId 创建或移动日程
- **THEN** 系统拒绝请求且不创建或移动 CalendarEvent

#### Scenario: 日历元数据更新不改写日程身份
- **WHEN** 成员更新 Calendar 的名称或颜色
- **THEN** 该 Calendar 下既有 CalendarEvent 的稳定 ID 保持不变

### Requirement: 成员拥有个人日历集合
系统 SHALL 为每个组织成员提供至少一个不可删除的默认个人 Calendar，并允许该成员创建、查看、更新和软删除其他个人 Calendar。

#### Scenario: 首次访问默认日历
- **WHEN** 有效组织成员首次读取个人日历集合
- **THEN** 系统返回一个归属该成员且可用于创建日程的默认个人 Calendar

#### Scenario: 创建额外个人日历
- **WHEN** 成员提交有效的个人 Calendar 名称和可选展示颜色
- **THEN** 系统创建归属该成员的新 Calendar 并返回其权威状态

#### Scenario: 删除默认日历
- **WHEN** 成员请求删除其默认个人 Calendar
- **THEN** 系统拒绝删除且默认 Calendar 保持可用

### Requirement: deployment、organization 与 member 隔离
系统 MUST 按 deployment、organizationId 和 ownerMemberId 联合限定所有日历资源访问；本阶段仅资源所有者可访问其 Calendar 和 CalendarEvent。

#### Scenario: 所有者访问
- **WHEN** 已认证成员在当前 deployment 和 organization 内读取或修改自己拥有的资源
- **THEN** 系统按请求语义允许访问

#### Scenario: 同组织其他成员访问
- **WHEN** 成员尝试读取或修改同一组织内其他成员拥有的 Calendar 或 CalendarEvent
- **THEN** 系统拒绝访问且不泄露该资源是否存在

#### Scenario: 跨组织或跨 deployment 访问
- **WHEN** 请求携带另一 organization 或 deployment 中资源的稳定 ID
- **THEN** 系统拒绝访问且不返回该资源的内容、版本或删除状态

### Requirement: 日历核心操作独立于 Agent
系统 SHALL 在成员已登录且日历服务可用时直接提供核心日历 API，不要求 Agent、AI Provider、会话或本地文件工作区存在或可用。

#### Scenario: 未配置 AI Provider
- **WHEN** 已登录成员未配置任何 AI Provider 并调用日历 API
- **THEN** 系统正常执行已授权的日历读取和写入

#### Scenario: 未打开本地工作区
- **WHEN** 已登录成员未打开本地文件工作区并调用日历 API
- **THEN** 系统按其云端组织成员身份处理请求

### Requirement: 全日日程使用排他本地日期区间
系统 SHALL 将全日日程表示为 startDate（含）与 endDateExclusive（不含）的本地公历日期，不得将其隐式转换为 UTC 时点。

#### Scenario: 单日全天日程
- **WHEN** 成员创建 startDate 为 2026-11-05 且 endDateExclusive 为 2026-11-06 的全日日程
- **THEN** 系统将日程解释为仅覆盖 2026-11-05

#### Scenario: 跨日全天日程
- **WHEN** 成员创建相隔多日且 endDateExclusive 晚于 startDate 的全日日程
- **THEN** 系统返回相同日期边界并将结束日期视为不占用

#### Scenario: 无效全天日期区间
- **WHEN** 全日日程的 endDateExclusive 不晚于 startDate 或日期格式无效
- **THEN** 系统拒绝请求并返回可识别的字段校验错误

### Requirement: 定时日程使用时点和 IANA 时区
系统 SHALL 以 startInstant（含）、endInstantExclusive（不含）和有效 IANA timeZone 表示定时日程，并保留该时区用于本地时间展示与编辑。

#### Scenario: 创建定时日程
- **WHEN** 成员提交结束时点晚于开始时点且 timeZone 为有效 IANA 标识符的定时日程
- **THEN** 系统保存规范化时点及 IANA 时区并返回排他结束边界

#### Scenario: 跨日定时日程
- **WHEN** 定时日程在其 IANA 时区下跨越一个或多个本地日期
- **THEN** 系统保留其真实时点区间并允许按覆盖的本地日期查询

#### Scenario: 无效定时日程
- **WHEN** endInstantExclusive 不晚于 startInstant 或 timeZone 不是有效 IANA 标识符
- **THEN** 系统拒绝请求并返回可识别的字段校验错误

#### Scenario: 夏令时边界
- **WHEN** 有效定时日程跨越其 IANA 时区的夏令时变化
- **THEN** 系统以存储的时点确定持续时间并以存储的时区确定本地显示值

### Requirement: 日程时间类型互斥且可显式转换
CalendarEvent MUST 恰好采用全天或定时一种时间类型；类型转换 SHALL 要求客户端提交目标类型的完整有效边界并清除另一类型的时间字段。

#### Scenario: 混合时间字段
- **WHEN** 创建或更新请求同时提交全天日期字段和定时时点字段
- **THEN** 系统拒绝请求且不改变日程

#### Scenario: 全天转换为定时
- **WHEN** 成员以当前版本提交完整有效的定时时点和 IANA 时区来转换全天日程
- **THEN** 系统保存为定时日程且响应中不再包含全天日期边界

### Requirement: 按范围列出和搜索个人日程
系统 SHALL 支持在成员有权访问的 Calendar 集合中按排他时间范围列出日程，并支持对日程标题和描述进行文本搜索；结果不得包含未请求日历或已软删除资源。

#### Scenario: 查询月范围
- **WHEN** 成员提交有效的范围开始、排他范围结束和 Calendar 筛选
- **THEN** 系统返回与该范围相交且属于所选 Calendar 的未删除日程

#### Scenario: 跨边界日程包含在结果中
- **WHEN** 日程开始于查询范围之前但结束于范围开始之后
- **THEN** 系统将该日程包含在范围结果中

#### Scenario: 搜索个人日程
- **WHEN** 成员提交非空搜索文本和可选 Calendar 筛选
- **THEN** 系统只返回其有权访问且标题或描述匹配的未删除日程

#### Scenario: 空或无效查询范围
- **WHEN** 范围结束不晚于范围开始或请求混用不兼容的范围类型
- **THEN** 系统拒绝请求并返回可识别的校验错误

### Requirement: 写入使用乐观版本控制
系统 SHALL 为 Calendar 和 CalendarEvent 维护单调递增的版本，并要求更新或删除携带调用方最后读取的预期版本。

#### Scenario: 版本匹配更新
- **WHEN** 成员使用资源当前版本提交有效更新
- **THEN** 系统原子应用更新并返回更高版本

#### Scenario: 版本冲突
- **WHEN** 成员使用过期版本更新或删除资源
- **THEN** 系统拒绝写入并返回明确冲突结果及当前权威资源版本

#### Scenario: 并发写入只有一个成功
- **WHEN** 两个请求使用同一预期版本并发修改同一资源
- **THEN** 系统最多接受一个请求且其他请求收到版本冲突

### Requirement: 创建和变更写入支持幂等
系统 SHALL 接受写入幂等键，并在同一 deployment、organization、member 和操作作用域内对相同键及相同请求语义返回同一权威结果。

#### Scenario: 重试相同创建请求
- **WHEN** 成员以相同幂等键和相同请求内容重试已成功的创建
- **THEN** 系统返回原资源及结果且不创建重复 Calendar 或 CalendarEvent

#### Scenario: 幂等键载荷不一致
- **WHEN** 成员复用幂等键但提交不同请求内容或目标资源
- **THEN** 系统拒绝请求并返回明确的幂等冲突

#### Scenario: 租户间幂等键隔离
- **WHEN** 不同 organization 或 member 使用相同幂等键
- **THEN** 系统在各自隔离作用域内独立处理且不暴露其他作用域结果

### Requirement: 删除采用可同步的软删除
系统 SHALL 软删除 Calendar 和 CalendarEvent，令其退出普通读取、范围查询和搜索结果，同时保留稳定 ID、删除版本和删除变更供增量同步使用。

#### Scenario: 删除日程
- **WHEN** 所有者以当前版本删除 CalendarEvent
- **THEN** 系统返回成功删除状态并使该日程不再出现在普通查询中

#### Scenario: 删除非默认日历
- **WHEN** 所有者以当前版本删除非默认 Calendar
- **THEN** 系统软删除该 Calendar，并令其所属日程退出普通查询且为受影响资源产生可同步删除变更

#### Scenario: 重复读取已删除资源
- **WHEN** 成员通过普通资源读取请求访问已软删除资源
- **THEN** 系统不返回其业务内容且不将其表示为活动资源

### Requirement: 增量变更游标完整且租户隔离
系统 SHALL 为每个 deployment、organization 和 member 作用域提供不透明变更游标，按稳定顺序分页返回 Calendar 与 CalendarEvent 的新增、更新和删除变更。

#### Scenario: 从已知游标拉取变更
- **WHEN** 成员提交该作用域内先前成功返回的游标
- **THEN** 系统返回游标之后按顺序发生的可见变更和表示已返回位置的后继游标

#### Scenario: 分页期间出现新变更
- **WHEN** 成员分页读取变更且同时产生新的日历变更
- **THEN** 系统确保沿返回游标继续读取时不跳过已提交变更且不把顺序表示为倒退

#### Scenario: 删除变更
- **WHEN** Calendar 或 CalendarEvent 在游标之后被软删除
- **THEN** 变更流返回包含资源类型、稳定 ID、删除状态和删除版本的记录

#### Scenario: 游标作用域不匹配
- **WHEN** 成员在不同 deployment、organization 或 member 作用域复用游标
- **THEN** 系统拒绝游标且不返回任何其他作用域的变更

#### Scenario: 游标已过期或无效
- **WHEN** 客户端提交无法继续增量读取的过期或无效游标
- **THEN** 系统返回明确的需要重新基线同步结果而不是不完整的成功结果

### Requirement: 不支持的协作和计划能力不进入核心契约
系统 SHALL 拒绝把参会邀请、团队共享角色、重复规则、提醒、会议、任务关联或外部日历同步字段作为本阶段已生效能力。

#### Scenario: 提交后续阶段字段
- **WHEN** 客户端尝试通过核心日历写入启用参会人、共享角色、重复、提醒、会议、任务关联或外部同步
- **THEN** 系统拒绝不受支持字段或明确忽略为未支持扩展，且不得表现为对应能力已生效
