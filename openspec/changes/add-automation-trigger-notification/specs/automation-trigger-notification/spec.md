## Purpose

Reports event-triggered automation activity (a trigger fired, was dropped, or was blocked) as a real, visible IM system-conversation message, so a user away from the relevant workspace or device still learns what happened, instead of the current fully-silent delivery path.

## ADDED Requirements

### Requirement: Visible trigger-notification message
The system SHALL send a `jw:automation-notification` IM system message, through the same system-sender channel as the existing hidden automation messages, for every trigger-lifecycle moment listed in this capability's Process mapping (PR/Review, Issue/comment, Release, Push, message-platform triggers, offline-backlog drop, rate-limit drop, connector/auth-required pause). The client SHALL NOT intercept or hide this message type — it SHALL render as a normal chat message in a real conversation.

#### Scenario: A qualifying GitHub PR event triggers a visible message
- **WHEN** a GitHub PR event successfully triggers an automation and a run session is created or reused
- **THEN** the Chat conversation list shows (or updates) the automation-notification conversation with an increased unread count, and the message's action button opens the conversation for that specific trigger, without leaving the app

#### Scenario: Two different trigger types produce two independent messages
- **WHEN** the same automation is triggered twice in a row by different event types (e.g. a PR opened, then a comment on it)
- **THEN** each trigger produces its own `jw:automation-notification` message; the messages are not merged and do not overwrite each other's content

### Requirement: Existing hidden messages stay hidden
Adding the visible message type SHALL NOT change the visibility of the two existing hidden system messages sent by the same sender identity.

#### Scenario: Hidden messages remain invisible after this change
- **WHEN** the client receives a `jw:automation-event-delivery` or `jw:automation-readiness-unblocked` message after this change ships
- **THEN** the client still intercepts and hides both, exactly as before

### Requirement: Per-message unread-count control
The system SHALL control unread-count inclusion independently per message rather than per sender or per channel. The two existing hidden messages SHALL be excluded from unread counts; the new visible message SHALL be included.

#### Scenario: Hidden wake signals never inflate the unread badge
- **WHEN** `jw:automation-event-delivery` or `jw:automation-readiness-unblocked` is sent
- **THEN** it does not increase any conversation's unread count and does not contribute to the app's total unread indicator

#### Scenario: Visible notification does increase the unread badge
- **WHEN** `jw:automation-notification` is sent
- **THEN** it increases the automation-notification conversation's unread count and the app's total unread indicator, subject to the conversation's own mute state (see Native conversation semantics below)

### Requirement: Summary-level message content only
The `jw:automation-notification` message content SHALL carry only routing fields (`automationId`, `entityRef`, `resourceType`) and summary-level event information (e.g. PR/Issue title, triggering actor and a short excerpt). It SHALL NOT carry the full raw event payload.

#### Scenario: Full event content is not embedded in the message
- **WHEN** a `jw:automation-notification` message is constructed for any trigger
- **THEN** its content contains only the routing fields and summary-level fields; the full original event payload is not present anywhere in the message content

### Requirement: Click-time session resolution
The message SHALL NOT carry a session identifier captured at send time. Opening a notification's target conversation SHALL resolve the current session by looking up `(automationId, entityRef)` against the live session-affinity record at click time.

#### Scenario: Opening an older message after the session has graduated
- **WHEN** the same entity has triggered twice, and the session for that entity has since graduated to a new session (per the existing session-affinity rules) before the user clicks the earlier message
- **THEN** clicking "打开会话" on the earlier message opens the current (graduated) session, not the stale one implied by when the message was sent

#### Scenario: No resolvable session
- **WHEN** `(automationId, entityRef)` cannot be resolved to a session (the automation was deleted, the affinity record is gone, or the message is opened on a device that never ran this trigger)
- **THEN** the client shows a "该会话已不存在" message and does not navigate or crash

### Requirement: Resource-type templated rendering with fallback
The message bubble SHALL be rendered using a template selected by `resourceType`, not by provider. Known types (`pull_request`, `issue`, `release`, `telegram:message`, `feishu:message`) SHALL use their dedicated template; any other or unrecognized value SHALL use a generic fallback template that still displays the message and a working action.

#### Scenario: Unrecognized resourceType still renders
- **WHEN** a message's `resourceType` does not match any known template (including a newly introduced event type not yet given a dedicated template)
- **THEN** the message still renders using the generic fallback template (title, source, and an action button) and does not block the rest of the conversation from displaying

### Requirement: Scenario-appropriate action routing
Each message's action button SHALL route to one of: the resolved conversation ("打开会话"), the triggering automation's run history ("打开运行记录"), or the automation's reconnection entry point ("打开重连入口"), matching the trigger scenario. A deleted target SHALL produce a clear message, not a broken navigation.

#### Scenario: Target automation was deleted
- **WHEN** the user clicks a message's action button and the automation it refers to has been deleted
- **THEN** the client shows "该自动化已被删除" instead of navigating to an empty or broken page

### Requirement: Native conversation semantics, no bespoke behavior
The automation-notification conversation SHALL use the IM's existing native mechanisms for read state, pin, mute, and cross-view unread visibility, with no automation-specific logic layered on top.

#### Scenario: Pinning behaves like any other conversation
- **WHEN** the user pins or unpins the automation-notification conversation
- **THEN** its behavior (position, indicator) is identical to pinning or unpinning any other conversation

#### Scenario: Muting suppresses the badge, not delivery
- **WHEN** the user enables do-not-disturb on the automation-notification conversation
- **THEN** new `jw:automation-notification` messages are still delivered and still increment the conversation's own unread count, but no longer drive the app's total unread indicator — identical to muting any other conversation
