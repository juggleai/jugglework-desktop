## Context

Full behavioral design lives in `docs/event-triggered-automation-prd.md` §4.10 (jugglework-desktop repo) — treat it as the source of truth for message content, the two ASCII interaction diagrams, the Process table, and AC1–AC10. This document only covers implementation-level decisions not already settled there.

Current state this builds on:
- `services/juggleim.go` (jugglework-server) already has an `AutomationEventIMSender`/`SendSystemMessage` adapter used by two callers: `automation_event_relay.go` (delivery wake signal) and `automation_readiness_requests.go` (readiness-unblocked). Both use the JuggleIM SDK's `SendSystemMsg`, whose `Message` struct has an `IsCount *bool` field (`is_count`) that the SDK already exposes elsewhere in this codebase (`services/group.go`'s group-notify message sets it explicitly).
- `apps/app/src/react-app/domains/jugglechat/automation-event-message.ts` (jugglework-desktop) holds the two existing message-type guards (`isAutomationEventPushMessage`, `isAutomationReadinessUnblockedMessage`) and `store.ts` uses them to filter the conversation list and intercept the message stream.
- §4.8's `automation_entity_sessions` local table (`(automationId, entityRef) → sessionId`) already exists and already handles session "graduation"; this change only adds a read-time lookup against it, no schema change.

## Goals / Non-Goals

**Goals:**
- Land the §4.10 design exactly as specified, with server and desktop changes sequenced so neither side is ever mid-rollout in a state that breaks the two existing hidden messages.
- Reuse existing mechanisms (`Message.IsCount`, `automation_entity_sessions`, IM native pin/mute/unread) rather than inventing new abstractions — this is a stated constraint of §4.10 itself, not a new decision here.

**Non-Goals:**
- Building the `push` event routing gap (GitHub `push` webhooks are not routed to automation triggers at all yet) — out of scope, called out in the PRD as a known, separate issue. `push` uses the generic fallback template until that's fixed.
- A local notification center, toast system, or any UI surface other than the IM conversation itself — the PRD explicitly rejected that approach.
- Telegram/Feishu connector work itself — only the message-bubble template for their `resourceType` values is in scope; the connectors are a future scenario per the PRD.

## Decisions

**`SendSystemMessage` signature gains an explicit `isCount bool` parameter.**
Mirrors the existing `SendIMGroupMsg(..., isStorage, isCount bool)` pattern already in the same file, rather than adding a second method or a boolean-options struct. Both existing call sites (`automation_event_relay.go`, `automation_readiness_requests.go`) are updated to pass `false`; the new `jw:automation-notification` sender passes `true`. Alternative considered: leave `IsCount` unset (nil) for the hidden messages and rely on server-side default — rejected because the default behavior is unverified and the PRD (AC8) requires it to be explicit, not assumed.

**One-time system-sender identity registration, not per-message.**
`jw-automation-events` gets a nickname ("自动化通知") and avatar via the SDK's `Register`/`UpdateUser`, run once (e.g. a startup check-and-register, or an ops-triggered one-off — implementation detail for tasks.md to pin down), not reissued on every `SendSystemMessage` call. Alternative considered: set nickname/avatar as part of every send call, if the SDK supports per-call sender display overrides — rejected without evidence the SDK supports it, and even if it did, re-sending identical profile data on every message is wasted work for a value that doesn't change.

**Click-time resolution reuses §4.8's existing lookup, read-only.**
`(automationId, entityRef)` is resolved against `automation_entity_sessions` at the moment "打开会话" is clicked, not at send time. This is the same table §4.8 already writes; this change only adds a read path from the message-bubble action handler. No new table, no message-side session snapshot.

**`resourceType` reuses the existing `entity_ref` namespace convention (`${provider}:${resourceType}:${id}`, established in §4.8) instead of a new enum.**
Keeps one source of truth for what a "type" is; the message-bubble template dispatcher just switches on the value already being produced elsewhere in the pipeline.

**The conversation-list filter, not just the message-stream interceptors, has to change.**
`store.ts`'s `IGNORED_CONVERSATIONS` set already contains `AUTOMATION_EVENT_IM_SENDER_ID` and `mergeConversations` drops any incoming conversation whose `conversationId` is in that set — independent of which message triggered the update. Today this is what keeps the automation conversation out of the list entirely; the two message-stream guards (`isAutomationEventPushMessage`/`isAutomationReadinessUnblockedMessage`) only stop an individual *message* from being appended to an already-open conversation view, they don't touch this list-level filter at all. Removing the sender id from `IGNORED_CONVERSATIONS` outright would let the conversation leak into the list on *any* update from this sender, including one produced by a still-hidden message (the `conversation` push payload carries `latestMessage`, so a hidden message's arrival can trigger this too, previewing its raw internal content). Fix: drop the sender id from `IGNORED_CONVERSATIONS`, and add a check in `mergeConversations` that still skips merging an incoming update when `conversation.latestMessage` matches one of the two existing hidden-message guards — reusing those guards rather than inventing a third filtering mechanism. An update with no `latestMessage`, or one whose `latestMessage` is `jw:automation-notification` (or any future non-hidden message from this sender), passes through normally.

## Risks / Trade-offs

- **[Risk]** If `services/juggleim.go`'s `SendSystemMessage` signature changes before both call sites are updated in the same commit, a partial deploy could leave the hidden messages defaulting to unset `IsCount` → **Mitigation**: land the signature change and both call-site updates as one atomic server change (task-level, see tasks.md); this is a pure Go signature change with no wire-format migration needed.
- **[Risk]** The desktop's new message-type guard could be written loosely enough to also match the two hidden message names, un-hiding them → **Mitigation**: spec requirement "Existing hidden messages stay hidden" above, with a regression test asserting both guards' behavior is unchanged after the new guard is added (per the PRD's Exception bullet on this exact risk).
- **[Risk]** Removing `AUTOMATION_EVENT_IM_SENDER_ID` from `IGNORED_CONVERSATIONS` without the `latestMessage`-guard change above would let a hidden message's arrival leak the conversation (and its raw content as list preview) into the Chat list before any visible message has ever been sent → **Mitigation**: the two changes ship together, verified by a unit test asserting a hidden-type conversation update is still dropped by `mergeConversations` after this change.
- **[Trade-off]** The generic fallback template used for `push` (until the routing gap is fixed elsewhere) means push-triggered automations, once that gap closes, will show a less specific message than PR/Issue/Release until a dedicated `push` template is built — accepted per the PRD, which explicitly defers a dedicated push template.

## Migration Plan

1. Server: add `isCount` to `SendSystemMessage`, update both existing call sites to pass `false`, deploy. No client-visible behavior change yet (both messages were already hidden; this only makes their unread-exclusion explicit instead of implicit).
2. Server: one-time sender identity registration for `jw-automation-events`.
3. Server: implement `jw:automation-notification` sending for each Process-table trigger moment.
4. Desktop: add the new message-type guard, message-bubble rendering, and click-time session resolution — deployed after server support exists, so the new message type has something to render against for live verification.
5. No rollback complexity beyond normal deploy revert: the new message type is additive, and the `isCount` change to the two existing messages is a one-line-per-call-site revert if needed.
