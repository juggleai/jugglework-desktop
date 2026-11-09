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
