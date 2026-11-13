# Proposal

## Why

现有基础 Calendar 编辑器不能在一次排期中选择组织成员、展开群组、比较忙闲或创建基础重复日程。完整 `add-team-calendar-collaboration` 还包含团队授权、RSVP、通知、共同可用时间和多端撤权，本次 Desktop/Server 已落地的是更窄的个人日历排期编辑器，需要独立记录其真实边界，避免把未完成的邀请生命周期误报为已实现。

## What Changes

- 为个人日历新建/编辑提供双栏大尺寸排期编辑器，支持组织成员及群组参与人选择、去重和最多 20 人。
- 支持 30 分钟时间粒度，以及 daily/weekly/monthly 基础重复与 never/until/count 终止。
- 查询 Server scheduling occurrences 和 busy-only availability；无详情权限、失败或无法确认时显示 `unknown`，不泄露底层日程字段。
- scheduling 元数据失败或加载中时，普通事件仍可读，但相关编辑/删除保持 fail-closed；基础 Calendar bootstrap 仍可持久化为离线只读 baseline。
- 离线不查询 availability、不进行权威写入；参与人 scheduling aggregate 离线只读，草稿可保留排期字段。
- 日程可持久化是否启用 JuggleWork 视频会议；详情卡只在启用时提供发起会议动作，并把当前组织内日程参与人映射为会议邀请人后交给既有 Meeting 服务通知。
- 本变更不实现 RSVP、邀请/更新/取消通知、参与人自助响应、共同可用时间建议、单次重复例外或跨组织/外部联系人。

## Capabilities

### New Capabilities

- `calendar-scheduling-editor`: 个人日历中的组织内参与人选择、基础重复、busy-only 可用性展示和失败/离线安全边界。

### Modified Capabilities

无。完整 attendance/availability 生命周期仍由 `add-team-calendar-collaboration` 跟踪。

## Impact

- `apps/app`：Calendar DTO/query/cache/editor、详情卡、组织成员和群成员分页消费、重复、availability 及 Meeting 发起 UI。
- `jugglework-server`（独立仓库已部署的对应 API）：scheduling event/occurrence 与 availability 权威响应。
- OpenSpec：只关闭本 change 的窄范围任务，不关闭 `add-team-calendar-collaboration` 的 RSVP、通知、共享授权或完整 availability 任务。
