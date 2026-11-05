# Proposal

## Why

月历 CRUD 只能完成基础记录，尚不足以支持真实办公排期。用户需要周/日时间轴、重复日程、可靠提醒、搜索与自然语言操作，才能把 JuggleWork 日历作为日常工作入口。

## What Changes

- 在 `add-cloud-calendar-core` 完成并稳定后，新增周视图、日视图、全天区域、重叠日程布局、当前时间线和拖拽改期/调整时长。
- 新增每日、每周、每月基础重复规则和单次例外，支持修改/删除“仅本次”或“整个系列”；不支持“本次及以后”和任意复杂 RRULE 编辑。
- 新增云端提醒计划、持久化投递状态和 Desktop 站内/系统通知；明确区分已生成、已获取、已请求展示和已读。
- 新增日程搜索及任务截止时间、自动化预计运行时间的只读叠加来源，来源条目必须回到原领域编辑。
- 新增不依赖页面挂载的 Agent 日历查询与写入能力；有歧义或高影响操作需要预览/确认，并复用日历授权、版本与幂等规则。
- 本阶段不新增团队共享、参会邀请、会议服务、会议室、对外预约或外部日历同步。

## Capabilities

### New Capabilities

- `calendar-time-planning`: 周/日时间轴、全天区域、重叠布局、拖拽改期和可访问的键盘排期体验。
- `calendar-recurrence-reminders`: 基础重复系列、单次例外、云端提醒生命周期和 Desktop 通知。
- `calendar-source-overlays`: 任务与自动化时间信息的只读日历投影、来源区分和回源导航。
- `calendar-agent-operations`: Agent 对日历的权限一致查询、创建、修改、删除、歧义处理和确认边界。

### Modified Capabilities

无。

## Impact

- 前置条件：`add-cloud-calendar-core` 已实施并验证其模型、API、Desktop 月视图和同步缓存契约。
- `jugglework-server`：扩展重复规则、实例展开、提醒调度、事件投递和范围查询。
- `jugglework-desktop`：新增时间轴视图、交互式改期、通知消费、来源适配和 Agent affordance/context 投影。
- `cloud-task-management` 与 Automation 保持各自权威；日历只消费授权后的只读投影，不复制或改写来源记录。
- 系统通知受操作系统权限和客户端运行状态约束；本阶段不承诺应用显式退出后的桌面弹窗。
