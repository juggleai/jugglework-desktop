## ADDED Requirements

### Requirement: Project assistant conversations are persistent and project-scoped
The system SHALL provide persistent Agent conversations scoped to one authorized Toon project and SHALL restore their ordered history after navigation or restart without listing them as normal JuggleWork chats.

#### Scenario: User resumes a project conversation
- **WHEN** the user reopens a project after restarting the application
- **THEN** the assistant lists that project's conversations and complete available message history
- **AND** selecting a conversation resumes its persistent runtime mapping

#### Scenario: Another project is opened
- **WHEN** the user opens a different Toon project
- **THEN** conversations from the first project are not returned or addressable from the second project

#### Scenario: Conversation deletion is partially completed
- **WHEN** the user deletes a conversation whose historical roots or recursive descendants cannot all be deleted immediately
- **THEN** the conversation is durably marked `deleting`, rejects new sends, and remains visible as cleanup pending
- **AND** successful `deleted` or `not_found` sessions are recorded while ownership and lineage for remaining sessions are retained
- **AND** writable restart or background reconciliation retries children before roots until the complete family is confirmed removed
- **AND** only then are the conversation runtime records deleted

#### Scenario: Read-only server receives conversation deletion
- **WHEN** a client requests deletion through a read-only server
- **THEN** the request is rejected without changing cleanup, ownership, session, or conversation state

### Requirement: Session visibility and lineage use a closed family
The server MUST classify sessions as `normal`, `toon_transient_generation`, `toon_project_assistant`, or `toon_project_subagent`, enforce parent and project lineage, and filter list and event APIs by that classification.

#### Scenario: Normal conversation list is requested
- **WHEN** a client requests normal JuggleWork conversations
- **THEN** project assistant, Toon subagent, and transient generation sessions are excluded

#### Scenario: Project assistant events are requested
- **WHEN** a client subscribes with an authorized project and conversation scope
- **THEN** it receives the parent and permitted descendant events for that lineage only
- **AND** events from normal chats or other projects are excluded

### Requirement: Assistant turns stream through a dedicated project API
The system SHALL expose dedicated project assistant operations for create/list/read conversations, send, stream/replay events, stop, edit-and-resend, attachments, interactions, subagents, and canvas calls, with stable event IDs and resumable cursors.

#### Scenario: Stream connection is interrupted
- **WHEN** a client reconnects with the last acknowledged event cursor
- **THEN** the API replays later retained events in order without duplicating terminal message records

#### Scenario: User stops a running turn
- **WHEN** the user invokes stop on the active project turn
- **THEN** the runtime requests cancellation for that exact turn
- **AND** the server continues discovering and cancelling late descendants without requiring UI polling
- **AND** zero active sessions does not become terminal until a persisted quiet window has observed stable lineage and status
- **AND** the UI reports the eventual state and whether remote work may continue

#### Scenario: Stop reconciliation reaches its deadline
- **WHEN** descendant lineage or cancellation remains uncertain until the bounded stop deadline
- **THEN** the old turn becomes interrupted with remote work possibly continuing
- **AND** restart restores the persisted deadline and reconciliation state rather than treating the turn as stopped
- **AND** the conversation switches to an isolated root before accepting another send, even when no replacement is queued
- **AND** the old turn warning remains visible until the user acknowledges it or a new turn starts

#### Scenario: Read-only client observes a stopping turn
- **WHEN** a read-only server lists conversations, reads a snapshot, or polls events while a stop or replacement is pending
- **THEN** the request returns only the persisted projection
- **AND** does not abort or create sessions, dispatch a replacement, write runtime SQLite, or modify project files

### Requirement: Edit-and-resend preserves conversational history
The assistant SHALL let the user edit a prior user message and resend it as a new branch while preserving the original branch and its tool, subagent, and output history.

#### Scenario: User edits an earlier request
- **WHEN** the user changes a prior user message and confirms resend
- **THEN** the system forks the source session before that user message, or creates a new session and replays only bounded authoritative user and assistant text before that message
- **AND** the edited message, later messages, and prior tool side effects are excluded from the replacement model context
- **AND** branch metadata records the source message and isolated root before the replacement turn starts
- **AND** the original branch remains inspectable and is not rewritten

#### Scenario: Descendant work is still active
- **WHEN** edit-and-resend targets a message with a running descendant
- **THEN** the system durably queues the replacement, stops that descendant, and launches the replacement only after the old turn is terminal
- **AND** if cancellation remains uncertain, the replacement uses an isolated root while every old descendant remains permanently owned by the old turn
- **AND** late old-root output remains inspectable on the archived branch but never enters the new active branch
- **AND** both terminal outcomes and any remote-continuation warning remain visible

### Requirement: Attachments and mentions resolve to revisioned project context
The assistant SHALL support safe attachments and `@node` and `@asset` mentions using stable project references, bounded content, and the revision observed when the turn begins.

#### Scenario: User mentions a node and asset
- **WHEN** the user sends a message containing valid `@node` and `@asset` references
- **THEN** the server resolves authorized, type-appropriate context and records the referenced IDs and revisions
- **AND** the UI shows which context was included or truncated

#### Scenario: Mention becomes stale or missing
- **WHEN** a referenced node or asset changed or was removed before send
- **THEN** the turn is blocked or explicitly sent with a stale/missing marker according to user choice
- **AND** a different entity is not silently substituted

### Requirement: Tool, question, and subagent activity is first-class history
The assistant SHALL render tool progress, structured questions, user answers, subagent lineage, and terminal results as typed persistent interaction records rather than flattening them into unstructured prose.

#### Scenario: Agent asks a structured question
- **WHEN** the runtime requests one or more choices or free-text answers
- **THEN** the assistant displays an accessible interaction, persists the answer, and resumes the waiting turn once

#### Scenario: Agent delegates to a subagent
- **WHEN** an allowed tool creates a project subagent
- **THEN** its progress and terminal result appear under the parent call
- **AND** the child is hidden from normal chat and cannot access another project

### Requirement: Canvas calls are proposed and executed as semantic commands
The assistant SHALL translate canvas mutations into typed semantic command proposals showing affected canvases and entities, and SHALL execute them only after applicable permission or confirmation checks.

#### Scenario: Agent proposes a reversible canvas edit
- **WHEN** an Agent requests creation or movement of nodes
- **THEN** the user can inspect the typed operation summary before execution when policy requires review
- **AND** the committed command appears in canvas history and can be undone

#### Scenario: Agent requests an unsafe operation
- **WHEN** a canvas call contains an arbitrary path, dynamic script, invalid reference, or operation outside the project scope
- **THEN** the server rejects it before mutation
- **AND** the assistant receives a sanitized stable error

### Requirement: Assistant tools enforce least privilege and auditability
Every assistant tool call MUST be project-scoped, schema-validated, permission-checked, size-bounded, and recorded with actor, target IDs, outcome, and sanitized diagnostic; arbitrary shell, credential access, dynamic code, and unrestricted filesystem tools MUST NOT be exposed.

The managed OpenCode Toon bridge MUST use an internal credential scoped to one managed engine instance and distinct from host, owner, and collaborator credentials. One managed engine credential MAY serve every currently configured local workspace on that engine, including local workspaces added after engine startup, but MUST stop authorizing a workspace as soon as it is removed. The credential MUST authorize only the bridge endpoint, MUST be injected through the managed OpenCode environment without logging or returning it, and MUST be rejected unless the requested workspace is currently configured and local and the addressed OpenCode session metadata workspace/project, persisted visibility lineage, project/conversation mapping, active turn, and real tool call ID and input all agree. Remote workspaces remain unavailable and read-only servers MUST reject bridge mutation actions before invoking mutation services.

#### Scenario: Read tool is allowed
- **WHEN** the Agent invokes an allowed read tool for the active project
- **THEN** only authorized project data within declared limits is returned
- **AND** the call and result status are retained in conversation history

#### Scenario: Destructive tool requires confirmation
- **WHEN** the Agent proposes deleting referenced project entities
- **THEN** the UI identifies affected entities and requires explicit human confirmation
- **AND** denial produces no mutation

#### Scenario: Managed OpenCode invokes the internal workspace bridge
- **WHEN** a managed project assistant tool uses its engine credential for the exact active call in a currently configured local workspace
- **THEN** the bridge overlays its existing project and tool safety checks and executes the scoped action
- **AND** collaborator credentials, an unconfigured, removed, or remote workspace, a cross-workspace or mismatched project session, an inactive turn, or a forged call ID or input are rejected
- **AND** the dedicated credential cannot access any other host route

#### Scenario: Managed engine workspace membership changes
- **WHEN** a local workspace is added to or removed from a running server whose managed OpenCode engine already has its bridge credential
- **THEN** the added workspace can use that same engine credential after its exact session and project mappings are established
- **AND** the removed workspace is rejected without rotating the credential or binding it to whichever workspace is first

### Requirement: The assistant dock remains available across project modes
The assistant SHALL be available as a resizable, collapsible floating or docked panel in Canvas and Document modes, preserve its active conversation and draft while switching modes, and use a non-obscuring sheet or modal presentation on narrow layouts.

#### Scenario: User switches from Canvas to Document
- **WHEN** a user with an open assistant draft changes workspace mode
- **THEN** the same conversation, draft, stream status, and panel preference remain available

#### Scenario: Window becomes narrow
- **WHEN** the dock can no longer coexist with usable primary content
- **THEN** it changes to an accessible sheet or modal surface
- **AND** closing it restores focus to the invoking control
