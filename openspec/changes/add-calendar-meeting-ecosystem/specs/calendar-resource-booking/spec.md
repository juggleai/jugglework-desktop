# Spec Delta

## Purpose

定义会议室及其他组织资源的目录、隐私安全可用性与排他预订契约，使授权用户能够可靠排期且并发竞争不会产生双重预订。

## ADDED Requirements

### Requirement: Organization resource directory
系统 SHALL 提供组织隔离的资源目录，包含稳定资源 ID、显示信息、时区、容量、设施、地点、可用状态和预订策略，并 SHALL 仅向获授权成员展示允许发现的资源。

#### Scenario: Discover an available room
- **WHEN** 组织成员按时间、容量和设施查询其有权发现的会议室
- **THEN** 系统返回匹配资源及其可用于排期的策略摘要

#### Scenario: Hidden resource is queried
- **WHEN** 用户查询无权发现的受限资源
- **THEN** 系统不返回该资源，也不泄露其名称、位置或占用情况

### Requirement: Resource administration
系统 SHALL 允许获授权资源管理员创建、更新、停用和恢复资源及其预订策略，并 SHALL 保留变更审计；停用资源 SHALL 阻止新预订但不静默删除已有预订。

#### Scenario: Disable a room with future bookings
- **WHEN** 资源管理员停用已有未来预订的会议室
- **THEN** 系统阻止新增预订，保留既有预订并向管理员标示需要处理的未来占用

#### Scenario: Unauthorized directory change
- **WHEN** 普通成员尝试修改资源目录或预订策略
- **THEN** 系统拒绝变更并记录授权拒绝事件

### Requirement: Privacy-safe resource availability
系统 SHALL 根据资源时区、开放时间、停用期、预订策略和已提交占用计算可用性，并 SHALL 对无详情权限的查询只返回可用、占用或不可预订状态。

#### Scenario: Query a busy resource without event access
- **WHEN** 用户有权查询资源可用性但无权查看造成占用的日程
- **THEN** 系统返回忙碌时间块而不返回标题、组织者、参与人或描述

#### Scenario: Query outside booking policy
- **WHEN** 候选时段落在资源开放时间之外或违反提前期策略
- **THEN** 系统将该时段标记为不可预订并返回可操作的策略原因

### Requirement: Transactional exclusive booking
系统 SHALL 在服务端权威事务中验证资源授权、策略和时间重叠并提交排他预订；对同一资源的重叠有效预订 SHALL 由数据库级约束或等价串行化机制保证至多一个成功。

#### Scenario: Two users race for the same room
- **WHEN** 两个获授权用户并发提交同一资源的重叠时段
- **THEN** 系统只提交一个预订，并向另一请求返回包含最新可用性依据的冲突结果

#### Scenario: Availability becomes stale before commit
- **WHEN** 用户选择时资源显示可用但提交前已被另一事务预订
- **THEN** 系统拒绝该提交而不创建短暂或重复的有效预订

#### Scenario: Book multiple exclusive resources
- **WHEN** 一个日程请求以全有或全无方式预订多个排他资源且其中一个发生冲突
- **THEN** 系统不提交该请求中的任何资源预订，并返回发生冲突的资源

### Requirement: Resource booking lifecycle
系统 SHALL 将资源预订作为独立记录关联到日程，并支持授权创建、改期、取消和日程删除传播；每次变更 SHALL 使用版本或等价前置条件防止陈旧覆盖。

#### Scenario: Reschedule a booking successfully
- **WHEN** 获授权用户用当前版本把资源预订改到仍可用的时段
- **THEN** 系统以单次事务释放旧时段并占用新时段，不产生无保护间隙

#### Scenario: Reschedule into a conflict
- **WHEN** 新时段与另一有效预订冲突
- **THEN** 系统保留原预订并返回冲突，不先释放原时段

#### Scenario: Cancel an event with a resource
- **WHEN** 日程被授权取消
- **THEN** 系统取消关联资源预订并使该时段可被后续事务预订

### Requirement: Idempotent booking commands
系统 SHALL 为资源创建、改期和取消接受稳定幂等键，并 SHALL 在重试时返回原结果而不重复占用、重复释放或绕过冲突检查。

#### Scenario: Retry a successful booking
- **WHEN** 客户端因响应丢失使用相同幂等键重试资源预订
- **THEN** 系统返回原预订及版本，不创建第二条有效占用

#### Scenario: Reuse a key with different booking input
- **WHEN** 客户端用相同幂等键提交不同资源或时段
- **THEN** 系统拒绝请求并保留原操作结果

### Requirement: Resource booking audit and recovery
系统 SHALL 记录资源目录和预订的重要变更、执行者、版本及冲突，并 SHALL 提供可重建占用索引和检测异常重叠的运维对账能力。

#### Scenario: Reconciliation finds an invalid overlap
- **WHEN** 对账检测到迁移、故障或人工数据操作造成的重叠有效预订
- **THEN** 系统阻止进一步冲突写入，保留证据并将异常交由获授权管理员处理

### Requirement: Independently gated resource delivery
系统 SHALL 通过独立 feature flag 控制资源目录和预订，并 SHALL 在前三个日历阶段的必需契约可用且事务冲突测试通过后才允许灰度启用。

#### Scenario: Enable resource booking without other ecosystem features
- **WHEN** 资源预订子能力满足依赖和发布门禁
- **THEN** 系统可单独启用会议室预订，且不要求视频会议、公开预约或外部日历互操作同时启用
