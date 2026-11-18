# Conversation Native Actions

## Purpose

让已连接本机 Desktop 的会话按当前用户权限使用 JuggleWork 原生待办、通讯录、日历、会议和 IM，并让用户在业务写入发生前看清本次操作的具体目标与影响。

## ADDED Requirements

### Requirement: Session-bound discovery and execution
Desktop SHALL expose only supported native actions to eligible local conversation runs. The host SHALL bind each request to the originating run, workspace, user, deployment and organization, enforce current feature and access policies, and reject execution or discard results when the bound context becomes invalid.

#### Scenario: Query without opening the product page
- **WHEN** an eligible signed-in user asks about native tasks while the conversation is open
- **THEN** the assistant can discover and run the read action without navigating to Tasks

#### Scenario: Context changes while the request is pending
- **WHEN** the user switches organization or signs out before a pending read returns or a proposed write starts
- **THEN** the old read result is not delivered and the pending write is not dispatched

#### Scenario: No eligible local Desktop context
- **WHEN** a headless, external or otherwise unauthorized caller attempts to invoke a native action
- **THEN** the action is unavailable and does not run under the foreground user's credentials

### Requirement: Query personal native tasks by local due date
The assistant SHALL query original native tasks, not conversation todos or reminders. “My tasks” defaults to assigned to the signed-in member; “unfinished” means task status `todo`. “Due today” uses the local calendar interval from today's inclusive midnight to tomorrow's exclusive midnight.

#### Scenario: Today's unfinished assigned tasks
- **WHEN** the user requests their unfinished tasks due today
- **THEN** results contain only visible tasks for which the user is an assignee and whose due date is inside that interval
- **AND** completed, canceled, deleted, undated, and previously overdue tasks from before today are excluded
- **AND** a task filed in multiple lists appears once, and a timed deadline already passed today remains included

#### Scenario: Results are absent or incomplete
- **WHEN** the result is empty, paginated, or failed
- **THEN** the answer distinguishes no matches, partial results, and inability to query; it does not infer completion from a failed call

### Requirement: Resolve contacts in the current directory
The assistant SHALL search only directory entries the signed-in user may access, return bounded candidates, and require the user to disambiguate a non-unique target before proposing any write that references it.

#### Scenario: Several contacts share a name
- **WHEN** the user names a contact and multiple visible candidates match
- **THEN** the assistant shows enough visible information to distinguish them and does not select a recipient or invitee itself

### Requirement: Confirm exact native writes
Desktop SHALL present a trusted preview and receive an explicit one-time user decision before any native write. The approval SHALL cover only the shown values and effects, expire, and be invalidated by changes to the proposed values or authority. Model arguments, tool output, Full access and reusable runtime grants SHALL NOT substitute for this confirmation.

#### Scenario: User cancels or the proposal changes
- **WHEN** the user cancels, the preview expires, or the target, content or side effects change
- **THEN** there is no dispatch based on that approval

#### Scenario: Confirmation is repeated
- **WHEN** the user double-clicks confirmation or the same approved operation is replayed
- **THEN** the system does not dispatch a duplicate write

### Requirement: Create a calendar event as previewed
The assistant SHALL create a native event only on a writable calendar, using the approved title, dates, times, timezone and participants. The preview SHALL distinguish a personal event from one that will invite participants.

#### Scenario: Add an event to my calendar only
- **WHEN** the user confirms a personal event without invitees
- **THEN** the event is created on the selected calendar and no invitations are sent

### Requirement: Create a meeting without implicit join or outreach
Meeting actions SHALL distinguish immediate creation from scheduling. The result SHALL distinguish a created meeting, confirmed invitations and any unavailable operation; room creation alone SHALL NOT join the user, access camera or microphone, or notify others.

#### Scenario: Create a meeting and return its entry link
- **WHEN** the user approves creation without sending invitations
- **THEN** the assistant returns the created meeting entry and does not join or notify anyone

### Requirement: Send approved text to the resolved IM conversation
IM send SHALL use the exact approved direct or group conversation and text, not the currently open chat. It SHALL report success only when the sender service confirms it, and SHALL NOT automatically resend an uncertain transmission.

#### Scenario: The user switches chats after reviewing the preview
- **WHEN** the selected chat changes but the approved account and target remain valid
- **THEN** the message still targets the approved conversation, never the newly open one

### Requirement: Keep independent receipts for combined actions
The assistant SHALL report a separate outcome for each approved step, execute dependent steps only when prerequisites are confirmed, and preserve known successes when later steps fail.

#### Scenario: Meeting succeeds but IM does not
- **WHEN** the meeting is created and sending the approved message fails or has an unknown outcome
- **THEN** the assistant reports both statuses separately and does not recreate the meeting or automatically resend the message
