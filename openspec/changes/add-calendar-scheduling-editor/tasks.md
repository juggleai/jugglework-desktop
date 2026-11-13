# Tasks

## 1. Scheduling contracts and queries

- [x] 1.1 增加严格 scheduling event/occurrence、recurrence、attendee 和 availability DTO/normalizer；拒绝未知或结构不完整 payload。
- [x] 1.2 增加有界 occurrence 与 availability query keys/hooks，并以 scheduling aggregate seed canonical event version。
- [x] 1.3 合并 core/team/scheduling 结果：单次参与人事件保留真实 ID，重复 occurrence 使用 synthetic ID 且只读。

## 2. Editor and validation

- [x] 2.1 增加双栏大尺寸新建排期 UI、30 分钟 timed 输入和 daily/weekly/monthly + never/until/count 重复规则。
- [x] 2.2 增加组织成员与群组参与人选择、完整群成员分页/目录映射、去重、结果反馈及 20 人 UI/validator 双层硬限制。
- [x] 2.3 增加 busy-only 时间轴、unknown/加载/失败/离线状态和隐私说明，不渲染底层日程详情。
- [x] 2.4 保持编辑的原始 expected-version 基准；后台 authority 新版本触发显式 conflict，不能保留旧表单同时静默推进 base。
- [x] 2.5 个人日程默认并强制包含创建人参与者；picker 不可移除，validator 防绕过补齐，20 人上限包含创建人，团队日历保持独立 owner 边界。
- [x] 2.6 持久化视频会议启用状态；详情卡支持外部点击关闭，并在启用时通过既有 Meeting 服务创建即时会议、邀请全部可映射日程参与人和发送邀请通知。

## 3. Failure and offline boundaries

- [x] 3.1 Scheduling 加载/失败时普通 Calendar 仍可读，但无法分类的个人事件编辑/删除保持 fail-closed。
- [x] 3.2 Scheduling 失败不阻止普通 core bootstrap 写入离线 baseline；fresh scheduling success 时才持久化合并 occurrence。
- [x] 3.3 离线不调用 availability 或权威写入；参与人 aggregate 只读，排期草稿保留 attendees/recurrence 且不自动提交。

## 4. Verification and explicit exclusions

- [x] 4.1 添加 DTO/query、编辑器、validation、occurrence identity、冲突、离线 baseline/draft、视频会议发起和 scheduling failure 回归测试。
- [x] 4.2 运行 App typecheck、聚焦 Calendar 测试和生产 build；记录严格 i18n 的历史 locale coverage 基线，不用本 change 批量修改旧翻译。
- [x] 4.3 明确 RSVP、邀请/更新/取消通知、参与人响应、共同可用时间和重复例外仍未实现，继续由 `add-team-calendar-collaboration`/`add-calendar-work-planning` 跟踪。
