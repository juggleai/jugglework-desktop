# Design
Use docs/meeting/02-architecture-and-contracts.md and the approved HTML UI as the design baseline. Meeting chat uses JuggleIM chatrooms, never hidden group conversations. Meeting media never calls JuggleCall.

Server owns meeting state and membership admission. Desktop maintains one IM connection. ZEGO configuration is read only from the Server YAML meeting section at startup, shared across organizations on that server. The secret remains server-side and is never projected to clients. Database meeting settings are not read or written; Desktop only displays readiness. SDK integration and readiness are separate from UI availability so configuration can be completed before enabling calls.

Implementation progress and deviations are recorded in tasks.md; unchecked tasks are not delivered functionality.

Joining a meeting automatically opens the named `jugglework-meeting` Electron BrowserWindow. Main-window navigation never embeds the meeting stage. Closing an active meeting window is prevented until leave/end confirmation succeeds and local media stops. Hosts leaving transfer ownership to a remaining member. A persistent second 260×82 Electron window provides compact device controls. Losing focus shows it without hiding the full meeting window; focus restores the full view and hides the compact window. Minimize/explicit hide also shows the compact window. Neither window is resized or reloaded during switching.

Desktop also reads a local meeting.json before joining (development: apps/desktop/config/meeting.json; packaged: userData/meeting.json; JUGGLEWORK_MEETING_CONFIG overrides the path). Only enabled/AppID are allowed as meeting configuration, never ServerSecret/AppSign. An explicit AppID must match the token issuer Server. Unspecified public values fall back to Server.

The vendored ZEGO Web SDK 3.12.0 manages media access endpoints. Meeting initializes it with AppID only; no serverUrl is configured, returned in meeting APIs, or required for readiness.


Audio-only toggles preserve the local MediaStream, video track and video element; the first microphone activation adds an audio track to the existing SDK stream. Rejoining the active meeting focuses its existing window without another admission request.

Home calendar selection updates the adjacent selected-day schedule. Background refresh preserves mounted content instead of replacing it with loading UI. Member panels default closed, distinguish active participants from absent candidates/invitees, and allow targeted private meeting-card invitations on each absent member row. Invitation avatars are circular and lists use stable row heights, scroll areas and reserved feedback space. The member panel has no footer invitation or lock control.

Remote audio uses one independent audio element per received stream in the persistent main renderer; video tiles stay muted to avoid duplicate playback. Late audio tracks trigger playback, and blocked playback exposes a retry action. Trusted Electron windows permit autoplay. Meeting card message types are registered both with JuggleIM and the chat rendering allowlist, including conversation previews.

The legacy ZEGO createStream API supplies a live silent WebAudio placeholder even when microphone capture is disabled. Desktop tracks actual microphone acquisition explicitly rather than inferring it from track presence. First unmute captures audio and calls addTrack over that placeholder; replaceTrack is reserved for replacing a previously acquired microphone. Capture state resets with stream destruction/recreation. Real ZEGO cloud loopback with a controlled tone verifies first-unmute audio, mute silence and restored audio while retaining the video stream.

Lifecycle convergence runs independently of chat admission: read the server snapshot every three seconds, renew membership at twenty seconds, bound HTTP requests to twelve seconds, and stop local media after thirty seconds without a valid lifecycle snapshot. Reject stale meeting versions and stale async generations. JuggleIM chatroom device hints carry the participant session and increasing sequence; only current members with matching sessions can update device indicators. Hints wake authoritative lifecycle reads and never authorize termination directly. Expired device hints are treated as unknown. Camera capture is controlled independently to retain the microphone publication.

### 双端诊断与退出并发（2026-11-10）

会议首页及会中提供诊断 JSON 导出。保留有界的本地媒体质量、设备操作阶段、播放元素状态、业务快照和 IM 序号事件，附上持久化的原生无响应/渲染器/GPU 等进程退出事件；不采集会话内容或凭据。异常 PC 重启后可从首页导出历史记录。详细采集方式及证据边界见 `docs/meeting/08-cross-pc-diagnostics.md`。

离开/结束请求返回后的清理，以会议 generation 判断请求归属；周期续期替换 lease 对象不能阻止当前会话清理，也不能使旧请求误清理后续会话。双 PC 断音与 Windows 开视频卡死仍待现场日志验证，不以单机回环通过代替双端验收。

### 摄像头追加操作必须完成（2026-11-10 现场修正）

仅音频入会后首次开视频，使用 SDK 创建的摄像头源 preview 及其元数据执行 addTrack，保留源到离会；不直接向 ZEGO 3.12.0 追加浏览器创建、没有 SDK preview 元数据的视频轨道。设备切换等待不能禁用聊天、邀请、导出和离会；超过 30 秒未返回时停止本机会话并给出可恢复提示，晚到结果不得恢复已退出会话。摄像头切换保持原有音轨，不以本机开视频成功代替双端音频验收。
