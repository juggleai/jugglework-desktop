# Spec Delta

## Purpose

定义外部日历连接的供应商无关映射、来源权威、增量同步与受控写回契约，使跨系统变化可追踪、可恢复且不会静默覆盖。

## ADDED Requirements

### Requirement: External connector admission and capability profile
系统 SHALL 将每种外部日历连接器作为独立可选能力，并在启用前完成读取、写入、删除、webhook、增量游标、OAuth 范围与撤销、配额、数据处理和错误语义评审；未验证的能力 SHALL NOT 被声明可用。

#### Scenario: Connector is not reviewed
- **WHEN** 管理员尝试启用尚未完成 capability、OAuth 和 quota review 的连接器
- **THEN** 系统阻止启用并明确显示其尚不可用，而不是提供未经验证的连接流程

#### Scenario: Connector lacks reliable write support
- **WHEN** 已评审连接器只满足读取和增量同步要求
- **THEN** 系统仅允许只读模式，且不展示创建、更新或删除写回能力

### Requirement: Explicit calendar connection and mapping
系统 SHALL 通过授权连接发现外部日历，并要求用户或管理员显式选择每个外部日历的目标、同步方向和启用状态；映射 SHALL 由稳定连接 ID、外部日历 ID 与 JuggleWork 日历 ID 标识。

#### Scenario: Map an external calendar read-only
- **WHEN** 用户把有权读取的外部日历映射到 JuggleWork 并选择只读模式
- **THEN** 系统创建独立映射、记录能力快照并开始受限初始导入

#### Scenario: External calendar access is lost
- **WHEN** 连接仍存在但某个已映射外部日历不再可读
- **THEN** 系统暂停该映射并报告授权或资源缺失状态，不自动改映射到同名日历

### Requirement: Source authority and provenance
系统 SHALL 为每个映射声明字段及生命周期的权威来源，并 SHALL 为同步对象保存连接、映射、外部对象、外部版本和最后同步版本等来源信息，不把导入副本当作无来源的原生日程。

#### Scenario: External-authoritative event changes locally
- **WHEN** 用户尝试修改只读映射中的外部权威字段
- **THEN** 系统拒绝修改并指向外部来源，不创建会在下次同步中丢失的本地覆盖

#### Scenario: Show imported event provenance
- **WHEN** 用户查看由外部日历导入的日程
- **THEN** 系统明确显示其来源、同步状态和可执行操作，而不声称该日程由 JuggleWork 原生管理

### Requirement: Initial import without duplicate identity
系统 SHALL 分页执行有范围边界的初始导入，并 SHALL 使用外部稳定对象标识和映射建立唯一身份；任务重试、分页重叠或连接重启 SHALL NOT 创建重复日程。

#### Scenario: Initial import restarts after failure
- **WHEN** 初始导入在部分页面后失败并从安全检查点重启
- **THEN** 系统重用已有对象映射并继续导入，不重复已处理日程

#### Scenario: External recurring identity is available
- **WHEN** 外部来源为系列及实例提供稳定身份
- **THEN** 系统保留可用于更新与删除传播的系列和实例来源关系

### Requirement: Durable incremental cursor processing
系统 SHALL 按映射持久化增量游标，并 SHALL 仅在一批变化被幂等应用后推进游标；游标失效 SHALL 触发有界重建或重新同步，而不是静默跳过变化。

#### Scenario: Applying a page fails before commit
- **WHEN** 增量页中的任一必要变更未能持久化
- **THEN** 系统不推进该页游标，并可安全重放整页

#### Scenario: Provider invalidates the cursor
- **WHEN** 外部来源报告增量游标已过期或无效
- **THEN** 系统将映射标记为重新同步，执行有界对账并在完成前展示数据可能陈旧

### Requirement: Webhook hints with compensating scans
系统 SHALL 将 webhook 视为加速同步的非权威提示，验证其来源并去重，同时 SHALL 运行周期性补偿扫描以覆盖丢失、延迟、乱序或连接器不支持的 webhook。

#### Scenario: Receive duplicate webhooks
- **WHEN** 同一外部变化产生重复或乱序 webhook
- **THEN** 系统合并同步触发并依据增量来源应用最终变化一次

#### Scenario: Webhook is lost
- **WHEN** 外部变化未产生可用 webhook
- **THEN** 周期性补偿扫描最终通过增量游标或有界对账发现并应用该变化

#### Scenario: Webhook verification fails
- **WHEN** webhook 的签名、连接范围或重放检查失败
- **THEN** 系统拒绝该提示、记录脱敏安全事件且不推进任何同步游标

### Requirement: Read-only and controlled write-back modes
系统 SHALL 默认以只读方式同步；只有连接器写能力已评审、用户明确选择且 OAuth 范围足够时才允许受控写回，并 SHALL 逐项限制可写对象、字段和操作。

#### Scenario: Enable controlled write-back
- **WHEN** 用户为已通过写能力评审的映射明确启用受控写回
- **THEN** 系统展示实际支持的创建、更新和删除范围，并只请求实施这些操作所需的最小授权

#### Scenario: Operation exceeds the write profile
- **WHEN** 用户请求写回连接器未验证的字段或生命周期操作
- **THEN** 系统拒绝操作并保留本地及外部现状，不以近似写入代替

### Requirement: Idempotent outbound delivery and quota handling
系统 SHALL 为每个写回操作保存稳定投递记录、幂等身份、尝试次数和最终结果，并 SHALL 遵守连接器配额与重试提示；配额耗尽时 SHALL 延迟工作而不丢弃或紧密重试。

#### Scenario: Outbound result is uncertain
- **WHEN** 写回请求超时且外部结果未知
- **THEN** 系统先按连接器能力解析结果或幂等重试，避免创建重复外部日程

#### Scenario: Connector quota is exhausted
- **WHEN** 连接器返回配额或限速结果
- **THEN** 系统按允许时间退避、保持游标和待处理投递，并向获授权用户显示同步延迟

### Requirement: Cross-system conflict handling
系统 SHALL 使用来源版本和最后同步基线检测并发修改；可证明不重叠的字段变更可按映射策略合并，其他冲突 SHALL 保留双方版本并要求显式解决，不得静默最后写入获胜。

#### Scenario: Both systems change the same field
- **WHEN** JuggleWork 与外部来源在同一同步基线后都修改受控写回字段
- **THEN** 系统暂停该对象写回、保留双方值并呈现可审计冲突

#### Scenario: Systems change independent fields
- **WHEN** 双方变化属于能力配置允许合并的不同字段
- **THEN** 系统合并变化、更新两端版本基线并记录合并依据

### Requirement: Disconnect semantics
系统 SHALL 区分暂停、授权失效和显式断连；断连 SHALL 停止 webhook、扫描与写回，撤销或删除所持连接凭据，并要求用户选择保留带来源标记的本地副本或删除导入副本。

#### Scenario: OAuth authorization is revoked externally
- **WHEN** 刷新凭据被拒绝或连接器报告授权已撤销
- **THEN** 系统停止该连接的所有同步与写回、标记映射需重新授权，并保留现有数据而不声称其仍同步

#### Scenario: User disconnects and retains copies
- **WHEN** 用户显式断连并选择保留导入副本
- **THEN** 系统移除凭据和活动同步状态，并将保留对象标记为不再更新的来源副本

### Requirement: Deletion propagation and tombstones
系统 SHALL 按映射模式传播已验证删除，并 SHALL 保留足以防止重导入或回环删除的墓碑与来源版本；外部权威删除不得被无意重建，受控写回删除必须满足显式权限和策略。

#### Scenario: External-authoritative event is deleted
- **WHEN** 增量同步确认外部权威对象已删除
- **THEN** 系统删除或墓碑化对应导入对象，并使后续重放不重新创建该对象

#### Scenario: Local delete is allowed to propagate
- **WHEN** 用户在受控写回映射中获授权删除可写对象
- **THEN** 系统先记录本地删除意图和墓碑，再幂等投递外部删除并跟踪最终结果

#### Scenario: Local delete cannot be written externally
- **WHEN** 外部删除失败且连接器确认权限不足或操作不受支持
- **THEN** 系统保留可诊断冲突状态，不把外部对象标记为已删除，也不无限重试永久错误

### Requirement: Independently gated interoperability delivery
系统 SHALL 通过独立 feature flag 控制外部日历互操作，并 SHALL 在前三个日历阶段的必需契约及目标连接器评审通过后按连接器和同步模式逐步灰度。

#### Scenario: Enable one reviewed read-only connector
- **WHEN** 某连接器仅只读模式满足依赖和发布门禁
- **THEN** 系统可仅为该连接器启用只读同步，且不要求写回、视频会议、资源预订或公开预约同时启用
