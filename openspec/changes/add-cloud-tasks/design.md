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

Desktop 任务侧栏将 Today、Assigned to me、Following、Activity 作为主导航；将 All tasks、Created by me、Assigned by me、Completed 放入默认展开且可折叠的 Quick access，并在其后保留任务清单及创建/归档操作。侧栏不展示 Inbox、Trash 或 Archived lists；旧会话中持久化的这些目标恢复为 Today。Assigned by me 使用 API view token `delegated`；当前 Desktop 实现时 Server checkout 尚无对应常量，因此按约定采用该 token，待 Server 实现保持一致。

### 10. Assigned-to-me List/Board 工作台

仅 Assigned to me 使用富工作台，其他系统视图维持简单列表。工作台按 deployment/user/organization/assigned scope 持久化 List/Board、状态、优先级、清单、逾期、排序、分组和字段设置。默认字段为任务标题、负责人、开始时间、截止时间、创建人、创建时间、任务 ID 和任务清单；标题不可关闭。List 使用可横向滚动的语义表格和粘性表头，Board 固定按 todo/completed/canceled 分列且不伪造拖拽排序。Start 排序仅排序当前已加载页，不向服务端发送不支持的 `start_at` sort。

列表页直接消费 `membersByTaskId: Record<string, DenProductTaskMember[]>`，避免逐任务详情请求；旧版页面响应省略该字段或缺少单个任务键时按空成员数组兼容，字段存在但类型错误时仍拒绝。成员显示通过组织成员 ID 连接分页读取的 `/api/v1/members?limit=200&offset=...` 目录；个人工作区目录拒绝时用 `/v1/me/orgs` 保留的 `orgMemberId`/`membershipId` 和当前用户摘要降级。任务清单分页读完后用于名称连接和筛选，清单连接失败时任务仍渲染并显示可重试的降级提示。

任务列表优先显示服务端分配的组织内递增编号，格式为小写 `t` 加十进制数字（例如 `t100134`）。稳定的内部任务 ID 不改变，继续用于路由、缓存和所有写操作；编号单元格保留精确复制内部 ID 的操作及完整 ID 提示。读取尚未提供 `displayNumber` 的旧 Server 时，Desktop 使用截断内部 ID 作为临时降级显示，不伪造可持久引用的短编号。

工具区新建菜单仅包含 New task 和 New task list，并使用项目 Dialog/DropdownMenu/Tabs 基础组件。全局 New task 提供标题、描述、负责人、开始时间、截止时间、优先级、可见范围和任务清单；Assigned to me 列表工具栏及末行还提供仅输入标题的行内创建，工具栏入口把输入行放在首行，末行入口把输入行放在其下方。Assigned to me 可识别当前成员时默认选择自己，侧栏所选清单作为默认清单。private 任务只能分配给自己，选择其他负责人时默认切换为 members。New task list 包含名称、描述、标记和 private 默认可见性。两种创建都按 deployment/user/organization scope 隔离迟到结果。

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
