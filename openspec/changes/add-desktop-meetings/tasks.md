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
