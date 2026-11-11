## Why
Desktop needs organization meetings reachable from navigation and chat, with scheduling and a meeting calendar. JuggleCall is for calls and is not the meeting engine.

## What Changes
- Implement the approved rounded-icon meeting UI, real organization-scoped APIs and configuration readiness.
- Use ZEGO Web SDK directly for media, and the existing JuggleIM connection for chatrooms and custom invitation messages.
- Add server persistence, admission checks, invitations, calendar and encrypted ZEGO configuration in jugglework-server.
- No default AppID or embedded secret. Unconfigured media must fail closed with an actionable state.

## Impact
Desktop apps/app and apps/desktop; companion /Applications/work/jugglework-server. Both use local branch codex/desktop-meetings. See docs/meeting for design.
