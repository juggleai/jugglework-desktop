# Spec Delta

## Purpose

定义供应商无关的视频会议与原生日程关联、生命周期和故障恢复契约，使会议连接信息可受控使用且外部副作用能够可靠补偿。

## ADDED Requirements

### Requirement: Conferencing connector admission
系统 SHALL 将每种视频会议连接器视为独立的可选能力，并在启用前完成其能力范围、OAuth 授权与撤销、配额、数据处理和故障语义评审；未通过评审或未配置的连接器 SHALL NOT 显示为可用。

#### Scenario: Connector has not passed review
- **WHEN** 管理员查看可启用的视频会议连接器，而候选连接器尚未通过实施前评审
- **THEN** 系统不允许启用该连接器，也不声称其会议创建能力可用

#### Scenario: Connector supports only part of the lifecycle
- **WHEN** 已评审连接器不支持更新某项会议属性
- **THEN** 系统记录该能力限制，并拒绝依赖该能力的操作而不伪造成功

### Requirement: Provider-neutral conference association
系统 SHALL 使用独立会议关联记录连接日程与外部会议，并仅向日程投影加入会链接、拨入信息和会议状态等通用字段，不把供应商专有字段写入核心日程模型。

#### Scenario: Attach a created conference
- **WHEN** 获授权用户为日程显式创建视频会议且外部创建成功
- **THEN** 系统保存稳定会议关联和受限连接信息，并使日程详情能够展示该会议

#### Scenario: Read an event without conferencing enabled
- **WHEN** 视频会议子能力被 feature flag 关闭或组织未配置连接器
- **THEN** 日程仍可正常读取和编辑，且不依赖会议关联记录

### Requirement: Explicit conference lifecycle
系统 SHALL 仅在获授权的显式请求下创建、更新或取消外部会议，并分别跟踪日程生命周期与会议生命周期，不把日程写入成功等同于外部会议操作成功。

#### Scenario: Create request remains pending
- **WHEN** 日程保存成功但外部会议创建尚未得到确定结果
- **THEN** 系统保留日程并将会议标记为处理中，而不展示未经确认的加入信息

#### Scenario: Cancel linked event
- **WHEN** 获授权用户取消带有关联会议的日程
- **THEN** 系统取消原生日程并请求取消外部会议，同时独立展示外部取消的最终状态

#### Scenario: Update does not require external mutation
- **WHEN** 用户修改不影响外部会议的日程字段
- **THEN** 系统不执行无必要的外部会议更新

### Requirement: Idempotent external conference operations
系统 SHALL 为可重试的会议创建、更新和取消使用稳定操作标识，并 SHALL 防止客户端重试、任务重投或 webhook 重放创建重复会议或重复生命周期变更。

#### Scenario: Retry an uncertain create
- **WHEN** 创建会议的结果未知且同一操作被重试
- **THEN** 系统解析或重用原操作结果，而不是为同一日程创建第二个活动会议

#### Scenario: Receive duplicate completion
- **WHEN** 系统多次收到同一外部会议操作的完成信号
- **THEN** 系统只应用一次状态转换并保留一致的关联记录

### Requirement: Conference compensation and reconciliation
系统 SHALL 持久化外部会议操作状态，并对部分成功、超时和未知结果执行可重试补偿与对账；无法自动恢复时 SHALL 保留可诊断状态和明确的人工重试入口。

#### Scenario: External conference succeeds after local association fails
- **WHEN** 外部会议创建成功但本地会议关联未能提交
- **THEN** 系统通过稳定操作标识发现孤立会议，并重建关联或安全取消该会议

#### Scenario: External cancellation repeatedly fails
- **WHEN** 日程已取消但外部会议在重试预算内仍无法取消
- **THEN** 系统保持日程已取消，标记会议补偿失败，并向获授权管理员提供不含秘密的诊断和重试操作

#### Scenario: Reconciliation finds external drift
- **WHEN** 周期性对账发现关联会议已在外部被取消或改变
- **THEN** 系统更新会议状态或创建待处理冲突，而不静默改写原生日程业务字段

### Requirement: Conference authorization and secret handling
系统 SHALL 复用日程访问权限控制会议操作与连接信息读取，并 SHALL 对 OAuth 凭据、管理 URL、主持人秘密和个人加入凭据实施最小披露、加密存储和日志脱敏。

#### Scenario: Viewer reads a linked conference
- **WHEN** 仅具有日程查看权限的参与者读取会议关联
- **THEN** 系统只返回其获准使用的加入信息，不返回连接凭据或主持人管理秘密

#### Scenario: Unauthorized user mutates a conference
- **WHEN** 无日程编辑或会议管理权限的用户请求更新或取消会议
- **THEN** 系统拒绝操作，且不向外部连接器发送请求

### Requirement: Independently gated conferencing delivery
系统 SHALL 通过独立 feature flag 控制视频会议子能力，并 SHALL 在前三个日历阶段的必需契约可用且该子能力通过发布门禁后才允许灰度启用。

#### Scenario: Enable conferencing only
- **WHEN** 视频会议子能力满足依赖和发布门禁而其他生态子能力仍关闭
- **THEN** 系统可单独交付视频会议关联，且不要求会议室、公开预约或外部日历互操作同时启用
