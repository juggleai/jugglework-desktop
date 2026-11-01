## Context

JuggleWork 当前具备组织成员、组织内 IM、Desktop 一级导航、通知中心和云端 Go 服务，但不存在统一的产品级 Task 领域。Agent Todo、Session、Automation 和 IM 消息具有不同生命周期，不能承担日常待办的身份。任务需要同时覆盖 private、指定成员和组织可见场景，并在原消息删除、成员退出群聊或 Agent 不可用时独立存在。

MVP 客户端为 JuggleWork Desktop，JuggleWork Server/Cloud 是任务唯一权威。功能跨越服务端存储/API/提醒、Desktop 导航与页面、IM 消息菜单和卡片、通知中心等模块。

## Goals / Non-Goals

**Goals:**

- 建立独立、云端权威的 Task 领域和稳定 ID。
- 提供多人负责、关注、Viewer、无负责人、权限、状态、时间和提醒。
- 提供任务清单、系统视图、搜索分页、活动和软删除恢复。
- 打通 IM 消息转任务、来源引用、受限任务卡片和任务助手。
- 使所有核心任务操作不依赖 Agent。
- 以 MVP-A 首发骨架支持后续 MVP-B 附件和子任务增量。

**Non-Goals:**

- 不复用 Agent Todo、Session 或 Automation 作为 Task 存储。
- 不实现甘特图、自定义字段/状态、复杂依赖、离线写入或多层子任务。
- 不在 MVP 中实现 Agent 自动执行、自动创建或自动完成任务。
- 不提供 Web/移动端完整任务中心。

## Decisions

### 1. Cloud/Server 单一写入权威

所有 private 和协作任务保存在 JuggleWork Server 数据库。Desktop 使用查询缓存但不形成第二权威，也不支持离线写入。相比本地优先再同步，这避免多人负责、提醒和软删除产生多主冲突。

### 2. 新建独立 ProductTask 聚合

服务端新增 task、task_member、task_list、task_list_member、task_source、task_comment、task_event、task_reminder 等存储。Task 只保存稳定业务字段；与 IM 来源通过引用连接，不把消息生命周期变成任务生命周期。

### 3. 组织成员 ID 作为协作身份

创建人、负责人、关注人、Viewer 和清单成员均引用 organization member ID，而不是显示名、邮箱或 IM 群成员行 ID。成员显示信息通过组织目录投影读取。

### 4. 显式可见范围与角色并集授权

可见范围为 private、members、organization。members 的访问集合由创建人、负责人、关注人、Viewer 和清单成员组成。角色权限取并集，组织失效和服务端显式拒绝优先。Task 和 IM 来源分别鉴权。

### 5. 乐观锁、幂等和软删除

Task 带单调递增 version，修改要求 expectedVersion；冲突返回明确结果而不静默覆盖。创建和关系写入接受 idempotency key。软删除保留 30 天，只有原创建人或当前清单管理员可读取最小墓碑并恢复。

### 6. 事件驱动通知与提醒

每次有意义的领域变化产生稳定 task event。通知中心、任务助手和系统通知消费同一事件 ID 并按投递渠道去重。提醒由云端调度；每位接收人对同一任务最多一条有效提醒。

### 7. IM 卡片按查看者鉴权

完整卡片只发送给全部有权的受众；否则使用不含任务字段的受限卡片。申请访问通过 Viewer ACL 完成。点击卡片时重新鉴权并读取最新状态。

### 8. Desktop 采用独立路由和领域模块

Desktop 左侧导航新增 `/tasks`，任务领域拥有独立 API、query keys、页面和状态组件，不复用现有 session “task”命名。首批实现路由、导航和可加载骨架，再逐步接入真实云端数据。

### 9. 分阶段实施

MVP-A 先完成领域基础、CRUD/授权、Desktop 入口、文本消息转任务和关键通知；MVP-B 增加图片/文件来源、附件、子任务和完整清单管理。数据库和 API 从 MVP-A 起预留稳定扩展边界。

## Risks / Trade-offs

- [跨服务范围大] → 按服务端领域、Desktop 入口、IM 集成、提醒通知分批交付，每批保持可测试。
- [权限泄露] → 所有查询、搜索、卡片和来源读取统一走服务端授权；客户端隐藏不作为安全措施。
- [通知风暴] → 仅关键领域事件主动投递，普通字段变化进入活动；使用 event ID 和 delivery key 去重。
- [多人完成误操作] → 多负责人任务完成前在 UI 明示整体完成语义。
- [创建人离职形成孤儿任务] → 清单管理员接管；无清单协作任务由组织 Owner/Admin 转移创建人。
- [术语冲突] → 服务端/客户端领域内部优先使用 ProductTask 或 CloudTask，UI 统一显示“任务”。
- [首版范围过大] → MVP-A/B 分阶段，附件和子任务不阻塞 MVP-A 首发。

## Migration Plan

1. 以向后兼容迁移新增任务表、索引和枚举，不修改现有 Session/Automation 表。
2. 发布只读/健康检查与基础 CRUD API，并在服务端 feature flag 下启用。
3. 发布 Desktop 任务入口和空状态，再逐步启用真实列表和编辑能力。
4. 启用 IM 文本消息转任务、任务卡片与任务助手。
5. 启用云端提醒和通知渠道。
6. 完成安全、幂等、并发和迁移测试后扩大灰度。
7. 回滚时关闭入口和写 API；保留新增表，不执行破坏性降级，待修复后重新启用。

## Open Questions

- 生产环境现有数据库方言和迁移框架下，全文搜索首版采用数据库原生搜索还是受限前缀/包含查询，由技术实现调研决定。
- 任务助手复用现有系统 Bot 还是新增专用 Bot 身份，由 IM 协议设计阶段确认。
- 组织 Owner/Admin 转移孤儿任务的管理入口放在任务 UI 还是组织控制台，可在 MVP-A 后续小版本确定。
