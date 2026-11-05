# Design

## Context

本变更建立在 `add-cloud-calendar-core` 已完成并稳定的前提上。该前置变更提供云端权威 Calendar/CalendarEvent、IANA 时区、所有者授权、版本与幂等写入、范围查询、增量游标、Desktop 月视图及隔离缓存；本设计不复制这些基础契约。动机和产品范围见 `proposal.md`，可观察行为见四个 capability specs。

工作排期跨越 `jugglework-server` 的重复展开与提醒调度、Desktop 的周/日布局与通知消费、Task/Automation 的只读来源查询，以及 Agent runtime 的页面无关操作。Calendar 仍是个人日历领域，不引入团队共享、邀请、参会人、会议服务或会议室模型。

## Goals / Non-Goals

**Goals:**

- 在不改变 core 单一云端写入权威的前提下增加可有界展开的重复系列与单次例外。
- 让周/日布局、拖拽和键盘替代共享同一 mutation intent 与版本/幂等写入路径。
- 建立可恢复、可撤销、可去重且状态含义明确的云端提醒链路。
- 通过来源适配器读取 Task 截止时间和 Automation 权威 next-run，不复制来源记录。
- 将 Agent 查询、预览和写入注册在页面之外，并与第一方客户端共用授权和并发契约。

**Non-Goals:**

- 不实现任意 RRULE、年度重复、“本次及以后”或离线日历写入。
- 不把重复实例全部物化为 CalendarEvent，也不让 Calendar 成为 Task/Automation 的写入入口。
- 不承诺应用显式退出、设备关机或系统禁止通知时仍出现桌面弹窗。
- 不建立新的模型身份或绕过成员授权的 Agent 权限层。
- 不增加团队日历、参会邀请、会议、会议室、外部预约或外部日历同步。

## Decisions

### 1. 前置 core 是硬发布门槛，不做双轨兼容

实现直接扩展 `add-cloud-calendar-core` 的稳定 CalendarEvent、授权、版本、幂等、游标和缓存契约。Server feature flag 只有在 core 数据迁移、API 和 Desktop 同步契约已验证后才能开启；本变更不添加缺失 core 时的本地替代存储或旧 API 兼容分支。

选择该方案是为了避免两套事件身份、时区和冲突语义。备选方案是在本变更内兼容临时本地事件，被否决，因为上线后需要多主迁移且会破坏 Agent 与 Desktop 的一致写入边界。

### 2. 系列主记录加稀疏例外，不预生成无限实例

重复事件由一个系列主记录保存事件内容、起止墙上时间、IANA 时区、全天日期语义、基础规则、终止条件和单调递增版本。例外记录使用 `(series_id, original_occurrence_key)` 唯一约束，保存 `modified` 或 `canceled` 状态及必要覆盖字段；例外本身也有版本和软删除信息。

`original_occurrence_key` 表示规则在系列时区中的原始槽位：全天事件使用原始本地日期，定时事件使用原始本地日期和墙上开始时间，并携带规则身份所需的稳定编码。它不随实例改期而变化，也不以可能因 DST 改变的 UTC instant 作为唯一身份。单次修改继续更新同一例外，不产生第二个有效实例。

仅本次操作写例外；整个系列操作更新或软删除系列主记录。更新规则前先计算会失去原始槽位的现有例外并纳入预览，确认后在同一事务中按规范确定性删除这些孤儿例外。API 枚举只接受 `this occurrence` 和 `entire series`。

备选方案是为每个实例写 CalendarEvent，虽然查询简单，但无限系列、规则修改、DST 和提醒重算会产生大量写放大与身份迁移，因此被否决。

### 3. 服务端执行有界、确定性的范围展开

范围 API 接收必需的起止 instant、显示时区、日历过滤和分页/结果上限。服务端选择可能与范围相交的单次事件和系列，按系列时区从足够早的原始槽位开始展开，将例外按 original key 合并，再以有效区间与请求范围相交为准过滤。查询同时读取“原始槽位在范围内”和“例外有效时间在范围内”的例外，因此移出范围的实例不会残留，移入范围的实例不会遗漏。

展开器是 Server、提醒调度和测试共享的纯领域组件；Desktop 不自行实现另一套重复算法。结果按有效 start、all-day/timed、稳定 ID 排序，使用 cursor 和硬上限阻止无限或恶意范围消耗。增量游标发布系列或例外变化，客户端据此使受影响缓存范围失效，而不是发送每个虚拟实例的 change row。

备选方案是由每个客户端展开 RRULE，被否决，因为不同版本会在 DST、月末和例外合并上产生不一致，Agent 也无法得到同一结果。

### 4. DST 以系列时区的墙上时间为权威

重复规则保存本地日期/时间和 IANA timezone，不保存固定 UTC offset 作为未来规则。每个槽位解析为 instant 时，不存在的本地开始时间取当天 gap 后第一个有效 instant，重复的本地开始时间取较早 instant；不存在的月日直接跳过。定时事件默认保持 elapsed duration，除非单次例外明确改变边界。全天事件始终使用独占 end date，不通过午夜 instant 推导日期长度。

original key 在 instant 解析之前生成，因此时区数据库更新或 offset 变化不会把同一规则槽位变成另一个实例。范围结果仍返回解析所依据的 series timezone 和 original key，便于客户端稳定引用。

备选方案是按首次创建时的 UTC instant 固定重复间隔，被否决，因为 09:00 周会在 DST 后漂移；按每次解析的 UTC instant 作为实例 ID 也会破坏例外关联。

### 5. 周/日视图使用统一的展示模型和纯布局算法

Desktop 将单次事件、展开实例和只读来源投影标准化为带稳定 display key、source kind、effective interval、all-day 标记、权限和版本的展示项。全天布局使用日期区间分配行，超出折叠容量时保留可访问的 overflow 列表；跨日定时项按可见日裁剪成展示片段，但所有片段指向同一业务身份。

定时重叠布局先按日期分区，再按 start 升序、duration 降序、stable key 排序；使用半开区间 `[start, end)` 构造连通 overlap group，并以确定性 lane 分配计算位置。布局只产生几何信息，不修改领域时间。

当前时间线由独立于数据 query 的轻量时钟驱动，按下一个分钟边界更新，并在显示时区日期变化、系统唤醒或 timezone 改变时重新计算。它只在当前本地日期可见时渲染并提供文本标签。

备选方案是把各类来源直接交给 UI 组件临时分支处理，被否决，因为会导致跨日、重叠、键盘焦点和来源样式行为分叉。

### 6. 拖拽和键盘操作生成同一种 mutation intent

拖拽只维护临时 preview，drop 后生成结构化 intent：目标事件/series/original key、scope、原 expectedVersion、原时间、目标时间、操作种类和新 idempotency key。键盘“移动/调整时长”对话或 popover 生成完全相同的 intent，并显示明确日期、时间、时区和范围。两种输入都走同一个验证、确认、mutation 和冲突恢复流程。

客户端乐观状态标为 pending，不在服务端确认前显示为已保存。版本冲突时撤销 preview、加载授权后的最新记录，同时保留用户 intent 供比较或重试；重试同一网络请求复用 key，用户基于新版本重新提交则生成新 key。只读 overlay 不具备生成 intent 的能力。

备选方案是分别实现 drag endpoint 与表单 endpoint，被否决，因为会产生不同的权限、最小时长、系列范围和幂等行为，也无法证明键盘等价。

### 7. 提醒采用定义、调度工作、业务事件和投递游标四层状态

事件/系列保存 reminder definition（稳定 ID 和 offset）；云端 scheduler 在滚动 horizon 内为单次事件或展开实例创建 reminder work。重复实例 work 唯一键包含 definition、recipient 和 original occurrence key，单次事件使用 event identity。work 保存 due instant、源版本和 `scheduled/canceled` 状态；到期 claim 与业务 reminder event 的 `generated` 提交在同一事务中完成。

业务事件一旦 generated 就是审计事实。每位 recipient 的 delivery 记录独立推进 `generated -> fetched -> display_requested -> read`，并允许在任何未读阶段标记 canceled；这些字段是单调事实而不是互相冒充。`display_requested` 仅表示一个运行中的客户端请求了 in-app/OS 展示，不表示操作系统实际显示。安装级 channel key 防止同一 Desktop 重连时重复请求，本人跨设备共享业务事件与 read 状态，但各安装可各请求一次本地展示。

事件时间、规则、例外、offset、删除状态或访问权限变化时，在领域写事务中记录重算请求；调度器按最新源版本锁定相关 work，取消过时的未生成 work，并创建替代 work。已生成事件不删除，必要时标记 canceled 并停止后续投递。唯一约束和 transactional claim 处理 worker 并发、重启和至少一次消息重放。

Desktop runtime 活跃时持续拉取/订阅 reminder event，写入站内通知状态，并在平台权限允许时请求系统通知。显式退出后只保留云端事件供下次 fetch，不运行常驻 helper，因此不作到点桌面弹窗承诺。

备选方案是仅用客户端 timer，被否决，因为多设备、应用隐藏、规则编辑和重启会丢失或重复；把 fetched 当 delivered/read 也被否决，因为无法表达 OS 抑制和用户未读。

### 8. 来源 overlay 通过领域适配器查询，不复制记录

Server 或 Desktop data layer 为 Task 和 Automation 分别提供 adapter，输入当前 deployment/organization/member、授权上下文和有界范围，输出统一的只读 `CalendarOverlayItem`。Task adapter 将 due instant 映射为 timed 项，将仅有 due date 的任务映射为来源时区的 all-day 项；Automation adapter只读取其权威 `next_run_at`，不在 Calendar 重算 schedule。

每个 adapter 调用来源领域的授权查询，缓存键包含来源、tenant/member、范围和来源 cursor。适配失败按来源隔离，CalendarEvent 仍可显示。投影只保存短期查询缓存和 stable source reference，不写 CalendarEvent。打开或编辑投影时只把 source type、source ID 和 return location 交给来源领域，由来源领域重新授权并加载当前版本。

备选方案是监听来源变化并复制为 CalendarEvent，被否决，因为会制造双重身份、删除同步和错误的 Calendar 编辑入口；由 Calendar 复制 Automation 规则并计算 next-run 也会与其真实暂停、运行和调度状态分叉。

### 9. Agent affordance 注册在 runtime service，而非 React 页面

Calendar runtime service 暴露有界 query/search/detail、create/update/delete、recurrence instance/series mutation、reminder mutation和 preview/confirm affordance。注册发生在认证 runtime 初始化阶段，依赖 API client 和当前成员上下文，不捕获组件 state、页面 query cache 或 DOM。页面可用同一 typed client，但不是 affordance 的宿主。

Agent 输入先规范化为结构化 date/time/timezone、target ID、scope、expectedVersion 和 idempotency key；权限在查询、preview 和执行三个阶段均由 Server 重验。模型不是 calendar principal，服务端以当前 member 授权并记录 `agent` origin。读操作要求有界范围；写操作调用 core 的同一 command boundary，不新增绕过权限的“AI API”。

备选方案是让 UI control 打开日历页后操作表单，被否决，因为依赖页面挂载、焦点和易变布局，也无法可靠共享版本和幂等语义。

### 10. 歧义解析和高影响确认是 affordance 协议的一部分

自然语言层只负责形成候选条件，Server 返回权限过滤后的 bounded candidates。目标、日历、时区、日期或 recurrence scope 有实质歧义时，runtime 返回 clarification，不选择“最可能”对象。后续使用 stable candidate ID 并重新读取版本。

整个系列删除、影响多个实例/例外的系列修改和有界批量写入先生成 preview。preview 包含 member/tenant、操作规范化 payload、目标版本集合、影响 horizon 与计数、例外后果和过期时间的摘要 hash；confirmation token 单次使用并绑定该 hash。执行前重验 token、版本和权限，任何变化都使 preview stale。普通、明确的单条创建/低影响更新可直接执行；删除按 spec 区分当前指令是否已明确确认精确目标。

备选方案是依赖模型自行记住并复述确认，被否决，因为重试或上下文变化可能让确认应用到另一版本或目标。

## Risks / Trade-offs

- [Risk] 大范围或高频系列造成展开资源消耗 → 强制范围、cursor、结果/候选上限和每系列展开预算，并记录拒绝与耗时指标。
- [Risk] IANA timezone 数据版本差异导致 Server 与 Desktop 预览不一致 → Server 返回 canonical instants 和 timezone；最终保存/提醒以 Server 展开为准，并用固定 tzdata 测试覆盖 DST 边界。
- [Risk] 系列修改误删有价值的例外 → whole-series preview 明示 orphan 数量和后果，版本绑定确认，并保留审计/软删除恢复数据。
- [Risk] 提醒重算与到期 claim 竞态产生旧提醒 → 事务源版本、唯一键和 claim 前最新授权/版本检查；生成后只能取消投递而不能改写历史。
- [Risk] 多设备重复系统通知 → 业务事件按 recipient 去重、display request 按 installation/channel 去重；接受不同设备各展示一次的产品取舍。
- [Risk] 来源 API 部分失败使混合视图不完整 → 分来源错误和重试，不用陈旧投影冒充最新，且不阻断 CalendarEvent 查询。
- [Risk] Agent preview horizon 无法代表无限系列全部影响 → preview 明示有界 horizon、规则级影响和已知例外总数，不把 horizon count 表述为永久总数。
- [Trade-off] 不物化全部实例使范围查询和 whole-series 影响分析更复杂 → 换取有限存储、稳定规则编辑和统一 DST 语义，由共享展开器集中承担复杂度。
- [Trade-off] 显式退出后无桌面弹窗 → 保持进程生命周期和平台政策真实，云端仍保留未读提醒供下次启动。

## Migration Plan

1. 验证 `add-cloud-calendar-core` 的迁移、授权、版本/幂等、范围 API、增量游标和 Desktop 缓存测试全部通过；未满足时保持本变更 flags 关闭。
2. 以 additive migration 增加 recurrence definition、exception、reminder definition/work/event/delivery 结构、唯一约束和索引；旧单次事件保持无 recurrence 数据即可读取。
3. 在关闭写入口的 feature flag 下部署共享展开器、只读范围 API 和提醒 shadow calculation，比较单次事件结果及调度指标，不发送通知。
4. 为内部成员灰度 recurrence 写入与周/日视图；先开启只读布局，再开启拖拽/键盘 mutation，监控冲突、展开预算和错误率。
5. 开启 reminder generation，再分别灰度站内通知和 OS display request；通过重复率、撤销延迟、状态转换和过期 backlog 指标设门槛。
6. 独立灰度 Task/Automation adapters；每个来源可单独关闭，关闭时不影响 CalendarEvent。随后开启 Agent query，最后开启带 preview/confirmation 的 Agent writes。
7. 扩大灰度前完成 Server/desktop 单元、属性、集成、迁移、授权、DST、并发、可访问性、通知和端到端测试，并验证 telemetry 不含事件私密内容。
8. 回滚时依次关闭 Agent writes、来源 overlay、提醒 display/generation、交互写入和 recurrence create/edit；保留可读 API 与 additive 数据，不破坏性降级。已生成提醒保留审计状态，恢复前不重新生成同一 identity。
