## ADDED Requirements

### Requirement: Profile menu controls desktop pet visibility
The desktop application SHALL place one visibility action immediately below Check for updates in the profile menu. It SHALL show 显示虚拟宠物 while hidden and 隐藏虚拟宠物 while visible, default hidden, persist per device, and reflect actual window state. The profile menu SHALL NOT include a separate pet-focus action; the pet context menu SHALL only provide Reset position and Hide pet.

#### Scenario: Pet is shown without active work
- **WHEN** the user enables the pet and no unfinished task exists
- **THEN** one transparent floating pet appears and loops the typing-blinking action
- **AND** it does not first wave or remain a static idle character

### Requirement: Floating display and input use explicit focus modes
The pet SHALL remain above ordinary app windows while the main window is minimized or hidden. Passive display SHALL avoid taking focus. Explicit input or voice activation SHALL allow the pet input window to take keyboard focus while leaving the main window unchanged. Transparent regions SHALL pass pointer interaction to underlying applications.

#### Scenario: User opens quick input
- **WHEN** the user clicks the input icon
- **THEN** the pet expands a usable text field and takes focus because of that explicit action
- **AND** it does not first activate the main window

### Requirement: Base actions follow the requested mapping
Idle, no-task, showing and completed states SHALL loop typing. Composing, thinking, responding, execution, retrying, compacting, stopping, errors and stalled work SHALL loop seated-working. Waiting interactions SHALL retain the waiting action and take priority over pet editing, main-window editing and voice activity. Opening the pet editor SHALL immediately count as composing even before text is entered. The focused editable main-session composer SHALL count as composing; saved drafts, unrelated editors, window blur and hidden documents SHALL NOT. Main-window editing and pet editing SHALL remain separate inputs to one base-action selector. Completion SHALL NOT cause jumping.

#### Scenario: Open an empty pet editor
- **WHEN** the user opens pet quick input without entering any text and no waiting request exists
- **THEN** the pet immediately loops seated-working until the editor closes or another higher-priority state applies

#### Scenario: A task awaits a response while composing
- **WHEN** a waiting permission or question exists while either editor is active or dictation is in progress
- **THEN** waiting takes priority and decorative hover retains its existing independent two-jump override

#### Scenario: Edit in the main session window
- **WHEN** the editable main-session composer receives focus
- **THEN** the pet uses seated-working unless a task is waiting
- **AND** losing window/editor focus restores the action derived from other tasks without treating the saved draft as active editing

#### Scenario: An unfinished task loses its connection
- **WHEN** task snapshot recovery fails or source metadata becomes unavailable for an unfinished task
- **THEN** the original card and identity remain in reconciling state with 连接中断，正在确认任务状态 and seated-working
- **AND** failed reads do not produce a new completed result or delete the card; authoritative recovery can confirm completion

#### Scenario: A task snapshot recovers after provider disconnection
- **WHEN** authoritative snapshot recovery succeeds after a provider disconnection
- **THEN** the card derives completed or awaiting-continuation state from the recovered current turn
- **AND** historical provider-disconnected termination alone does not imply current source unavailability or disable follow-up submission
- **AND** a snapshot without a completion diagnostic clears the previous transient provider-disconnected reason while preserving known deliberate-stop facts

#### Scenario: An unrelated project is unavailable
- **WHEN** synchronization is partial but known tasks have already completed and no editor, dictation or other work is active
- **THEN** partial synchronization remains disclosed and the pet continues typing without inventing an active task

#### Scenario: A task stalls
- **WHEN** the current unfinished task becomes stalled
- **THEN** the pet loops seated-working while its status text truthfully indicates lack of progress

#### Scenario: All tasks successfully complete
- **WHEN** all active work has a confirmed terminal result and no other activity exists
- **THEN** the pet loops typing without a completion jump and observed completed tasks remain as unread completion cards without keeping the pet in its working animation

### Requirement: Hover overrides any action with exactly two jumps
Entering the character from outside SHALL interrupt any business-state animation with exactly two complete celebrate cycles followed by typing. Keeping the pointer over the character SHALL not restart jumps or let activity updates immediately replace the post-jump typing. Task data, submission and recording SHALL remain unaffected. Leaving SHALL restore base action according to the main design's timing. Dragging, hiding and reduced motion SHALL suppress or cancel the decorative jump.

#### Scenario: Hover while working
- **WHEN** the pointer enters the character while a task is thinking
- **THEN** the pet plays exactly two jumps and then typing
- **AND** it does not cancel or alter the actual task, and the task remains visible in the bell list

#### Scenario: Animation moves under a stationary pointer
- **WHEN** character pixels move during the two jumps
- **THEN** frame changes do not create additional hover episodes

### Requirement: Hover toolbar provides input voice and task bell
Hovering the pet SHALL reveal the input, voice and bell controls below it. The bell SHALL show a blue badge for visible unread or unfinished root-task notifications, no badge at zero, and 99+ above 99. Both stacked and expanded task views SHALL expose a collapse chevron without any numeric badge. The badge SHALL appear only alongside the bell and SHALL return when the reminder panel closes. Moving from the character to controls or an open panel SHALL not make those controls disappear.

#### Scenario: Bell expands
- **WHEN** the user clicks the bell
- **THEN** one stacked reminder without an item count appears above the pet and a close-panel chevron remains available below it

### Requirement: Quick input targets the latest root task across all projects
An empty quick-input draft SHALL target the accessible, non-archived root task with the greatest time.updated across all projects, using time.created as fallback and a stable identity tie break. The displayed endpoint, workspace and root session SHALL remain fixed while composing. Partial synchronization SHALL be disclosed and must not be represented as a complete global ordering. Missing or invalid targets SHALL retain text and require explicit target resolution rather than silently creating or switching tasks.

#### Scenario: Another project receives a newer task
- **WHEN** a newer task appears after the user has opened quick input
- **THEN** the existing draft remains bound to its displayed target until the user explicitly selects another conversation

### Requirement: Quick input plus selects a conversation
The plus button SHALL display accessible, non-archived root conversations across projects, including historical conversations without active or unread reminders. Choices SHALL be ordered by the same update-time and stable-identity rules as latest-target selection, show conversation title and project, and indicate the current selection. Loading, empty and partial results SHALL be disclosed. The list SHALL be independently anchored eight DIP above or below the input capsule, match its width, choose the available side and scroll within the floating window without moving the input or character. It SHALL use an opaque rounded surface, compact single-line icon/title/project rows, pill highlights and a thin scrollbar. Its native hit region SHALL include the visible menu and connecting gap. Opening or selecting SHALL NOT raise the main window.

#### Scenario: Plus menu near a screen edge
- **WHEN** the plus menu opens or its input is moved near a work-area edge
- **THEN** it chooses the available vertical side, stays eight DIP from the input capsule and keeps equal width and aligned edges
- **AND** the input and character retain their positions while only the list scrolls if height is limited

#### Scenario: Select a conversation with an existing draft
- **WHEN** the user selects a conversation from the plus list
- **THEN** the list closes, keyboard focus returns to input and the draft is preserved
- **AND** the placeholder remains 开始聊天 (Start chatting in English), the visible destination row updates, and subsequent send or Enter submits to that selected conversation
- **AND** background updates do not silently replace the selected target

#### Scenario: No conversation can be selected
- **WHEN** no eligible conversation exists
- **THEN** the list displays an empty state and offers the existing create-task entry without automatically creating a conversation

#### Scenario: No tasks exist
- **WHEN** no eligible root task exists
- **THEN** the input offers opening JuggleWork to create a task and does not silently create one

#### Scenario: Resolve a new target after sending an earlier draft
- **WHEN** the user reopens empty quick input and the latest-target request is still pending
- **THEN** the previous target is cleared, typing remains available, and both the send button and Enter submission are disabled until resolution completes

### Requirement: Quick input blur restores the small bubble
When the pet window loses focus during ordinary quick-input editing, the input and its options menu SHALL close and the enlarged controls SHALL collapse to the small bubble together. The retained target and unsent draft SHALL survive. Delayed hover callbacks SHALL NOT reopen the toolbar after blur. Focus changes between controls within the pet input SHALL NOT close it. Active dictation SHALL retain its existing explicit stop or cancel semantics.

#### Scenario: Click outside while editing
- **WHEN** the pet window loses focus with an unsent quick-input draft
- **THEN** the input and options close, the controls return to the small bubble and the window becomes passive
- **AND** reopening input restores the same text and task target

### Requirement: Pet submission reuses existing task and queue semantics
Pet text SHALL be submitted by the retained main task host through the existing model, permission and submission preflight for the explicit target. Busy submissions SHALL follow the existing queue semantics. The pet SHALL not duplicate the queue, use the current project's closure for another project, clear text on failure, or treat a request as accepted before acceptance.

#### Scenario: Direct submission is accepted
- **WHEN** the task host confirms a direct submission
- **THEN** the unchanged originating editor closes without displaying an 已发送 confirmation
- **AND** queued and failed submissions show feedback for three seconds without clearing the draft on failure; an unconfirmed result retains its separate reconciliation action

#### Scenario: Latest target is busy
- **WHEN** a user submits text to the fixed target while it is running
- **THEN** the message follows the existing busy queue and the pet shows 已加入队列 only after queue acceptance

#### Scenario: Submission feedback expires
- **WHEN** queue acceptance or a submission error is shown in the pet
- **THEN** that feedback disappears after three seconds without changing the draft, task or queue state
- **AND** newer feedback restarts its own three-second timer rather than being removed by an earlier timeout

#### Scenario: An idle task still has queued follow-ups
- **WHEN** a new pet message targets an idle task whose original FIFO is nonempty
- **THEN** the message is appended behind its existing entries instead of being sent directly
- **AND** a blocked head retains its text, attachments and failure reason without automatic retry

#### Scenario: Edit while submission acceptance is pending
- **WHEN** the user changes a submitted draft before its sent or queued receipt arrives
- **THEN** acceptance clears only the unchanged original draft for the same target
- **AND** newer text and its open editor remain available

#### Scenario: Switch editors before a receipt arrives
- **WHEN** the user sends from one card or quick input and starts editing another before acceptance arrives
- **THEN** the original receipt clears only its unchanged original draft
- **AND** the currently selected editor and task panel remain open with their text intact

#### Scenario: Hide during submission
- **WHEN** the pet window is hidden and destroyed before a submission receipt arrives
- **THEN** the main process retains the pending draft identity and applies the receipt independently of the pet page
- **AND** reopening before the receipt disables duplicate submission; confirmed acceptance clears the unchanged original draft, while an unconfirmed result preserves text and blocks retry until the user checks the original task

#### Scenario: Browser transport fails after submission
- **WHEN** the POST transport reports Failed to fetch, net::ERR_CONNECTION_RESET, a timeout, or an equivalent network code
- **THEN** the original draft remains in an unconfirmed state and duplicate sends stay blocked
- **AND** an explicit request rejection remains an ordinary editable failure

#### Scenario: Use another input for an unconfirmed task
- **WHEN** a send is pending or unconfirmed for one project and root session
- **THEN** every pet input targeting that task shares the same duplicate-send protection, independently of its draft key
- **AND** hiding or stale draft snapshots cannot clear that protection
- **AND** only an explicit checked-retry action clears an unconfirmed result in the main process; other tasks remain independent

### Requirement: Voice input shares the main host's dictation and microphone ownership
The voice icon SHALL start explicit dictation for the same pinned target. The retained main renderer SHALL own the shared dictation controller and microphone lease. Transcription SHALL populate the pet draft for user confirmation, not automatically send or create a separate voice chat. Hiding, logout or cancellation SHALL release recording resources.

#### Scenario: Start dictation with an existing draft
- **WHEN** the user clicks voice while a non-empty quick draft and its pinned target are retained
- **THEN** dictation starts for that target without another latest-conversation lookup
- **AND** opening the input preserves the existing draft

#### Scenario: An empty draft retains an older project's target
- **WHEN** the latest root conversation belongs to a different project and the retained quick draft is empty
- **THEN** voice availability follows the latest conversation's project instead of the old retained target
- **AND** a non-empty saved draft continues to use its pinned project's voice availability
- **AND** starting dictation checks the final target's configuration and cancellation before that check completes prevents microphone activation

#### Scenario: Close voice input before its target resolves
- **WHEN** the user closes voice input with Escape, collapses it through window blur or switches editors before target resolution completes
- **THEN** that pending voice intent becomes invalid and its delayed target reply does not start dictation or reopen the input
- **AND** immediately reopening voice input may reuse the pending target lookup, with only the new input intent allowed to start dictation

#### Scenario: Cancel while dictation is starting
- **WHEN** dictation is awaiting microphone permission or a connection and its start receipt is still pending
- **THEN** stop and cancel actions remain available and reach the main-host controller independently of the pending start request

#### Scenario: Main app already uses the microphone
- **WHEN** the user clicks voice while another main-host voice feature holds the microphone
- **THEN** the pet reports the existing microphone conflict and does not start independent capture

### Requirement: Bell lists project task reminders independently from system notifications
The bell SHALL aggregate accessible running and awaiting-continuation root tasks across projects and merge descendant activity under each root. It SHALL show task title, truthful state and project. Current-task interruption, incomplete termination, failure and deliberate stopping SHALL remain available for continuation; successfully finished work observed during the current host lifetime SHALL remain as an unread completion card with a green check and the conversation reply preview. Historical successful sessions SHALL NOT be imported wholesale. The badge SHALL count visible running, awaiting-continuation and unread completed root-task reminders, excluding dismissed or read cards. Historical failed runs SHALL not create extra cards. Unknown or disconnected sources SHALL not be treated as an empty task list. System notification read state SHALL remain unchanged.

#### Scenario: Task card is selected
- **WHEN** the user selects an active task card
- **THEN** the main renderer selects that root task and its existing interaction surface, then shows and focuses the main window after successful navigation
- **AND** opening the bell alone does not acknowledge task decisions or mark system notifications read

### Requirement: Task cards share conversation status and progress presentation
The expanded task list SHALL replace the bell with an upward collapse chevron. Each card SHALL consume the same localized status and progress presentation as its corresponding conversation, including tool step counts and todo lifecycle semantics. Updates SHALL continue for background projects and during decorative hover actions. The pet SHALL NOT maintain a separate wording map, summarize with a model, expose internal reasoning, or invent progress percentages.

#### Scenario: Background task executes a command
- **WHEN** the corresponding conversation presentation changes to command execution or updates its completed tool step count
- **THEN** the pet card displays the same status and progress text from the shared presentation source
- **AND** no main-window navigation is required for the update

#### Scenario: Only reasoning is available
- **WHEN** the current assistant output contains reasoning without user-facing text or observable tool progress
- **THEN** the card uses the current todo or localized status instead of displaying reasoning text

### Requirement: Dismiss collapse open and stop are separate task actions
A card's close button SHALL dismiss its current task turn, keyed by endpoint, workspace, root session and current turn identity, without changing execution, queue or pending interactions; the reminder badge SHALL reflect visible cards. Reopening the bell SHALL keep that same turn dismissed; a new user-task turn or explicit restore action in the reminder list or quick-input panel SHALL show it again. Clicking the bell SHALL first show one stacked notification without an item count, never the full list. Clicking anywhere on that stacked card SHALL expand the full list without navigating or marking a task read. The upward chevron SHALL close the entire reminder region and restore the bell from either presentation; it SHALL NOT fold the list back into a stack. Reopening the bell SHALL always start with the stack. Escape SHALL close the panel without stopping tasks. Clicking an expanded card title SHALL navigate to that root conversation. A completed card SHALL be marked read and removed only after successful navigation; opening a running or paused card SHALL leave it visible. Opening failures SHALL NOT mark a card read. Read completion turns SHALL NOT be restored by the dismissed-card restore action. New user turns SHALL not inherit old read state. The bent arrow SHALL toggle the follow-up editor, not navigate or submit an empty draft. A square stop control SHALL reuse existing scoped stop and queue cleanup semantics for the actual active root and descendant runs represented by that card.

#### Scenario: All visible cards are dismissed
- **WHEN** the user closes every card while tasks are still active
- **THEN** the reminder badge is hidden at zero and the panel closes automatically, leaving only input and voice controls without stopping those tasks
- **AND** no empty-state hint is shown; the quick-input panel exposes a restore action that shows dismissed reminders again

#### Scenario: User stops one task
- **WHEN** the user clicks the square stop control for a card
- **THEN** only that target follows the existing stop and queue cleanup path
- **AND** the stop control stays disabled while pending until all targeted runs reconcile
- **AND** confirmed user cancellation retains an awaiting-continuation card with an orange dot, natural completion retains an unread completed reminder, and failure or unknown outcomes preserve truthful state
- **AND** failure keeps the card available with an error and retry action

### Requirement: Card follow-ups target that card's conversation
Each card SHALL provide a bent-arrow toggle for a 继续跟进 editor and a separate submit control or Enter submission. The toggle SHALL work with an empty draft. The draft and endpoint/workspace/root-session target SHALL remain independent of other cards, the main composer and the bottom toolbar's globally latest task input. Submission SHALL reuse existing target preflight and busy queue semantics. Blank or IME-composing input SHALL not submit, and failure SHALL retain the draft.

#### Scenario: Another task is globally newer
- **WHEN** the user sends follow-up text from a task card while a different task is globally latest
- **THEN** that text is submitted only to the card's original conversation
- **AND** the globally latest toolbar target remains unchanged

### Requirement: Interrupted tasks can explicitly continue in their original conversation
Confirmed incomplete, interrupted, failed or stopped current tasks without active root or owned descendant runs SHALL remain available through the bent-arrow follow-up editor. A confirmed stopped current turn SHALL display an orange dot before its title. Stopping-in-progress SHALL NOT be presented as already stopped. Cards SHALL NOT show a standalone 继续任务 button or automatically open an input. Only clicking the bent arrow SHALL expand the card editor. Non-empty user text submitted with Enter SHALL use the original conversation context, model and existing preflight. Acceptance SHALL close and clear only the input while preserving the task item. Empty text SHALL NOT send a default continuation prompt. Unknown disconnection SHALL require existing reconciliation before submission. No interruption or deliberate stop SHALL automatically trigger continuation.

#### Scenario: A task ends incomplete
- **WHEN** completionBlocked or authoritative current-run evidence confirms incomplete work
- **THEN** its card remains counted with the conversation's real incomplete status and offers continuation

#### Scenario: An idle root has an interrupted child in its current turn
- **WHEN** a descendant observed as running or waiting during the current root turn stops or fails after the root itself has finished
- **THEN** the aggregate card remains resumable instead of displaying successful completion
- **AND** confirmed descendant cancellation shows the stopped indicator after all owned runs end
- **AND** observed root-turn identity and user-message creation time determine descendant ownership, so historical child failures do not block a new user turn
- **AND** explicit continuation acceptance updates that same card to the actual working state without double counting

#### Scenario: Root snapshot arrives after its current child's interruption
- **WHEN** a current child has been observed running and then confirmed stopped or failed before the new root-turn snapshot arrives
- **THEN** the delayed root snapshot retains that child's resumable outcome and confirmed stopped indicator
- **AND** a later root turn excludes that historical child outcome

#### Scenario: Continuation cannot be accepted
- **WHEN** continuation fails or is blocked before acceptance
- **THEN** the task remains awaiting continuation and its text remains available for correction or retry

#### Scenario: Stopped task is shown without an automatic continuation control
- **WHEN** a current task has confirmed stopped metadata or a user-cancelled finish and no remaining active run
- **THEN** its card shows an orange status dot with no standalone continue button or open input
- **AND** clicking the bent arrow opens its follow-up input, whose non-empty Enter submission targets that original task

### Requirement: Background cards retain workspace and session synchronization
The retained host SHALL hold existing workspace synchronization and session-level tracking references for represented root sessions and relevant descendants. Initial snapshots SHALL hydrate message, todo and current-turn outcome presentation. Dismissing a card, hiding the main window or switching projects SHALL not release active-task tracking. Completion, archival, deletion and invalid context SHALL release references through the existing lifecycle. The feature SHALL not create duplicate SSE connections or a separate activity polling loop.

#### Scenario: Non-selected project emits message progress
- **WHEN** a tracked background card's session receives message or todo updates
- **THEN** its presentation updates through the same session cache as the conversation
- **AND** merely retaining a workspace-level subscription is not considered sufficient

#### Scenario: Live progress arrives during snapshot loading
- **WHEN** a pet snapshot request starts before a newer live todo update arrives
- **THEN** the snapshot restores messages and status without replacing that newer todo
- **AND** replaying a cached snapshot does not overwrite live todo progress

#### Scenario: A completed task releases its subscriptions
- **WHEN** a root task and its descendants are confirmed complete
- **THEN** the pet releases their transcript and snapshot observers and task tracking references
- **AND** its reminder retains the completed turn and reply preview after transcript cache eviction
- **AND** a new run restores task tracking and replaces the previous completion facts

#### Scenario: An older busy snapshot arrives after a newer completion
- **WHEN** an observer or metadata-recovery snapshot request returns an older session version after the shared cache has received a newer completed snapshot
- **THEN** both the task presentation and shared snapshot retain the newer completion
- **AND** that delayed reply does not restore busy state or the stop control

#### Scenario: Real-time completion precedes a delayed snapshot
- **WHEN** live messages and status confirm a completed or stopped turn while an earlier busy snapshot is still pending
- **THEN** the shared seeding entry rejects that response using the session's request-time live revision
- **AND** cached replay and local snapshot copies cannot restore its old messages or busy state
- **AND** recovery reloads invalid cached snapshots even when session metadata is unchanged
- **AND** a new request can confirm recovery or start a later turn normally

#### Scenario: An unrelated historical child cannot be read
- **WHEN** a historical descendant outside the current turn fails to load while the current root has a confirmed completion
- **THEN** the root card remains completed and releases its task subscriptions
- **AND** the project discloses partial synchronization without marking that root disconnected

### Requirement: Aggregated task stop reconciles actual targets and outcomes
An aggregated card SHALL resolve the current task's active root and owned descendant sessions and runs before stopping. It SHALL reuse existing scoped stop and delegated-stop operations and corresponding queue cleanup. An idle root SHALL not suppress stopping active descendants. Unsupported target resolution SHALL disable stop with an existing-conversation recovery action. An abort response reporting no active run SHALL not alone classify the result as user cancellation.

#### Scenario: Root is idle while its child is running
- **WHEN** the user stops an aggregate card containing an active descendant
- **THEN** the stop operation targets that verified descendant using the existing delegated path
- **AND** the card remains pending until related activity has reconciled

#### Scenario: Stop races with natural completion
- **WHEN** stop reports no active run and the authoritative current turn completed successfully
- **THEN** the card becomes an unread completion reminder instead of a stopped task requiring continuation

### Requirement: Native interaction capabilities are verified per platform
Native hit testing SHALL use the stable character contour, current control regions and pointer travel bridges, with supported public window APIs or a verified pointer-passthrough fallback. CSS transparency SHALL not be treated as native passthrough. macOS application-level Hide independence SHALL be validated separately from main-window hiding. Opening an input SHALL focus its editor for keyboard interaction; closing all editors and menus SHALL restore passive display.

#### Scenario: Scroll past task-card controls
- **WHEN** a task-card close button is hidden or clipped by the scrolling list
- **THEN** its invisible rectangle does not intercept native clicks outside the visible list
- **AND** scrolling, hover and keyboard focus update the interactive regions while visible close controls remain usable

#### Scenario: User enters a card follow-up with keyboard controls
- **WHEN** the user explicitly focuses pet controls and opens a card editor
- **THEN** keyboard focus enters that editor without first activating the main window
- **AND** leaving all editing and menu interaction restores passive display

### Requirement: Card presentation and operations derive from shared task facts
Cards SHALL derive running, waiting, awaiting-continuation, completed and reconciling presentation from the shared current-turn result, pending interactions and owned active runs. Preparing-submission and stopping SHALL remain local operation feedback rather than assertions of server activity. Pending interactions, active runs and unresolved results SHALL prevent false completed or resumable presentation. Each root SHALL keep one stable card and one task count. Root follow-up submission and queue eligibility SHALL follow the existing root conversation entry, not a new family queue.

#### Scenario: One card is preparing a submission
- **WHEN** a card is awaiting its own submission preflight or stop result
- **THEN** that card prevents duplicate or incompatible actions
- **AND** other confirmed cards remain usable

### Requirement: Follow-up editing remains stable and recoverable
Only one card follow-up editor SHALL be expanded at a time. Switching editors SHALL preserve their separate drafts. Status and progress SHALL update during editing without reordering the active editor. Completion SHALL update the original card with a green completion indicator and real reply preview, without destroying its follow-up editor or draft. Accepted Enter submissions SHALL clear and close only the editor while preserving the card and expanded list, including subsequent completion. Draft-only entries SHALL remain accessible under 未发送的跟进 without creating duplicate task reminders. Invalid targets SHALL retain copyable text and prevent submission rather than silently retargeting.

#### Scenario: Task completes while its follow-up is being edited
- **WHEN** an edited task completes successfully before its non-empty draft is sent
- **THEN** the original card displays its completion and preserves its editor and draft until read or dismissed

#### Scenario: A reminder with an unsent draft is read or dismissed
- **WHEN** a completion reminder is read or any reminder is dismissed while holding an unsent follow-up
- **THEN** its card editor closes and no longer contributes to the pet editing action
- **AND** 未发送的跟进 remains available in both the task panel and quick input, even when no bell remains
- **AND** restoring it keeps the original task fixed, disables conversation retargeting and preserves the separate ordinary quick-input draft
- **AND** accepting the restored draft removes only that draft without restoring a reminder or changing its count

### Requirement: Discovery and pet resource lifetime cover all accessible projects
Showing the pet SHALL bootstrap known accessible online workspace activity with existing active-run and root-metadata reads, then share existing synchronization and reconciliation. Missing current-turn outcomes SHALL hydrate incrementally using existing snapshots, prioritizing active work and incomplete candidates. Incomplete project synchronization SHALL be visible and SHALL not claim an authoritative global empty list. Later updates SHALL refresh changed scopes rather than rescanning all transcripts on hover. Local-only activity bridges SHALL not be treated as complete remote coverage. Hiding the main window SHALL keep the pet operational; explicitly hiding the pet SHALL stop its animation, recording, recovery reads and pet-only tracking references without cancelling existing tasks or queues.

#### Scenario: Pet starts without expanded sidebar projects
- **WHEN** an accessible online non-selected project has an active task
- **THEN** bootstrap and shared discovery can find it without waiting for the sidebar to expand
- **AND** unavailable project scopes remain visibly unresolved while confirmed cards work

#### Scenario: User hides the pet during active work
- **WHEN** the user explicitly hides the pet
- **THEN** pet-owned resources stop and its existing tasks and queues continue
- **AND** showing it again reconciles current state before claiming completion or resuming work

### Requirement: Local sprite playback supports the actual available assets
Production SHALL use audited typing, seated-working, celebrate and waiting PNG strips with explicit frame durations, loop counts and fallback static frames. It SHALL preserve the Juggle laptop, alpha edges, shared registration and actual jump displacement. It SHALL not rely on an infinite GIF to count two jumps.

#### Scenario: Reduced motion is requested
- **WHEN** reduced motion is enabled
- **THEN** the pet shows the appropriate static frame and keeps the toolbar and real task state functional

### Requirement: Pet dimensions and voice availability match the desktop context
The pet SHALL render a 104 by 112.67 DIP character cell and a 120 by 40 DIP toolbar with independent page zoom. Main-window zoom SHALL NOT alter pet geometry or pointer hit coordinates. Voice availability SHALL use the conversation composer's shared policy; unconfigured or checking service SHALL disable the icon without requesting microphone access.

#### Scenario: Main application uses 110 percent zoom
- **WHEN** the main application zoom changes while the pet is visible
- **THEN** the pet retains page zoom one, stable dimensions and aligned hit regions

#### Scenario: Dictation service is unconfigured
- **WHEN** the shared voice-service probe reports configured false
- **THEN** conversation and pet voice controls are disabled with the same unavailable explanation
- **AND** text input remains usable

### Requirement: Pet controls use a compact layout
Task-card shadows SHALL be lighter than toolbar shadows, with a shorter, lighter shadow on the final card. Stack backing layers SHALL NOT accumulate shadows. The quick-input placeholder SHALL remain 开始聊天 (Start chatting in English), independent of task selection or target resolution.

The toolbar SHALL use a rounded compose icon, five rounded voice bars, thin dividers and a soft shadow with sufficient transparent gutters. Quick input SHALL replace the toolbar with one rounded input capsule containing a plus options control and send arrow. Its fixed destination SHALL remain visible outside the capsule. Task cards SHALL show a title and shared progress text, falling back to the shared status when no progress exists, without an extra project row. Full project, status and progress SHALL remain available in the title hint. Follow-up, stop and dismiss controls SHALL be hidden by default and visible on pointer hover over their card or visible keyboard focus on an action button. Title focus and active editing alone SHALL NOT expose these controls. Follow-up and stop SHALL share the stop button's gray icon color (#999) and circular background.

#### Scenario: Quick input is expanded
- **WHEN** the user opens quick input
- **THEN** one input capsule appears with no duplicate toolbar or inner rectangular input border
- **AND** the plus options preserve the existing draft and original target until an explicit retarget action

#### Scenario: Task notifications are expanded
- **WHEN** the bell opens its task list
- **THEN** each compact card displays the shared current progress or status on its second line
- **AND** hovering a card or visibly focusing its action button with the keyboard exposes its follow-up, stop and dismiss actions without clipping card shadows

#### Scenario: Expand a notification stack with the pointer
- **WHEN** clicking the notification stack expands the task list and the first title retains focus
- **THEN** that title focus does not reveal the first card's actions
- **AND** leaving a card hides its actions even while its follow-up input remains open

### Requirement: Completed reminders are read per task turn
Completed reminders SHALL only represent tasks observed as active, awaiting continuation or submitted through the pet during the current main-host lifetime. Their observed identity and per-turn read or dismiss records SHALL survive hiding and showing the pet within that lifetime. Account-context changes SHALL clear these local records. Merely opening the bell or editing a follow-up SHALL NOT read a completion reminder.

#### Scenario: Read a completed reminder
- **WHEN** the user selects a green completed card and its original conversation opens successfully
- **THEN** only that completion turn is marked read and removed from the reminder list
- **AND** other running cards remain present and the notification count updates

#### Scenario: Send a card follow-up with Enter
- **WHEN** the user enters text in a card follow-up and presses Enter outside IME composition
- **THEN** it is sent or queued for that original root conversation
- **AND** acceptance closes and clears only the input, keeping the card and expanded list with live status

#### Scenario: Open a running card
- **WHEN** the user selects a running card
- **THEN** the original conversation opens and the card remains until its close button is used or its completed turn is later read

### Requirement: Bell stack and list use distinct entry and exit actions
The reminder presentation SHALL follow closed → bell click → stack → stacked-card click → full list. The toolbar arrow SHALL close the reminder region and restore the bell, preserving tasks, read state and unsent drafts.

#### Scenario: Close an expanded list
- **WHEN** the list is expanded and the user clicks the toolbar arrow
- **THEN** the entire reminder region disappears and the bell returns, with no stacked card left visible

#### Scenario: Reopen reminders
- **WHEN** the user clicks the bell after closing an expanded list
- **THEN** only the stacked reminder is shown until that stacked card is clicked

### Requirement: Collapsed controls inflate and deflate one continuous bubble
Collapsed controls SHALL retain a centered 24 by 6 DIP capsule below the pet, with a 40 by 20 DIP transparent pointer target. Character hover after 300ms, bubble hover or click, and explicit control focus SHALL reveal the toolbar. The bubble and toolbar SHALL share one continuously visible capsule surface that changes from 24 by 6 DIP to the toolbar dimensions over 260ms. Both sizes SHALL share the same horizontal center and top edge, positioned 6 DIP above the control-slot origin. Icons SHALL reveal over 100ms after an 80ms expansion delay and fade immediately when collapse begins. The two surfaces SHALL NOT cross-fade or translate independently. Leaving the complete interaction region for 500ms SHALL reverse this transition unless a panel or focused editor remains open. A fixed 120 by 40 DIP control slot SHALL preserve the character anchor and native window size throughout transitions. Hidden controls SHALL be inert, aria-hidden and excluded from native hit regions. Visible control hit regions SHALL use the final toolbar bounds, excluding the outer sides of the narrower two-button toolbar. Reentering during a transition SHALL reverse continuously from the current capsule size. Reduced-motion preference SHALL disable these transitions.

#### Scenario: Pet controls are resting
- **WHEN** no panel is open and controls have collapsed
- **THEN** the small capsule remains visible below the pet and hidden toolbar buttons cannot receive input

#### Scenario: Hover reveals and leaving conceals the toolbar
- **WHEN** the user hovers the character or capsule and then leaves the interaction region
- **THEN** the same capsule inflates into the toolbar and deflates after the leave delay
- **AND** the character stays at its original screen anchor

### Requirement: No visible reminder hides the bell
The bell and its separator SHALL render only when at least one unread, undismissed reminder exists. With no reminders, the controls SHALL retain only input and voice in a centered 80 by 40 DIP capsule. A new visible reminder SHALL restore the 120 by 40 DIP three-button capsule. Dismissing the last visible reminder with its close button SHALL close the panel and remove the arrow immediately. If the last reminder disappears for another reason while its panel is open, a close arrow SHALL remain until the panel is closed, without a bell or badge.

#### Scenario: All reminders are read or dismissed
- **WHEN** no visible reminder remains and the reminder panel is closed
- **THEN** neither the bell, its badge nor its separator is displayed
- **AND** the two remaining controls stay centered beneath the pet

### Requirement: Reminder bubble reflects unread completion and stays close to the pet
The resting bubble SHALL be positioned 6 DIP above its previous control-slot origin, one capsule height closer to the character. Any visible unread completion reminder SHALL fill the bubble green. Once all such completion reminders are read or dismissed, the bubble SHALL return to its neutral fill without moving the character or changing the bubble size. The stacked reminder item SHALL NOT display a numeric count; a numeric badge SHALL appear only with the bell and SHALL be hidden while the close-panel chevron is shown.

#### Scenario: Completed reminders are pending
- **WHEN** at least one completed task reminder is unread and not dismissed
- **THEN** the resting capsule is filled green

### Requirement: Reminder visibility uses reversible opacity transitions
Stacked and expanded reminder presentations SHALL fade in and out over 180ms. Closing SHALL disable focus, clicks and native hit regions immediately while preserving the outgoing content and layout until the opacity transition ends. The panel SHALL then unmount and release its layout space. Reopening during fade-out SHALL cancel stale removal and reverse the transition. Switching to quick input SHALL not leave a second interactive panel. Reduced-motion preference SHALL disable the transition.

#### Scenario: Close a stacked reminder
- **WHEN** the user clicks the toolbar arrow while the stacked reminder is visible
- **THEN** that reminder fades out without a numeric item badge and cannot receive input
- **AND** it unmounts after fading, restoring the bell without moving the character anchor

### Requirement: Bell layout keeps the character stable between frames
The pet root SHALL remain anchored to the native viewport bottom while reminder content expands upward or unmounts. Native layout and hit regions SHALL use coordinates relative to that root, including while it temporarily extends beyond the current viewport during native resize. Opening the bell, expanding the stack, closing the list and reversing a transition SHALL preserve the character node and its distance from the viewport bottom on intermediate frames. These actions SHALL NOT clip the character or trigger the hover animation without pointer entry.

#### Scenario: Native resize follows the reminder layout update
- **WHEN** reminder content changes before the native window has applied its new bounds
- **THEN** the character remains visible at the same distance from the viewport bottom and native bounds preserve its screen anchor
- **AND** reminder opacity transitions continue independently without replacing the character or changing its animation resource

### Requirement: Stack layers match actual reminders with the largest card in front
A folded stack SHALL use the same unread and non-dismissed reminder collection as the bell badge. Its top content card SHALL be the largest. Each remaining reminder SHALL contribute one background card, offset downward by 6 DIP and progressively inset horizontally. Background cards SHALL remain behind the content card and SHALL NOT render numbers.

#### Scenario: Reminder count changes
- **WHEN** the visible reminder count changes between one, two, three or four
- **THEN** the stack has exactly that total number of card layers and the bell shows the same count when the reminder panel is closed, while the chevron remains unbadged

### Requirement: Explicit navigation brings the main window forward
A non-drag character click SHALL trigger a dedicated main-window activation action. Dragging SHALL NOT activate it. Task selection, open-target and create-task entry controls SHALL show and focus the main window after successful navigation. Input, voice, follow-up, send, stop, bell and pet-control focus SHALL NOT show or focus the main window. Application activation caused by pet keyboard focus SHALL NOT implicitly raise the main window.

#### Scenario: Select a task while the main window is hidden
- **WHEN** the user clicks a task title
- **THEN** its conversation is selected and the main window is shown and focused
- **AND** failed navigation keeps the card available without marking it read

### Requirement: Hover hop preserves character identity and scale
The celebrate strip SHALL preserve the robot's white shell, blue body, cyan smiling eyes and the black laptop bearing cyan Juggle text. Its first and final frames SHALL show the standing pose at the same character scale. Intermediate frames SHALL preserve head width and horizontal registration, use bent knees for anticipation and landing, and keep the same ground baseline. The character SHALL NOT be uniformly shrunk to create jump headroom. The five-frame 384 by 416 source-pixel cell layout and existing timing SHALL remain compatible with the two-cycle hover player.

#### Scenario: Switching between idle and hover hop
- **WHEN** the pet enters or finishes the two-hop hover action
- **THEN** its character scale, palette and laptop remain consistent with the standing pose
- **AND** the hop contains actual upward displacement followed by the original ground baseline

### Requirement: Stable native canvas prevents toggle flashes
The pet SHALL use one fixed-width transparent canvas spanning the current display work-area height. Opening, closing, folding or updating reminders SHALL NOT resize or reload the native window, remount the character or controls, change their screen anchor or restart the sprite. Only display work-area changes SHALL resize the canvas. Returning keyboard focus from a passive button SHALL NOT collapse the control bubble; ordinary quick-input window blur SHALL still close input and collapse it. Transparent pixels SHALL remain mouse-pass-through even while the input owns keyboard focus.

#### Scenario: Repeated bell clicks
- **WHEN** the bell and chevron are clicked repeatedly
- **THEN** the original character and capsule nodes and screen positions remain stable
- **AND** no native resize or page reload occurs

### Requirement: Dragging adapts task direction and edge alignment
Dragging SHALL update position at approximately 16ms intervals without resizing the canvas on the same display. The task panel SHALL retain its current side while it fits, switch above or below when needed, and use 24 DIP hysteresis when neither side can fit. Side changes SHALL fade over 140ms, while the character follows the pointer directly. Left- or right-constrained panels SHALL align with the corresponding capsule edge; both-side height shortage SHALL create a bounded scrolling list without overlapping the character. Dragging the capsule SHALL suppress button activation after the existing five-DIP threshold.

#### Scenario: Release between drag samples
- **WHEN** a drag ends before the next periodic pointer sample
- **THEN** the final cursor position is applied and persisted before the drag ends, including for a gesture shorter than one sampling interval

#### Scenario: Top, bottom and horizontal edges
- **WHEN** the expanded task panel is dragged near the top, bottom, left or right work-area edge
- **THEN** it uses the available vertical side and matches the capsule's corresponding horizontal edge
- **AND** its visible scroll boundary remains separate from the character and controls


### Requirement: Late interaction and send receipts preserve the current context
Pet interaction writes SHALL carry their original account context. The main process SHALL reject writes from a previous context, including writes from a retained pet window. A real-time run start SHALL advance the shared run generation so a later submission receipt cannot synthesize busy after that run has already ended.

#### Scenario: Previous account writes after switching
- **WHEN** an interaction write captured before an account switch arrives afterward
- **THEN** the new context retains its own drafts and targets

#### Scenario: Completion arrives before the send receipt
- **WHEN** real-time busy and idle events arrive before the submission receipt
- **THEN** the receipt preserves the completed state and does not restore a stop control

### Requirement: Snapshot recovery preserves live messages and history
A snapshot invalidated by later live activity SHALL fill missing historical messages without overwriting existing live messages, run status or terminal metadata. A snapshot requested before a history deletion or revert SHALL NOT refill that history. Final chat rendering SHALL consume the protected transcript instead of overlaying invalid snapshot metadata.

#### Scenario: Initial snapshot overlaps assistant progress
- **WHEN** live assistant output arrives while the initial history snapshot is pending
- **THEN** the snapshot supplies the missing user turn and history while preserving the live output

#### Scenario: Stopped metadata survives chat rendering
- **WHEN** the live transcript confirms stopping after the rendered snapshot was read
- **THEN** chat presentation retains the stopped indicator and completion time

### Requirement: Task navigation reveals the selected conversation
Successful navigation from an expanded task title, input target or create-task entry SHALL show and focus the main window. Completed cards SHALL be marked read only after successful navigation. Expanding the stacked reminders alone SHALL NOT navigate. An empty task reminder panel SHALL NOT show a no-tasks message.

#### Scenario: Open a completed card from the list
- **WHEN** the user expands stacked reminders and selects a completed task title
- **THEN** the main window shows the corresponding workspace and root conversation
- **AND** the completed turn is marked read and removed

#### Scenario: Last reminder disappears
- **WHEN** the open panel loses its last reminder
- **THEN** its collapse control remains available without a no-tasks hint
