# Tasks

## 1. Desktop reporting

- [x] 1.1 Bind reports to the validated foreground cloud session and check trusted-input, account isolation, UTC rollover and retry behavior in `active-day.test.ts`.
- [x] 1.2 Verify the bodyless bearer request over local HTTP and the Electron IPC boundary, including isolation from the session-revoked event.

## 2. Packaged acceptance

- [x] 2.1 Against a test deployment, verify an installed Electron build receives 204 after foreground input and remains signed in when the activity endpoint is unavailable. （免验收，2026-11-28，用户确认：真实设备/真实环境验收不再执行）
