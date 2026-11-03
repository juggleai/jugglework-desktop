## Why

JuggleWork 当前缺少一个独立、持久、可指派、可提醒的日常待办系统，用户需要切换到外部产品记录和跟进事项。新增云端任务能力可以在 JuggleWork 内形成个人待办与组织协作闭环。

## What Changes

- 在 JuggleWork Desktop 的 More 菜单中增加“任务”入口和任务中心，并允许用户将其置顶到左侧竖向导航。
- 新增由 JuggleWork Server/Cloud 统一权威存储的私人任务与组织协作任务。
- 支持无负责人及多人负责、关注人、Viewer、开始/截止时间、提醒、优先级和任务清单。
- Desktop 侧栏主导航提供今日、我负责的、我关注的和活动；“快速访问”提供全部任务、我创建的、我分配的和已完成，并继续在其下展示任务清单。
- “我负责的”右侧提供持久化的 List/Board 工作台、服务端筛选排序、字段选择、分组、成员目录显示和任务/任务清单新建菜单。
- 支持任务评论、活动记录、取消、软删除和 30 天恢复；附件和一层子任务在 MVP-B 增量交付。
- 任务核心体验不依赖 Agent、模型或 AI Provider。
- IM 消息转任务、来源引用、聊天卡片和任务助手明确不属于本变更，将由独立的未来 OpenSpec 设计和交付，不阻塞核心 Tasks 完成。

## Capabilities

### New Capabilities

- `cloud-task-management`: 云端任务、多人负责、可见范围、状态、时间、提醒、搜索视图和生命周期管理。
- `task-list-collaboration`: 任务清单、清单成员角色、任务归类和归档恢复。
- `desktop-task-center`: Desktop 可置顶任务导航、系统视图、列表、详情、筛选、活动和回收站体验。

### Modified Capabilities

无。

## Impact

- `jugglework-server`：新增任务领域模型、数据库迁移、授权服务、API 和提醒调度。
- `jugglework-desktop`：新增 More/可置顶任务入口、路由、任务中心页面、客户端 API、缓存与通知集成。
- 组织成员与权限：复用 organization member 身份，并增加负责人、关注人、Viewer 和清单角色授权。
- 通知系统：增加任务事件、未读状态、云端提醒及多渠道幂等去重。
- 不引入 Agent 作为核心依赖，不改变现有 Session、Agent Todo 或 Automation 的领域语义。
