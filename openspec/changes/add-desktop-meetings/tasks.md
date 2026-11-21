## Implementation
- [x] Server: persistent meeting aggregate and server-file ZEGO settings
- [x] Server: authorization, card invitations, scheduling, admission and lifecycle API
- [x] Server: JuggleIM chatroom and custom card message adapter
- [x] Server: ZEGO token and room-close integration (provider acceptance pending)
- [x] Desktop: navigation, rounded icons, calendar and API
- [x] Desktop: chat entry, cards and additional invitations
- [x] Desktop: direct ZEGO media and JuggleIM chatroom runtime
- [x] Electron: meeting portal window, permissions and screen capture implementation
- [x] In-app reminders, lease renewal and persistent terminal cleanup retry
- [x] Automated compile/build and targeted behavioral tests
- [x] macOS Electron development: native close confirmation, media cleanup and floating-window focus (synthetic providers)
- [ ] Packaged macOS/Windows window, device and capture acceptance
- [ ] Real-provider media, chatroom admission, termination and capacity acceptance
- [ ] Optional ringing flow using JuggleIM custom messages
- [ ] Offline reminder delivery and durable notification outbox

Implementation boundaries and validation: `docs/meeting/04-implementation-status.md` in the desktop repository.

- [x] Persistent full/compact windows, focus handling and repeat-join reuse
- [x] Independent audio toggles preserving video, validated in a real single-user session
- [x] Stable schedule refresh, circular avatars and attendance/member invitation UI
- [x] Targeted member invitation regression test (no real recipient contacted)
- [ ] Updated member panel end-to-end UI acceptance after restart
- [x] Explicit desktop/window thumbnail picker, safe pending-request lifecycle, real Electron selection/cancel/re-share and ZEGO cloud decode verification
- [x] Move Meetings from the always-visible primary Rail into the IM-gated More menu, preserve route activity, and support the shared keyboard-accessible pin/unpin model below Calendar
- [x] Align the meeting workspace with the shared resizable inset layout, show upcoming/history lists, and route scheduling through the shared Calendar event dialog
- [x] 按 `meetingReminders` 实时启停 Meeting 开始提醒；覆盖在途返回、可见卡片和重新开启去重，保留日历及邀请的独立路径。
- [x] 参会人进出会提示音接入常规设置及会议窗口，默认关闭。
- [x] 会议概览和提醒只在已确认的团队组织作用域读取；隐藏概览不发请求，403 暂停自动读取，并覆盖作用域切换和手动恢复。
