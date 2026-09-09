## Why

Event-triggered automation currently runs completely silently: the IM message the server pushes when an event arrives (`jw:automation-event-delivery`) is a hidden wake signal, intercepted by the client and never shown, and the conversation it produces only surfaces in the current workspace's chat sidebar — invisible unless the user happens to already be in that workspace. There is no way to know a trigger fired, succeeded, or was dropped without being in the right place at the right time. §4.10 of `docs/event-triggered-automation-prd.md` finalizes the design for closing this gap with a real, visible IM message; this change implements it.

## What Changes

- New IM system message type `jw:automation-notification`, sent through the existing `SendSystemMsg` channel, **not** intercepted by the client — rendered as a normal, visible chat message.
- `services/juggleim.go`'s `SendSystemMessage` gains an `isCount` parameter so callers can control per-message unread-count inclusion (`Message.IsCount`). The two existing hidden messages (`jw:automation-event-delivery`, `jw:automation-readiness-unblocked`) are updated to pass `false` explicitly; the new notification passes `true`.
- One-time IM identity registration for the `jw-automation-events` system sender (nickname "自动化通知" + avatar) via the SDK's `Register`/`UpdateUser`, so the now-visible conversation has a real display name instead of a raw sender id.
- Desktop: message-bubble rendering for `jw:automation-notification`, templated by `resourceType` (`pull_request`, `issue`, `release`, `telegram:message`/`feishu:message`, and a generic fallback), with per-scenario click actions ("打开会话" resolved live against §4.8's `(automationId, entityRef)` session-affinity table, "打开运行记录", "打开重连入口").
- `automation-event-message.ts` gains a type guard for the new message name, kept strictly separate from the two existing interception guards so they keep working unchanged.

## Capabilities

### New Capabilities
- `automation-trigger-notification`: a real, visible IM system-conversation message reporting event-triggered automation activity (trigger fired, dropped, or blocked), replacing silence with a normal chat message subject to the IM's own read/pin/mute semantics.

### Modified Capabilities
(none — the two existing hidden message types keep their current behavior; only their unread-count wiring becomes explicit, which is an implementation detail, not a spec-level behavior change)

## Impact

- **jugglework-server**: `services/juggleim.go` (`SendSystemMessage` signature + both call sites), `services/automation_event_relay.go`, `services/automation_readiness_requests.go`, a new sender for `jw:automation-notification` (likely alongside `automation_event_relay.go`), one-time system-sender profile registration (new small script/init path, not per-message).
- **jugglework-desktop**: `apps/app/src/react-app/domains/jugglechat/automation-event-message.ts`, a new message-bubble rendering component, `apps/server`'s existing §4.8 session-affinity lookup (`automation_entity_sessions`) reused read-only for click-time resolution.
- No database schema changes on either side beyond what §4.8 already persists.
