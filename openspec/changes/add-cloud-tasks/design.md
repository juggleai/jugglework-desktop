## Context

JuggleWork 当前具备组织成员、Desktop 一级导航、通知中心和云端 Go 服务，但不存在统一的产品级 Task 领域。Agent Todo、Session 和 Automation 具有不同生命周期，不能承担日常待办的身份。任务需要同时覆盖 private、指定成员和组织可见场景，并在 Agent 不可用时独立存在。

MVP 客户端为 JuggleWork Desktop，JuggleWork Server/Cloud 是任务唯一权威。功能跨越服务端存储/API/提醒、Desktop 导航与页面和通知中心等模块。

## Goals / Non-Goals

**Goals:**

- 建立独立、云端权威的 Task 领域和稳定 ID。
- 提供多人负责、关注、Viewer、无负责人、权限、状态、时间和提醒。
- 提供任务清单、系统视图、搜索分页、活动和软删除恢复。
- 使所有核心任务操作不依赖 Agent。
- 以 MVP-A 首发骨架支持后续 MVP-B 附件和子任务增量。

**Non-Goals:**

- 不复用 Agent Todo、Session 或 Automation 作为 Task 存储。
- 不实现甘特图、自定义字段/状态、复杂依赖、离线写入或多层子任务。
- 不在 MVP 中实现 Agent 自动执行、自动创建或自动完成任务。
- 不提供 Web/移动端完整任务中心。
- 不实现 IM 消息转任务、任务来源、聊天任务卡片、访问申请或任务助手；这些能力需要独立的未来变更。

## Decisions

### 1. Cloud/Server 单一写入权威

所有 private 和协作任务保存在 JuggleWork Server 数据库。Desktop 使用查询缓存但不形成第二权威，也不支持离线写入。相比本地优先再同步，这避免多人负责、提醒和软删除产生多主冲突。

### 2. 新建独立 ProductTask 聚合

服务端新增 task、task_member、task_list、task_list_member、task_comment、task_event、task_reminder 等存储。Task 只保存稳定业务字段。

### 3. 组织成员 ID 作为协作身份

创建人、负责人、关注人、Viewer 和清单成员均引用 organization member ID，而不是显示名或邮箱。成员显示信息通过组织目录投影读取。

### 4. 显式可见范围与角色并集授权

可见范围为 private、members、organization。members 的访问集合由创建人、负责人、关注人、Viewer 和清单成员组成。角色权限取并集，组织失效和服务端显式拒绝优先。

### 5. 乐观锁、幂等和软删除

Task 带单调递增 version，修改要求 expectedVersion；冲突返回明确结果而不静默覆盖。创建和关系写入接受 idempotency key。软删除保留 30 天，只有原创建人或当前清单管理员可读取最小墓碑并恢复。

### 6. 事件驱动通知与提醒

每次有意义的领域变化产生稳定 task event。通知中心和系统通知消费同一事件 ID 并按投递渠道去重。提醒由云端调度；每位接收人对同一任务最多一条有效提醒。

### 7. Desktop 采用独立路由和领域模块

Desktop 通过 More 菜单打开 `/tasks`，并允许用户将 Tasks 置顶到左侧竖向导航。任务领域拥有独立 API、query keys、页面和状态组件，不复用现有 session “task”命名。首批实现路由、导航和可加载骨架，再逐步接入真实云端数据。

### 8. 分阶段实施

MVP-A 先完成领域基础、CRUD/授权、Desktop 入口和关键通知；MVP-B 增加附件、子任务和完整清单管理。数据库和 API 从 MVP-A 起预留稳定扩展边界。IM 互操作不属于 MVP-A 或 MVP-B，将单独立项。

### 9. Desktop 任务侧栏信息架构

Desktop 任务侧栏将 Today、Assigned to me、Following、Activity 作为主导航；将 All tasks、Created by me、Assigned by me、Completed 放入默认展开且可折叠的 Quick access，并在其后保留任务清单及创建/归档操作。侧栏不展示 Inbox、Trash 或 Archived lists；旧会话中持久化的这些目标恢复为 Today。六个任务集合页使用 `all`/`completed` 基础视图加显式人员筛选参数表达页面语义，使默认条件可直接展示在筛选面板中；`delegated` token 仍保留为 API 兼容能力，但 Desktop 的 Assigned by me 页面不依赖其隐藏语义。

### 10. 统一的任务集合 List/Board 工作台

Assigned to me、Following、All tasks、Created by me、Assigned by me 和 Completed 使用同一套富工作台。工作台按 deployment/user/organization/section scope 分别持久化 List/Board、状态、优先级、清单、逾期、排序、分组和字段设置，页面之间不共享用户设置。默认字段为任务标题、负责人、开始时间、截止时间、创建人、创建时间、任务 ID 和任务清单；标题不可关闭。List 使用可横向滚动的语义表格和粘性表头，Board 固定按 todo/completed/canceled 分列且不伪造拖拽排序。Start 排序仅排序当前已加载页，不向服务端发送不支持的 `start_at` sort。

每次进入集合页时，Desktop 将该页语义填充为普通、可编辑的初始筛选，并通过普通列表查询参数执行：Assigned to me 为负责人包含当前成员；Following 为关注人包含当前成员且创建人、负责人均不包含当前成员；All tasks 无人员条件且初始状态为全部；Created by me 为创建人包含当前成员；Assigned by me 为负责人不包含当前成员且分配人包含当前成员；Completed 无人员条件且初始状态为已完成。用户可以修改、删除或清除这些条件，修改后立即影响查询；再次进入该集合页时恢复该页默认筛选。

列表页直接消费 `membersByTaskId: Record<string, DenProductTaskMember[]>`，避免逐任务详情请求；旧版页面响应省略该字段或缺少单个任务键时按空成员数组兼容，字段存在但类型错误时仍拒绝。成员显示通过组织成员 ID 连接分页读取的 `/api/v1/members?limit=200&offset=...` 目录；个人工作区目录拒绝时用 `/v1/me/orgs` 保留的 `orgMemberId`/`membershipId` 和当前用户摘要降级。任务清单分页读完后用于名称连接和筛选，清单连接失败时任务仍渲染并显示可重试的降级提示。

任务列表优先显示服务端分配的组织内递增编号，格式为小写 `t` 加十进制数字（例如 `t100134`）。稳定的内部任务 ID 不改变，继续用于路由、缓存和所有写操作；编号单元格保留精确复制内部 ID 的操作及完整 ID 提示。读取尚未提供 `displayNumber` 的旧 Server 时，Desktop 使用截断内部 ID 作为临时降级显示，不伪造可持久引用的短编号。

工具区新建菜单仅包含 New task 和 New task list，并使用项目 Dialog/DropdownMenu/Tabs 基础组件。全局 New task 采用固定且受视口约束的紧凑弹窗高度，描述编辑器默认展开，弹窗外框保持 460px 固定紧凑高度，编辑器自身保持 168px 固定高度；顶部与底部采用紧凑内边距，并提供无边框标题、负责人、工作台自定义分组、今天/明天/其他时间截止日期、可搜索或新建的任务清单、描述和关注人。负责人、截止时间、任务清单和描述左侧图标在新建弹窗和任务详情面板中均在鼠标悬停或键盘聚焦时显示对应字段提示。点击描述后展开带底部格式工具栏的编辑区，支持加粗、删除线、斜体、下划线、有序/无序列表、引用、链接、表情、提及和图片标记，并将生成的文本标记作为任务描述持久化。关注人入口通过覆盖 DialogFooter 的响应式默认对齐规则固定在弹窗底部左侧，图标、头像/人数或提示文字紧邻显示，且不展示多余的下拉箭头。选择非默认自定义分组后，创建成功的任务 ID 写入当前工作台的 `customGroupAssignments`；弹窗中新建分组更新当前工作台 `customGroups`。新建清单先持久化清单，再将返回 ID 放入任务创建输入。Assigned to me 列表工具栏及末行还提供仅输入标题的行内创建，工具栏入口把输入行放在首行，末行入口把输入行放在其下方。新任务负责人默认留空，侧栏所选清单仍作为默认清单。仅选择当前成员时任务保持 private；选择其他负责人或关注人时自动使用 members 可见性。New task list 包含名称、描述、标记和 private 默认可见性。两种创建都按 deployment/user/organization scope 隔离迟到结果。

### 11. Today 每日行动视图

Today 不复用富工作台，而使用专用的紧凑行动视图。Desktop 将服务端 `view=today` 返回的待办任务互斥归入 Overdue、Due today 和 Starts today：逾期优先于今天截止，今天截止优先于今天开始。仅日期任务当前以本地午夜值兼容表达，并在截止日结束前保持 Due today；非午夜的具体截止时间一旦早于当前时间即进入 Overdue。页面展示当前已加载的待处理数、逾期数、任务清单、当前成员与任务的主要关系、负责人和时间，并保留服务端分页。

Today 任务行复用权威详情读取、权限检查、多负责人确认和生命周期 mutation 后再完成任务；标题打开现有右侧详情面板。Today 不提供通用筛选、排序、Board、字段设置或标题栏创建入口。由于当前 `view=today` 只返回 `todo`，首版不伪造“今天已完成”分组；待服务端提供完成任务集合或准确摘要后再接入。

### 12. 聚合动态、接收人投影与已读权威

聚合动态使用服务端权威事件时间线，不从任务列表逐项请求单任务 Activity，也不复用只承载提醒增量投递的 `/v1/task-events`。服务端为每条稳定 `eventId` 生成接收人投影，并以单调递增 `sequence`、不透明游标和服务端 read state 支持多设备一致的分页与已读。接收人集合为任务创建人、负责人、关注人、显式 Viewer 和相关清单成员的并集；`organization` 可见性只授权按需读取，不将每个组织可见任务的事件主动投影给全组织。事件读取时仍重新执行当前权限裁剪；用户失去权限后，响应不得泄露历史标题、评论摘录、清单名或发生时间等受限内容。

聚合接口为 `GET /v1/task-activity?cursor=<opaque>&limit=30&unreadOnly=false`，返回 `items`、`nextCursor`、`hasMore`、`unreadCount` 和 `latestSequence`。单条已读使用 `PUT /v1/task-activity/:eventId/read`；全部已读使用 `PUT /v1/task-activity/read` 和 `{ "throughSequence": number }`，确保并发到达且 sequence 更大的事件不会被误读。事件分为 `ambient`、`attention` 和 `urgent`：普通事件仅进入动态；重要事件进入未读和通知中心；紧急事件还可按策略触发系统通知。自己触发的事件可在动态中显示，但不标记为未读且不通知自己。动态、通知中心、Tasks 角标和系统通知共享稳定 `eventId`，本机 `localStorage` 通知状态不作为业务已读权威。

Desktop 始终读取全部动态第一页作为侧栏未读摘要；进入 Activity 后按全部/未读使用独立 query key 和游标分页，按本地日历分组并保持服务端 sequence 倒序。点击动态先请求单条已读，并用内部 `taskId` 打开现有详情；点击清单名打开对应清单工作台。服务端在序列化任何受限内容前直接裁剪已失去当前任务权限的投影；Desktop 仍保留不可访问占位兼容能力，但不依赖服务端返回历史标题、清单、actor 或时间。服务端端点未发布或失败时，Desktop 显示真实错误和重试，不将失败伪装成空动态。任何可能产生任务事件的成功 Desktop mutation 都使聚合动态缓存失效。

任务详情标题和描述不再使用独立保存按钮：标题失焦或焦点离开整个描述富文本编辑器时自动保存；点击日期、清单、分组等选择控件会先触发该保存。描述区复用创建弹窗的 168px 富文本编辑器样式与工具栏，编辑器内部切换格式不触发失焦保存。任务详情使用固定右侧工作面板，并以高于工作台粘性表头的独立层级和完全不透明背景渲染，避免列表边框、表头或内容穿透遮挡。顶部左侧以 Complete task / Completed 按钮直接切换 todo 与 completed，顶部右侧提供 Follow / Following 将当前成员加入或移出 follower 关系。详情主体展示标题、负责人、截止时间、任务清单和当前工作台自定义分组；任务清单遵循 Server 的单一 `listId` 模型，支持搜索、切换和内联创建，不伪造多清单关系；自定义分组继续存储在当前工作台设置并可内联创建。子任务和附件入口本期不实现。评论区与任务字段之间使用分割线，评论按作者、时间和正文展示；底部固定评论输入框支持加粗、表情、提及和图片文本标记，Enter 直接发送，Shift+Enter 插入换行，输入法组合期间不触发发送。面板最底部显示关注人头像和人数，并通过加号多选添加或取消关注人；选择其他组织成员时按权限自动提升为 members 可见性。

List 任务行的横向分割线以行内伪元素绘制，左侧从标题内容缩进处开始，右侧在表格边缘前结束，不再顶到两侧。任务详情打开时在面板下方放置透明点击层；点击详情面板之外只关闭详情并阻止该次点击穿透到底层任务列表。

任务模型继续支持 none/low/medium/high 优先级，并可按优先级筛选；Assigned to me 排序菜单聚焦开始时间、截止时间、创建时间、更新时间和完成时间，不提供优先级排序入口。

## Risks / Trade-offs

- [跨服务范围大] → 按服务端领域、Desktop 入口、提醒通知分批交付，每批保持可测试。
- [权限泄露] → 所有查询和搜索统一走服务端授权；客户端隐藏不作为安全措施。
- [通知风暴] → 仅关键领域事件主动投递，普通字段变化进入活动；使用 event ID 和 delivery key 去重。
- [多人完成误操作] → `any_assignee` 在完成前明示整体完成语义；`all_assignees` 显示当前负责人的独立完成进度，并在最后一人完成前保持任务待办。
- [创建人离职形成孤儿任务] → 清单管理员接管；无清单协作任务由组织 Owner/Admin 转移创建人。
- [术语冲突] → 服务端/客户端领域内部优先使用 ProductTask 或 CloudTask，UI 统一显示“任务”。
- [首版范围过大] → MVP-A/B 分阶段，附件和子任务不阻塞 MVP-A 首发。

## Migration Plan

1. 以向后兼容迁移新增任务表、索引和枚举，不修改现有 Session/Automation 表。
2. 发布只读/健康检查与基础 CRUD API，并在服务端 feature flag 下启用。
3. 发布 Desktop 任务入口和空状态，再逐步启用真实列表和编辑能力。
4. 启用云端提醒和通知渠道。
5. 完成安全、幂等、并发和迁移测试后扩大灰度。
6. 回滚时关闭入口和写 API；保留新增表，不执行破坏性降级，待修复后重新启用。

## Open Questions

- 生产环境现有数据库方言和迁移框架下，全文搜索首版采用数据库原生搜索还是受限前缀/包含查询，由技术实现调研决定。
- 组织 Owner/Admin 转移孤儿任务的管理入口放在任务 UI 还是组织控制台，可在 MVP-A 后续小版本确定。
