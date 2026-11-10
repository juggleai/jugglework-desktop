# session-runtime-observability Specification

## Purpose

Make long-running session activity understandable and recoverable by distinguishing provider retries, meaningful progress, stalled work, and child-session activity without exposing hidden reasoning.

## Requirements

### Requirement: Provider retries are visible
The system SHALL present provider retry activity for the active session with the retry attempt and a safe error summary whenever the runtime reports a retry part, retry event, or retry status.

#### Scenario: Retry event while session remains busy
- **WHEN** the runtime emits a provider retry event without changing the session's overall busy status
- **THEN** the active conversation shows that the provider request is retrying and identifies the current attempt

#### Scenario: Retry state restored from snapshot
- **WHEN** a session snapshot contains a retry part from the current run
- **THEN** reopening the session preserves a visible retry receipt or current retry activity

### Requirement: Retry liveness is distinct from meaningful progress
The system SHALL track provider retry liveness separately from user-meaningful progress and MUST NOT clear stalled evidence solely because another retry heartbeat arrived.

#### Scenario: Repeated retries without output
- **WHEN** provider retries continue without new assistant text, reasoning output, tool execution progress, or a completed tool result
- **THEN** the runtime retains stalled evidence and elapsed silence continues from the last meaningful progress without adding a speculative stuck warning to the UI

#### Scenario: Work resumes after retry
- **WHEN** assistant output or tool execution makes new progress after a retry
- **THEN** retry or stalled presentation clears and the session returns to the corresponding active state

### Requirement: Terminal errors settle active presentation
The system SHALL treat a session error or assistant-message error as terminal runtime evidence, clear stale active presentation, and keep manual stop idempotent when the authoritative run list confirms that no run remains.

#### Scenario: Provider quota ends a run
- **WHEN** a provider quota error terminates a session after the renderer previously observed busy or retry state
- **THEN** the conversation stops presenting the run as active without requiring the user to stop it manually

#### Scenario: Stop races with terminal error
- **WHEN** the user requests stop after the run has already ended and the authoritative active-run refresh confirms no run remains
- **THEN** the application treats stop as already complete and does not report a stop failure

#### Scenario: Stop cannot be confirmed
- **WHEN** the abort request is not accepted and the authoritative active-run refresh fails or still reports the run active
- **THEN** the application reports that the run could not be stopped

### Requirement: Stalled detection preserves neutral presentation
The system SHALL retain stalled activity as internal runtime evidence while preserving the existing neutral in-progress presentation in conversations and sidebars.

#### Scenario: Existing transcript becomes stalled
- **WHEN** an active session with existing messages exceeds the meaningful-progress deadline
- **THEN** the conversation continues to show the current live action or generic generating label without a possibly-stuck instruction

### Requirement: Child-session activity uses observable phases
The system SHALL distinguish preparation, execution, and approval-waiting phases for an in-flight child-session task using observable tool and interaction state.

#### Scenario: Child task input is still streaming
- **WHEN** the parent Task tool is still receiving its invocation input
- **THEN** the live activity says that the subtask is being prepared

#### Scenario: Child task is running
- **WHEN** the Task invocation input is available and no descendant interaction is pending
- **THEN** the live activity says that the subtask is running rather than still being delegated

#### Scenario: Child task needs approval
- **WHEN** an in-flight Task has a pending permission or question in its descendant session tree
- **THEN** the live activity says that the subtask is waiting for approval

### Requirement: Child-session retry propagates to its task
The system SHALL project a child session's retrying state onto the parent task activity without fabricating child completion or failure, while stalled state remains undecorated.

#### Scenario: Subagent provider retry
- **WHEN** a child session reports a provider retry while its parent task call remains in flight
- **THEN** the parent task presentation identifies that the delegated work is retrying

#### Scenario: Subagent stalls
- **WHEN** a child session becomes stalled while its parent task call remains in flight
- **THEN** the parent task remains in its original in-flight presentation without a possibly-stuck instruction

### Requirement: Manual compaction completion is event-backed
The system SHALL treat raw compaction parts as invisible context-boundary metadata and SHALL present a completed manual-compaction receipt only after authoritative completion evidence is available.

#### Scenario: Compaction boundary arrives while compression is running
- **WHEN** a raw compaction part arrives after manual compaction has started but before a completion event or completed summary message
- **THEN** the conversation continues to show elapsed time and the collapsible in-progress compaction state without showing “Context compacted”

#### Scenario: Manual compaction completes
- **WHEN** the runtime emits the compaction-ended event or a summary message contains a completion timestamp
- **THEN** the in-progress presentation is replaced by one completed compaction receipt

### Requirement: Automatic compaction remains inside the active task
The system SHALL treat an automatic context boundary, its summary receipt, and the resumed assistant output as one continuous task presentation.

#### Scenario: Lifecycle events omit the compaction reason
- **WHEN** a raw compaction part identifies an automatic boundary and its lifecycle events omit the reason
- **THEN** the live transcript retains the automatic mode for the following summary receipt and does not create a standalone task

#### Scenario: Automatic compaction is still running
- **WHEN** an automatic boundary and a reason-less compaction-started event arrive before the summary message is available
- **THEN** the in-progress compaction activity remains inside the active assistant task

#### Scenario: Automatic boundary arrives after the started event
- **WHEN** a reason-less compaction-started event creates an unknown running receipt before the automatic boundary arrives
- **THEN** the boundary immediately reclassifies that receipt as automatic without waiting for compaction to finish

#### Scenario: Only an unknown summary receipt survives reconciliation
- **WHEN** a completed summary receipt has unknown mode but is followed by a transparent continuation marker and more assistant output
- **THEN** the receipt and resumed output remain grouped with the assistant output before compaction

### Requirement: Authoritative idle terminalizes stale tool projections

When an authoritative snapshot reports a session as idle, the client SHALL NOT
render any input-streaming or input-available tool part as actively running.
Such parts SHALL be projected as interrupted and included in completion
diagnostics without modifying the stored OpenCode transcript.

#### Scenario: Child task loses its terminal event

- **GIVEN** a parent message contains a running task tool part
- **AND** the authoritative session snapshot reports idle
- **WHEN** the snapshot is projected into UI messages
- **THEN** the task tool is shown as interrupted rather than running
- **AND** the run is diagnosed as incomplete

### Requirement: Reconnect performs authoritative reconciliation

On the first successful event-stream connection as well as reconnection, the
client SHALL reconcile tracked session snapshots and active-run state. Reading
active runs SHALL NOT block opening or consuming the event stream. Late active-run
reads SHALL NOT resurrect terminal runs or overwrite newer generations.

#### Scenario: Idle event was lost during disconnect

- **GIVEN** the event stream disconnects while a run appears active
- **AND** the engine becomes idle before reconnection
- **WHEN** the event stream reconnects
- **THEN** the client refreshes the authoritative snapshot and active-run state
- **AND** stale running projections are terminalized

#### Scenario: Messages precede the first stream connection
- **GIVEN** a task was accepted before the event stream connected
- **WHEN** the first stream connection succeeds
- **THEN** tracked session snapshots are refreshed without requiring navigation

### Requirement: Half-open event transports are replaced

The client SHALL treat any received event-stream byte, including heartbeat frames
and SSE comments, as transport activity. A quiet workspace whose stream still
delivers heartbeats SHALL keep its connection. When a connected transport delivers
no bytes for longer than several engine heartbeat intervals, the client SHALL
abort it and open one replacement after bounded backoff; the successful
replacement SHALL perform authoritative reconnect reconciliation. Business-event
silence alone SHALL NOT trigger replacement.

#### Scenario: Stream stops delivering bytes without closing
- **GIVEN** the event transport connected and then neither closes, errors, nor delivers bytes
- **WHEN** the silence exceeds the liveness bound
- **THEN** the client aborts that transport and opens a replacement
- **AND** the replacement refreshes tracked session snapshots and active-run state

#### Scenario: Quiet workspace receives only heartbeats
- **WHEN** no session events occur but heartbeat bytes keep arriving
- **THEN** the client keeps the existing transport open

### Requirement: An ended server run reconciles a stuck local run

When the server-owned active-run list stops reporting a visible session whose
local projection is still busy or retrying, the client SHALL immediately refresh
that session's authoritative snapshot rather than waiting for periodic
reconciliation. The snapshot SHALL decide the terminal state; a run-list gap alone
SHALL NOT force the session idle.

#### Scenario: Terminal idle event was lost
- **GIVEN** a visible session's run list previously reported it active
- **AND** its local status remains busy because the idle event was not delivered
- **WHEN** the run list stops reporting the session
- **THEN** the client refreshes the authoritative snapshot immediately
- **AND** the session leaves the running state once the snapshot reports idle

### Requirement: Accepted submissions reconcile the visible transcript

After the runtime accepts a prompt submission, the client SHALL refresh the
target session's authoritative snapshot instead of depending only on matching
event-stream message events. Reconciliation SHALL preserve newer live content
and SHALL deduplicate messages by their stable runtime identity.

#### Scenario: Prompt events are missed during submission

- **GIVEN** the event stream misses the user-message events while a prompt is being accepted
- **WHEN** the prompt request succeeds and the task starts
- **THEN** the active conversation refreshes and displays the accepted user turn without requiring session navigation
- **AND** a concurrently received event for the same message does not create a duplicate turn

### Requirement: Visible active sessions use snapshot reconciliation as an event-stream backstop

While a visible session has authoritative active-run or busy evidence, the client
SHALL perform low-frequency, coalesced snapshot reconciliation. This recovery path
SHALL stop when the session is hidden or no longer active, and SHALL perform one
final reconciliation when an observed run ends. It is a transcript recovery
backstop and SHALL NOT be interpreted as proof that the event-stream transport is
healthy. Quiet idle sessions SHALL NOT be polled by this mechanism.

#### Scenario: Event stream remains open but stops delivering bytes

- **GIVEN** the active-run coordinator reports that the visible session is running
- **AND** the event stream neither closes nor delivers the assistant message events
- **WHEN** a later authoritative snapshot contains assistant output
- **THEN** the current conversation displays that output without session navigation
- **AND** overlapping reconciliation reads are coalesced

#### Scenario: Active run reaches a terminal state

- **WHEN** a previously observed visible run becomes inactive
- **THEN** the client performs one final snapshot reconciliation
- **AND** stops periodic reconciliation for that session

### Requirement: Incomplete live messages permit bounded snapshot recovery

A snapshot made stale by live events MAY fill missing stable-ID parts of existing
messages, but SHALL NOT overwrite newer live content or terminal metadata or bypass
history deletion and continuation-suppression fences. Missing part declarations
SHALL trigger bounded, coalesced snapshot recovery rather than unbounded delta
buffering or one request per token. Disposal SHALL clear recovery timers and buffers.

#### Scenario: Live metadata shell hides available history
- **WHEN** live metadata creates empty user and assistant message shells during a snapshot read
- **AND** the returned snapshot contains their identified text parts
- **THEN** the missing parts become visible without switching sessions

#### Scenario: Declaration and delta arrive within one animation frame
- **WHEN** a text delta is buffered before its empty typed declaration
- **THEN** the delta is retained exactly once
- **AND** a later terminal cumulative declaration corrects duplicate text and retains its done state

#### Scenario: Snapshot predates pending tokens
- **WHEN** a stale snapshot contains a prefix of pending cumulative text
- **THEN** the longer compatible content is retained
- **AND** incompatible or overflowed pending content remains unresolved for bounded recovery rather than being silently discarded as repaired

### Requirement: Lifecycle journal excludes user content

The server SHALL persist bounded run lifecycle events containing correlation
metadata and timestamps, and SHALL NOT persist prompt text, tool input, file
contents, credentials, or model output in that journal.

#### Scenario: Run lifecycle is recorded

- **GIVEN** a session run starts, makes progress, and reaches a terminal state
- **WHEN** the lifecycle journal is inspected
- **THEN** it contains the run identity, generation, event names, and timestamps
- **AND** it contains no prompt, tool input, file content, credential, or model output

### Requirement: Delegated child activity preserves the parent run

While a parent task tool waits for delegated child sessions, recent child model
or tool activity SHALL count as progress for the parent and SHALL NOT cause the
root session to be aborted.

#### Scenario: Parent is quiet while a child is active

- **GIVEN** a parent contains an in-flight task tool with a child session ID
- **AND** the parent has produced no direct output for the stall threshold
- **AND** the child has recent model or tool activity
- **WHEN** the stall watchdog runs
- **THEN** the parent progress clock is refreshed from the child activity
- **AND** neither the parent nor the child is aborted

### Requirement: Confirmed delegated stalls recover only the child

The watchdog SHALL target only a delegated child whose own no-progress threshold
and grace period have expired. It SHALL verify the child belongs to the parent
and SHALL NOT abort the root session.

#### Scenario: One sibling stalls while another completes

- **GIVEN** a parent is waiting for multiple delegated children
- **AND** one child completed successfully
- **AND** another verified child remains busy without progress beyond both thresholds
- **WHEN** recovery runs
- **THEN** only the stalled child receives an abort request
- **AND** the parent remains active to consume completed results and the child cancellation

#### Scenario: Child identity or ownership is uncertain

- **GIVEN** an in-flight task lacks a child session ID or names a child owned by another parent
- **WHEN** recovery runs
- **THEN** no destructive recovery is performed
