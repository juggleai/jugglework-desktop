# Proposal

## Why

JuggleWork 缺少一个由自身管理、可跨设备访问的办公日历，用户目前无法在产品内形成稳定的个人日程闭环。团队协作、会议和外部日历都依赖可靠的原生日历领域，因此需要先建立云端权威的数据、同步和 Desktop 月历基础。

## What Changes

- 新增云端权威的 Calendar 与 CalendarEvent 领域，支持个人日历、定时/全天/跨日日程、IANA 时区、搜索、软删除、稳定 ID、版本冲突和幂等写入。
- 新增按组织成员授权的日历 API 和增量变更游标；本阶段只启用所有者访问，但数据与服务边界为后续团队角色预留扩展点。
- 新增 JuggleWork Desktop 独立日历页面、More/可置顶导航入口、迷你月历、月视图、日历筛选、选中日议程和日程详情/编辑体验。
- 新增按 deployment、organization 和 member 隔离的本地查询缓存；支持离线查看已缓存范围和未提交表单草稿，但不支持离线写入或虚假“已保存”状态。
- 明确日历归属用户或云端组织，而不是本地文件工作区；核心日历操作不依赖 Agent 或 AI Provider。
- 会议、参会邀请、团队共享、重复日程、提醒、周/日时间轴、任务叠加和外部日历同步不属于本变更。

## Capabilities

### New Capabilities

- `cloud-calendar-management`: 云端权威的个人日历和日程模型、时间语义、授权、搜索、版本、幂等、软删除与增量变更。
- `desktop-calendar-month-view`: Desktop 日历入口、迷你月历、月视图、选中日议程和日程 CRUD 交互。
- `calendar-client-sync-cache`: 多端在线一致性所需的游标刷新、范围缓存、租户隔离、离线只读和草稿边界。

### Modified Capabilities

无。

## Impact

- `jugglework-server`：新增日历领域模型、数据库迁移、Repository、授权服务、HTTP API、变更记录与安全测试。
- `jugglework-desktop`：新增 `/calendar` 路由、More/可置顶导航、日历领域模块、API 客户端、查询缓存和月视图组件。
- 可能引入一个经许可证审核的日历布局依赖；日期基础组件和主题 token 应优先复用或抽取现有实现。
- 本变更是 `add-calendar-work-planning`、`add-team-calendar-collaboration` 和 `add-calendar-meeting-ecosystem` 的前置依赖。
