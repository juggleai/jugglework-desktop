# Spec Delta

## Purpose

定义个人 Calendar 排期编辑器的参与人、基础重复、busy-only availability 以及 scheduling authority 失败/离线边界。

## ADDED Requirements

### Requirement: Organization member attendee selection is bounded

排期编辑器 SHALL 只从当前组织成员目录和可映射到该目录的群成员选择参与人。提交前 MUST 对非空 member IDs 去重并拒绝超过 20 人；外部联系人、跨组织主体和无法映射群成员不得进入请求。

#### Scenario: Group contains more than the allowed attendees

- **WHEN** 用户选择一个包含超过 20 名可映射成员的群组
- **THEN** 编辑器最多选择 20 名不同成员并报告 added、skipped 和 over-limit 数量

#### Scenario: A caller bypasses the picker

- **WHEN** 表单状态被直接构造为 21 个不同 member IDs
- **THEN** framework-free validator 拒绝提交且不调用 scheduling API

### Requirement: Basic recurrence uses a strict bounded contract

编辑器 SHALL 支持 daily、weekly、monthly 频率、1 到 365 的整数 interval，以及 never、ISO date until 或 1 到 1000 次 count 终止。它 MUST NOT 生成任意 RRULE、年度规则或实例级 mutation scope。

#### Scenario: User creates a weekly event

- **WHEN** 用户选择 weekly interval 1 和 never
- **THEN** 请求发送结构化 `{frequency:"weekly", interval:1, end:{kind:"never"}}`

#### Scenario: Recurrence values exceed bounds

- **WHEN** interval 或 count 不是安全整数或超过限制
- **THEN** 表单显示 recurrence validation error 且不发送请求

### Requirement: Availability reveals only busy or unknown

Availability UI SHALL 只展示组织成员显示名和归一化 busy 半开区间。加载、失败、离线、缺少主体结果或授权不可确认时 MUST 显示 unknown，不得将缺失结果解释为空闲，也不得显示标题、描述、日历或事件标识。

#### Scenario: Availability request fails

- **WHEN** busy-only API 返回错误
- **THEN** 每个已选参与人显示 unknown/失败状态，表单不显示任何缓存事件详情

#### Scenario: User goes offline

- **WHEN** 编辑器离线打开或连接断开
- **THEN** 不发起 availability 请求，已选参与人仍保留但可用性不可确认

### Requirement: Scheduling authority is fail-closed for writes

Fresh scheduling metadata SHALL 决定个人事件能否安全编辑或删除。查询 pending/failed 时普通 bootstrap 事件 MAY 继续显示，但相关写入口 MUST 禁用；重复 occurrence SHALL 使用虚拟展示身份且不可直接写入。

#### Scenario: Scheduling query fails with core events available

- **WHEN** core bootstrap 成功而 scheduling occurrence 查询失败
- **THEN** 月/周/日视图继续显示 core 事件和 scheduling 错误，但不提供该个人事件的编辑或删除动作

#### Scenario: One-time attendee event is returned

- **WHEN** occurrence 响应包含 recurrence 为 null 的参与人事件
- **THEN** UI 保留真实 event ID，并在 fresh authority 下允许按 aggregate version 编辑

### Requirement: Remote changes require explicit conflict resolution

编辑器 SHALL 保留表单创建时的 expected-version 基准。后台 refetch 或 409 返回同事件新版本时，系统 MUST 保留用户输入并阻止保存，直到用户明确选择使用最新或以自己的输入基于新版本重提。

#### Scenario: Event refreshes while the user edits

- **WHEN** 用户基于 version 1 修改标题且后台取得 version 2
- **THEN** 表单保留用户标题、进入 conflict、禁用普通保存，并且只有显式“保留我的修改”后才以 expectedVersion 2 提交

### Requirement: Core offline baseline survives scheduling outages

Scheduling 服务失败 MUST NOT 阻止成功的普通 Calendar bootstrap 持久化为同 scope/range 的离线只读 baseline。只有 fresh scheduling success 才可把 occurrence 合并入 baseline；离线不得把缓存 scheduling/availability 当作当前写权限。

#### Scenario: Scheduling is unavailable before going offline

- **WHEN** core bootstrap 成功、scheduling 查询失败并随后离线
- **THEN** 缓存覆盖范围仍显示普通事件为只读，并明确处于离线状态

#### Scenario: Offline draft includes scheduling fields

- **WHEN** 用户把含参与人和重复规则的表单保存为本地草稿
- **THEN** 草稿保留这些字段但不自动发送，恢复在线后仍需 fresh scheduling authority 和显式提交

### Requirement: RSVP and invitation delivery are not implied

本 capability MUST NOT 把参与人选择表述为已完成的 RSVP、邀请投递、更新通知、取消通知或参与人自助响应。相关状态与多端生命周期只有在 `calendar-attendance` 完整实现后才可暴露。

#### Scenario: Scheduling event is created with attendees

- **WHEN** Server 接受带组织 member IDs 的 scheduling event
- **THEN** Desktop 只确认事件保存和参与人集合，不宣称邀请已送达或参与人已接受
