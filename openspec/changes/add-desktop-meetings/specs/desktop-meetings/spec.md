## ADDED Requirements
### Requirement: Organization meetings
Desktop SHALL expose a meeting workspace with upcoming meetings, scheduling and calendar, scoped to the active authenticated organization.
#### Scenario: No media configuration
- **WHEN** ZEGO configuration is absent
- **THEN** Desktop shows the missing-configuration state and does not simulate a successful call.

#### Scenario: Personal workspace or unconfirmed organization
- **WHEN** the active workspace is personal or Desktop cannot confirm a signed-in team organization matching the current request scope
- **THEN** Desktop SHALL NOT request Meeting overview settings or lists, or poll for Meeting start reminders
- **AND** switching scope discards in-flight overview and reminder results from the previous scope.

#### Scenario: Overview is hidden or background reads are forbidden
- **WHEN** the confirmed team organization is active but the Meeting workspace is not visible
- **THEN** Desktop SHALL NOT refresh the Meeting overview; the independent start reminders still follow the user's preferences
- **AND** an HTTP 403 in either workflow pauses that workflow's automatic reads until the scope changes or the user explicitly retries or re-enables the workflow.

### Requirement: Independent meeting transport
Meeting SHALL use ZEGO for media and JuggleIM chatrooms for meeting chat, without using JuggleCall.
#### Scenario: Private chat adds a third participant
- **WHEN** an authorized attendee invites another organization member
- **THEN** that member can access meeting chat but cannot access the source private conversation.
### Requirement: Group admission
Current members of a meeting's source organization group SHALL be able to join without individual invitation.
#### Scenario: Former member attempts admission
- **WHEN** a former group member with no separate invitation attempts to join
- **THEN** the server denies admission.

### Requirement: Stable meeting interaction
Desktop SHALL preserve video capture during audio-only changes and reuse the active meeting window.
#### Scenario: Microphone toggled during video
- **WHEN** the attendee enables or mutes their microphone
- **THEN** the video stream and rendered video element remain intact.
#### Scenario: Rejoin the active meeting
- **WHEN** an attendee clicks Join for the meeting they are already attending
- **THEN** Desktop focuses its existing window without opening another admission preview.

### Requirement: Persistent compact window
Desktop SHALL show compact controls when the full meeting window is unfocused, minimized or hidden.
#### Scenario: Another window takes focus
- **WHEN** another window covers the meeting
- **THEN** compact controls appear while the full meeting window remains open.
#### Scenario: Return to the meeting
- **WHEN** the full meeting window regains focus
- **THEN** compact controls hide without recreating the meeting renderer.

### Requirement: Member attendance and targeted invitations
Desktop SHALL distinguish active participants from absent members and allow invitations on absent member rows.
#### Scenario: Invite an absent member
- **WHEN** an attendee invites one absent member
- **THEN** authorization is saved and a private JuggleIM meeting card is sent only to that member; invitation delivery alone does not mark them present.

### Requirement: Stable scheduling display
Background refresh SHALL retain schedule content during loading.
#### Scenario: User opens the meeting workspace
- **WHEN** the meeting workspace has loaded
- **THEN** a launcher sidebar exposes start, join and schedule actions while the overview keeps upcoming and historical meetings in chronological sections.
#### Scenario: User schedules from the meeting workspace
- **WHEN** the user chooses the schedule action
- **THEN** Desktop opens the shared Calendar event creation dialog without navigating away, and closing it returns to the unchanged meeting overview.
#### Scenario: Personal calendars load before team discovery
- **WHEN** the calendar list makes a writable personal calendar available while team destinations are still being discovered
- **THEN** the creation dialog opens without waiting for a calendar snapshot or team discovery, and writable team destinations can appear without resetting the draft.
#### Scenario: Calendar list fails before the editor can open
- **WHEN** the creation dialog is online and the initial calendar list fails with no writable destination available
- **THEN** it shows the load error and a retry action without leaving the dialog.
#### Scenario: Calendar video schedule is listed
- **WHEN** a Calendar event has video meeting enabled, including each expanded occurrence of a recurring event
- **THEN** the meeting overview places it in the rolling upcoming or historical section according to the occurrence end time. Upcoming lists only calendar reservations, even if a room has already been created; history includes past reservations and closed meeting rooms.
#### Scenario: Meeting overview stays compact and avoids repeated history
- **WHEN** the overview contains upcoming Calendar schedules and multiple historical occurrences from one recurring series
- **THEN** every row uses the meeting icon, upcoming rows use the compact agenda spacing, history keeps one latest collection row per recurring series, section totals are omitted, and the upcoming heading provides an action to view everything in Calendar.
#### Scenario: User starts an upcoming meeting from its row
- **WHEN** the user hovers or focuses an upcoming Calendar video schedule row and chooses the start action
- **THEN** Desktop reveals the action at the right edge and creates and opens an immediate Meeting for the Calendar schedule with its mapped invitees; upcoming and historical rows do not expose a per-row view-schedule action.

### Requirement: Explicit desktop and window selection
Electron SHALL present a meeting-window modal with desktop/window thumbnails and filters before sharing. Selection alone SHALL NOT start capture.
#### Scenario: Confirm a source
- **WHEN** the user selects an available source and confirms sharing
- **THEN** the pending display request resolves with that source, preserving the existing ZEGO publication and cleanup path.
#### Scenario: Cancel or invalidate selection
- **WHEN** the user cancels, leaves, the request times out, or the owning renderer/window is destroyed
- **THEN** the pending display request is cancelled without publishing a stream.
#### Scenario: Selected window has closed
- **WHEN** the selected source no longer exists at confirmation
- **THEN** the modal remains open with a refresh/reselection message and no fallback capture starts.

### Requirement: Draggable meeting workbench
The meeting workbench SHALL preserve native window dragging on empty shell space without intercepting launcher or overview controls.
#### Scenario: Use a launcher action
- **WHEN** the user clicks start, join or schedule in the launcher
- **THEN** the requested action runs normally outside the native drag region.

### Requirement: 安装包中的会议设备授权

Desktop SHALL 在会议首页显示待授权的设备，并在用户主动授权或首次启用设备时发起系统请求。macOS 安装包的用途说明和签名授权须覆盖会议摄像头、麦克风，屏幕录制由当前应用请求。

#### Scenario: 首次使用摄像头或麦克风

- **WHEN** 用户首次申请设备权限
- **THEN** 系统显示该设备的用途，等待用户决定期间会议继续，重复点击共用同一次申请

#### Scenario: 在系统设置中更改授权

- **WHEN** 用户先前拒绝了设备权限
- **THEN** 可以从会议进入对应隐私设置，授权后选择重启整个 Desktop。已入会者先离开自己的会议，完成退出清理后重新启动 Electron 主进程

#### Scenario: 选择屏幕共享

- **WHEN** 用户点击共享并首次申请 macOS 屏幕录制
- **THEN** Desktop 请求屏幕录制授权，用户在选择器中确认共享目标后才开始推流

### Requirement: 会议设置的生效范围

Desktop SHALL 将“日程会议开始通知”限定为运行期间的 Meeting 开始提醒。会议设置只将有实际运行时行为的选项展示为可用；其余选项须明确标为“暂不支持”，不能用只保存勾选状态的控件代替实现。

#### Scenario: 关闭会议开始通知
- **WHEN** 用户关闭 `meetingReminders`
- **THEN** 已显示的会议开始卡片消失，提醒轮询停止，在途结果不展示也不记为已提醒。日历助手继续按每条日程的独立配置提醒，会议邀请和日历邀请仍按原流程送达。

#### Scenario: 重新开启会议开始通知
- **WHEN** 用户打开 `meetingReminders`
- **THEN** Desktop 立即检查原有提醒时间窗口，只提醒自己组织或已接受邀请的待开始会议；本次桌面会话中同一组织、账号、会议和开始时间已展示过的卡片不重放，也不申请系统通知权限。
