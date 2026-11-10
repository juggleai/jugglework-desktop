# Design

## Context

参见 `proposal.md` 的动机与范围，以及三个 capability spec 的行为契约。当前 JuggleWork 已具备云端会话认证、组织成员上下文、Go/Gin/GORM 服务端、顺序 SQL migration、Desktop 一级应用路由、More/置顶导航和 TanStack Query，但没有 Calendar 领域、日历增量协议或可离线读取的持久化范围缓存。

服务端 deployment 是独立运行实例及其数据库；同一 deployment 内的数据访问以 organization membership 为边界。Desktop 可连接不同 deployment，且同一账号可切换 organization，因此本地隔离键必须包含 deployment、organization 和 member，不能沿用只包含 workspace 或 organization 的缓存键。

日历时间同时包含两种不可混用的语义：全天事件是与 UTC 无关的公历日期区间，定时事件是时点区间加 IANA 时区。Desktop 当前没有能完整表达 `PlainDate`、`Instant` 和 `ZonedDateTime` 的日期依赖，原生 `Date` 不能作为统一领域类型。

## Goals / Non-Goals

**Goals:**

- 以 JuggleWork Server/Cloud 作为 Calendar 和 CalendarEvent 的唯一写入及版本权威。
- 建立可扩展但首阶段严格 owner-only 的个人日历领域、授权和 API。
- 让基线查询、增量游标、软删除、乐观版本和幂等写入形成无漏变更的同步协议。
- 提供独立于本地 workspace、Session、Agent 和 AI Provider 的 Desktop `/calendar` 月视图。
- 以持久化分区缓存支持已缓存范围的离线只读和非权威表单草稿。
- 通过 additive migration、服务端能力门和组织灰度实现可回滚发布。

**Non-Goals:**

- 不把 CalendarEvent 复用为 ProductTask、Automation、Session、Agent Todo 或会议对象。
- 不实现团队共享角色、参会邀请、会议资源、重复规则、提醒或外部日历同步。
- 不实现周/日时间轴、任务叠加、移动/Web 完整日历或离线写入队列。
- 不在本阶段公开恢复已删除日历资源、永久清除策略或跨组织移动。
- 不预建后续能力的 UI、空壳 API 或可写字段；只在独立资源和授权层保持可扩展边界。

## Decisions

### 1. 云端单写权威，Desktop 只缓存投影和草稿

Calendar 与 CalendarEvent 的已保存状态只由成功的云端响应、bootstrap 快照或变更流产生。Desktop 不先行把 mutation 写成权威实体，不维护后台写队列，也不在网络失败时显示已保存。本地草稿使用不同 store 和类型，不能进入查询实体、版本或游标。

选择该方案而不是 local-first/CRDT，是因为本阶段只有个人 owner 写入，乐观版本已能处理真实多设备冲突；引入多主合并会扩大时间区间、删除和后续协作语义的复杂度。

### 2. Calendar 与 CalendarEvent 使用独立表、版本和生命周期

服务端新增以下逻辑存储：

- `calendars`：稳定 ID、organization ID、owner member ID、名称、颜色、默认槽位、version、deleted metadata、created/updated timestamps。
- `calendar_events`：稳定 ID、calendar ID、organization ID、owner member ID、标题、描述、time kind、全天或定时字段、派生覆盖日期、version、deleted metadata、created/updated timestamps。
- `calendar_changes`：单调 sequence、租户作用域、entity type/ID/version、upsert/delete kind、同步 payload 和 committed timestamp。
- `calendar_mutations`：租户、operation、idempotency key、payload digest、原始成功响应和创建时间。

不使用一个带可选事件数组的 Calendar 聚合，也不把 Event 版本从属于 Calendar 版本。这样日历元数据更新不会制造所有 Event 的伪更新，后续共享能力也能在不改变 Event 身份的前提下扩展授权。

数据库遵循现有约定，不添加 foreign key 或 CHECK constraint；Repository/service 在同一事务内验证归属、时间字段互斥和生命周期。索引至少覆盖 `(organization_id, owner_member_id, deleted_at, updated_at, id)`、Calendar 下事件、派生日期范围、搜索候选和 change sequence。所有资源查询同时带 organization 和 owner member 条件，不能先按裸 ID 读取后再过滤。

### 3. 每个组织成员惰性创建一个默认个人日历

成员首次 bootstrap 或列出日历时，服务端以事务和唯一默认槽位保证 `(organization, owner member)` 只有一个活动默认 Calendar。额外 Calendar 也归属该 organization member。默认 Calendar 可以重命名和换色但不能删除；其他 Calendar 可软删除。

选择惰性创建而不是为全部历史成员批量 backfill，可避免迁移期间扫描所有组织成员，并使未使用日历的成员不产生数据。创建路径必须幂等，以支持首次访问并发。

本阶段没有 organization-owned shared Calendar。表中 owner 边界和独立授权 service 为后续团队日历预留扩展，但不会提前接受共享角色或组织所有权字段。

### 4. deployment 隔离由服务实例保证，组织/成员隔离由每次查询保证

服务端 deployment 对应独立 origin、配置和数据库，跨 deployment 不存在可直接查询的共享 Calendar 表。每个请求继续使用现有 session 和 organization guards，并将已验证 membership ID 作为 owner member ID；请求体不能指定 owner。其他成员、其他组织、已删除资源和不存在资源对普通资源 API 返回相同的不可见结果，避免存在性泄漏。

Desktop 的 deployment identity 使用规范化 Den base URL（scheme、host、port、base path，移除尾斜杠），与 organization ID、member ID 组成 scope。URL 别名可能形成两个互不共享的安全分区，但绝不能合并成可能泄漏数据的分区。

相比只在 UI 隐藏其他成员资源，该方案把 owner-only 规则放在 API/service/repository 三层可测试边界。未来共享必须通过新的 OpenSpec 扩展授权，不得通过放宽当前查询条件隐式启用。

### 5. 时间模型显式区分全天日期和定时时点

API 使用判别联合：

- `allDay`：`startDate` 与 `endDateExclusive`，均为严格 `YYYY-MM-DD` 公历日期。
- `timed`：RFC 3339 `startInstant`、`endInstantExclusive` 与经服务端 IANA tzdb 验证的 `timeZone`。

Event 恰好包含一组时间字段。所有结束边界排他，结束必须晚于开始。服务端保存定时时点为 UTC `DATETIME(6)`，同时保存 IANA zone；全天日期保存为 SQL `DATE`，不得经过 UTC 转换。

为使 owner 月范围查询可索引，服务端为两种类型计算只读的 `coverage_start_date` 与 `coverage_end_date_exclusive`。全天直接复制日期边界；定时事件在其保存的 IANA zone 下计算覆盖日期，若排他结束恰好位于本地午夜则不包含该日，否则覆盖到次日。API 不把派生字段作为可写时间语义，更新时由服务端重新计算。

Desktop 领域层使用 `@js-temporal/polyfill` 表达 `PlainDate`、`Instant` 和 `ZonedDateTime`，月格本身用现有 React 与设计系统组件实现，不引入重型 calendar layout 组件。依赖加入前执行实际发布版本的许可证和生产 bundle 体积审核；截至锁定的 `0.5.1`，npm 元数据与上游 LICENSE 均声明 ISC。相比原生 `Date` 或零散 `Intl` 反向换算，Temporal 能明确处理 IANA zone、DST 歧义和日期算术；表单对不存在/歧义本地时间必须给出确定校验或显式选择，不能静默漂移。

### 6. HTTP API 以个人资源、范围和变更为边界

在现有 `/v1` 云端 API 下增加受 session、organization membership 和 calendar feature gate 保护的路由：

- Calendar：列出、创建、读取、更新、删除。
- CalendarEvent：创建、读取、更新、删除、按本地排他日期范围及 Calendar IDs 分页列出、按标题/描述搜索。
- Bootstrap：原子返回活动 Calendar、请求范围内的 Event、范围完整性和对应 change cursor。
- Changes：从不透明 cursor 分页返回 Calendar/CalendarEvent upsert 与 delete，响应包含后继 cursor 和 `hasMore`。

所有 mutation 接受 `idempotencyKey`；update/delete 同时要求 `expectedVersion`。错误契约区分字段校验、version conflict（含当前权威资源）、idempotency payload conflict、authentication/membership failure、not found 和 cursor resync required。请求大小、字符串长度、页大小、范围跨度和 Calendar filter 数量由服务端限制；搜索先实现受限的 owner 范围包含匹配和稳定 cursor 分页，不把数据库方言特有全文搜索设为首发依赖。

API DTO 不包含 attendee、role、recurrence、reminder、meeting、task link 或 external provider 字段。未知字段按严格 JSON schema 拒绝，避免旧/试验客户端误以为后续能力生效。

### 7. Bootstrap 快照关闭基线与增量之间的竞态

单独先查范围、再获取“当前游标”会在两次请求之间漏掉写入，因此 bootstrap 在数据库一致性事务中读取活动 Calendar、范围 Event 和该快照可见的 change high-watermark。返回 cursor 指向该 watermark；快照之后提交的 mutation 必须获得更高 sequence，并由后续 changes 返回。

资源 mutation、version 增长、软删除、mutation receipt 和 change append 在同一数据库事务提交。Changes 按 sequence 升序读取 `sequence > cursor`，每页游标只推进到已返回的最后 sequence；新写入可以出现在后续页但不会使顺序倒退或跳过已提交行。

cursor 是带版本的签名 opaque payload，绑定 organization ID、owner member ID 和 sequence；deployment 由签发它的服务和签名密钥天然绑定。跨 scope、签名错误、格式错误或早于保留窗口的 cursor 返回 resync required，不降级为空成功页。签名密钥轮换可使旧 cursor 重新基线，不影响资源数据。

选择数据库 change log/pull cursor 而不是 WebSocket push，是因为首版只需要可靠收敛和离线恢复；前台、网络恢复、成功 mutation 后及低频定时刷新足够。后续可增加通知作为“需要 pull”的提示，而不改变 cursor 协议。

### 8. 乐观版本、幂等和软删除共用事务边界

Calendar 与 CalendarEvent 从 version 1 开始，每次有效 mutation 单调加一。Repository 用 `WHERE ... version = expectedVersion` 条件更新；零行更新后在同一租户边界读取当前状态，返回 conflict 或不可见结果。客户端冲突时保留表单输入并展示最新权威版本，不自动 last-write-wins。

幂等 scope 为 organization、actor member、operation 和 key，deployment 由数据库实例隔离。服务端对规范化请求计算 digest；同 key/digest 回放持久化的原始成功响应，不重复写资源或 change，同 key/不同 digest 返回 idempotency conflict。为满足不受时间窗口限定的重试契约，本阶段不清理 mutation receipt；未来如需 retention 必须另行定义客户端可观察窗口和迁移。

删除只标记资源、递增版本并追加 delete change。删除非默认 Calendar 时，同一事务批量软删除其活动 Event、递增各自版本并为每个受影响资源追加 delete change；普通列表、读取和搜索统一过滤 tombstone。软删除行至少保留到未来明确永久清除策略落地，本阶段没有 restore API。

### 9. Desktop 使用 IndexedDB 持久化分区缓存，React Query 作为内存视图

新增 calendar domain 模块，包含 API DTO normalization、Temporal 时间转换、scope/query keys、IndexedDB adapter、sync coordinator、draft store 和页面组件。IndexedDB 使用带 schema version 的 stores 保存：

- Calendar、Event 和删除版本墓碑。
- 已完整获取的 `[startDate, endDateExclusive)`、Calendar filter 与 bootstrap metadata。
- 每个 scope 的 change cursor 和最后成功刷新时间。
- 与已保存实体分离的 create/edit drafts，包含基准资源 ID/version 和 `unsynced` 状态。

所有 key 都以前述 scope 开头。应用一页 changes 与推进 cursor 使用同一 IndexedDB transaction；失败则两者都不提交。Event upsert 仅在其进入已覆盖范围、已存在于缓存或属于当前详情时保存；Event 移出范围或收到 delete 时从活动索引移除并保留版本墓碑。导航到未覆盖月份时在线获取新 bootstrap/range，离线则显示“不完整/不可用”而不是空月。

TanStack Query key 同样包含 deployment、organization、member、范围和 Calendar filter。scope 切换时先取消旧请求、隐藏旧数据并建立 generation fence；迟到响应只能写回其原 scope，不能更新当前 UI。登出立即停止同步和隐藏内容；是否物理清除历史分区遵循明确清除动作和本地数据策略，不依赖隐藏来实现隔离。

相比把完整事件 JSON 放入 `localStorage`，IndexedDB 提供容量、索引和多 store 原子事务；相比仅用 React Query 内存缓存，它可支持应用重启后的离线只读和草稿。

### 10. 离线是可见状态，不是写入模式

同步 coordinator 综合浏览器网络事件和实际 API 结果维护连接状态。离线时，页面只读展示当前 scope 中明确覆盖的缓存范围，并显示最后刷新时间、可能过期和未覆盖提示。Create/edit 表单可以继续编辑并保存为本地草稿，但 Save 不创建 mutation queue；delete、Calendar 管理和权威 mutation 均禁用或明确失败。

恢复在线时先从 cursor 刷新或重新 bootstrap，再允许基于最新 version 提交草稿。若基准 Event 已更新或删除，UI 保留草稿并进入显式冲突流程。只有用户再次确认提交且云端成功后，草稿才转换为已保存实体并清除。

### 11. Desktop 月视图接入既有应用 shell

`/calendar` 作为不带 workspace ID 的全局应用路由接入现有 retained shell，与 `/tasks` 类似但拥有独立 calendar domain。More 菜单增加 Calendar 和置顶控制，pin storage parser 增加 `calendar` 合法值并保持未知/旧值安全迁移。未登录、feature disabled 或 membership 无效时绝不渲染其他 scope 的缓存内容。

页面由三块组成：Calendar 筛选与迷你月历、可键盘操作的 6 周月格、选中日议程/详情。标准桌面宽度并排，窄窗口把辅助区折叠或重排为纵向/抽屉，不让核心操作依赖整页横向滚动。全天 Event 先于定时 Event；相同开始时间以稳定 ID 作最终排序。月格溢出进入选中日完整议程。

表单以判别联合在全天和定时模式间显式转换，提交 stable idempotency key 和最后读取 version。保存中、成功、校验失败、网络失败和版本冲突使用不同状态；失败输入保留为 draft。所有标题和描述按纯文本渲染。i18n、主题 token、焦点管理和可访问名称复用现有基础设施。

核心页面直接调用日历 API client，不经过 Agent tool、Session、AI Provider 或本地 workspace。未来可以另行增加 Agent capability，但不能成为此页面或服务端 API 的前置依赖。

### 12. 服务端能力门控制 Desktop 可见性和灰度

服务端增加 fail-closed calendar configuration：全局 `enabled`、可选 organization allowlist 和独立写入开关。`enabled=false` 时所有组织关闭；allowlist 为空时 `enabled=true` 对所有组织开放，非空时只开放大小写敏感的精确匹配。API 在认证和 membership 后检查 gate；Desktop config 为当前 organization 投影 `calendarEnabled`/`calendarWriteEnabled`，导航和 mutation 按同一服务端能力显示。服务端仍是最终授权，客户端 flag 只控制体验。

首轮先只读内部组织验证 bootstrap、cursor 和查询；随后对 canary organization 开启写入，再按 deployment 扩大。指标只记录 operation、状态码、延迟、结果数、cursor reset、version/idempotency conflict 和 scope 哈希，不记录标题、描述、草稿或搜索文本。

组织 allowlist 比仅靠 Desktop build flag 更适合灰度，因为旧客户端和直接 API 请求同样受控；独立写开关允许出现问题时保留已缓存/云端只读查看。

### 13. 后续阶段通过新 capability 扩展而非提前耦合

`add-calendar-work-planning` 负责重复日程、提醒、Task/Automation 只读叠加和 Agent 日历操作，但不能把来源字段写入核心 Event。`add-team-calendar-collaboration` 负责 organization-owned Calendar、共享角色、参与人、邀请与忙闲授权，并扩展 owner-only 边界。`add-calendar-meeting-ecosystem` 负责会议关联、资源预订、对外预约和外部日历互操作。

周/日时间轴是独立 Desktop 展示增量。任何后续阶段都必须继续使用现有排他结束、版本、幂等、软删除和 cursor 基础，且通过新 OpenSpec 明确数据迁移和权限变化。

## Risks / Trade-offs

- [删除含大量 Event 的 Calendar 会形成大事务和大量 change] → 为 mutation 设置服务端超时和可观测阈值，使用批量 SQL 但保持单事务；在团队共享或超大日历前重新评估异步删除协议。
- [派生 coverage date 受未来 tzdb 规则更新影响] → 保存原始 Instant 与 IANA zone 为权威，coverage 仅作查询投影；升级 tzdb 时提供可重算检查，详情和编辑永远从权威字段计算。
- [change log 与永久 mutation receipt 持续增长] → 首发监控表增长；change 可按明确 watermark 保留并让旧 cursor resync，mutation receipt 的清理窗口留给后续兼容性变更。
- [IndexedDB 缓存包含敏感日程内容] → 使用 Electron 用户 profile 隔离、严格 scope key、登出隐藏、显式分区清除和无内容日志；安全评审确认是否需要沿用产品级本地加密策略。
- [网络在线判断不可靠] → 以 API 成功/失败为主、浏览器事件为提示，UI 不因 `navigator.onLine` 单独宣称已同步。
- [Temporal polyfill 增加 bundle] → 在引入前做许可证和体积 gate，只在 calendar domain 加载；若不达 gate，先抽取等价的受测时间 adapter，不退回混用原生 `Date`。
- [owner-only 模型未来扩展共享需要授权迁移] → 授权集中在 service，数据保留明确 owner，不在 repository 或 UI 散布“同组织即可访问”的假设。
- [搜索的包含匹配在数据增长后性能有限] → 首版严格 owner、范围和分页并建立候选索引；真实指标达到阈值后用独立变更升级搜索实现，保持 API 契约不变。
- [Desktop 与 Server gate/版本不一致] → Server fail closed 并投影能力，Desktop 对未知字段默认隐藏；canary 同时验证最低 Desktop 版本。

## Migration Plan

1. 在 `jugglework-server` 先发布 additive migration，新增 Calendar、Event、change 和 mutation 表及索引；不修改 ProductTask、Session、Automation 或成员表，migration readiness 和两种支持数据库测试必须通过。
2. 以 calendar gate 全关发布 Server model/repository/service/API；验证 schema、健康检查和禁用态路由，不创建默认 Calendar。
3. 开启内部组织只读 gate，运行 bootstrap、范围、搜索、cursor、跨成员/组织拒绝和 tz/DST canary；确认无内容日志且指标正常。
4. 发布带隐藏 Calendar 路由、IndexedDB schema 和 UI 的 Desktop；只有服务端 config 对当前组织开放时显示 More/置顶入口。
5. 对内部组织开启写 gate，验证默认 Calendar、CRUD、幂等重放、版本冲突、软删除、多设备收敛、scope 切换和离线草稿。
6. 扩大 organization allowlist，监控 API error/latency、cursor reset、conflict、IndexedDB failure 和 migration readiness，再逐 deployment 开启。
7. 回滚优先关闭写 gate，再关闭 calendar enabled gate并隐藏 Desktop 入口；保留 additive 表、云端数据和按 scope 的本地缓存，不执行破坏性 down migration。
8. 修复后重新开启时，Desktop 用保留 cursor 继续同步；cursor 已失效则执行 bootstrap。若本地 cache schema 不兼容，只失效对应 calendar 分区，绝不迁移或合并到其他 scope。
