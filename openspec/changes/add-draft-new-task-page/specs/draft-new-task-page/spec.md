## ADDED Requirements

### Requirement: Draft page replaces immediate session creation
Every desktop entry that starts a new task in a workspace SHALL open that workspace's draft page and SHALL NOT create a session, sidebar row, or tab until the user sends the first message. These entries are the sidebar project "+", the "no tasks" row, the group-header "+", the new-task keyboard shortcut, the command palette "New session", the composer `/new` command, and the placeholder starter cards.

#### Scenario: Click "+" on a project row
- **WHEN** the user clicks "+" on a project row
- **THEN** the app opens the draft page for that workspace with a focused composer
- **AND** no session is created and the sidebar session list is unchanged

#### Scenario: Leave without sending
- **WHEN** the user opens the draft page and navigates elsewhere without sending
- **THEN** no session exists for that draft

#### Scenario: Starter card prefill
- **WHEN** the user chooses a starter card that carries a prompt
- **THEN** the draft page opens with that prompt in the composer and nothing is sent or created

#### Scenario: Agent-created session
- **WHEN** an agent or voice control action `session.create_task` runs
- **THEN** it creates the session immediately and returns the created session as before

### Requirement: Per-workspace draft retention
The app SHALL keep one draft per workspace for the lifetime of the app process. A draft SHALL hold the composer text, attachments, pasted-text parts, mentions, selected model, agent, permission mode, and target group. A draft SHALL be discarded only when its session is successfully created and the first prompt is accepted, or when the user explicitly clears it.

#### Scenario: Repeated "+" in the same workspace
- **WHEN** the user has typed in a workspace's draft and clicks "+" for the same workspace again
- **THEN** the draft page shows the same content and selections unchanged

#### Scenario: Switching workspaces
- **WHEN** the user has an unsent draft in workspace A, clicks "+" in workspace B, then clicks "+" in workspace A
- **THEN** workspace B shows its own draft and workspace A's draft is still intact
- **AND** the two drafts never share content

#### Scenario: Visiting other pages
- **WHEN** the user opens Settings or another app page and returns to the draft page
- **THEN** the draft content is preserved and the draft page is shown rather than the last session

#### Scenario: Application restart
- **WHEN** the app restarts
- **THEN** unsent drafts are not restored

### Requirement: Deferred creation on first send
Sending from the draft page SHALL create the session, then send the draft content to it, then navigate to the created session. The draft SHALL move to the created session before the prompt is sent so that a send failure restores the content in that session. The draft's model, agent, permission mode, and group SHALL apply to the created session.

#### Scenario: Successful first send
- **WHEN** the user sends from the draft page
- **THEN** one session is created in that workspace, the prompt is sent to it, and the app shows the new session with the prompt submitted
- **AND** the workspace's draft is empty afterward

#### Scenario: Prompt send fails after creation
- **WHEN** the session is created but sending the prompt fails or its outcome is unconfirmed
- **THEN** the created session is kept and opened with the unsent content restored in its composer
- **AND** a retry sends to that session without creating another

#### Scenario: Creation fails
- **WHEN** session creation fails
- **THEN** the draft page remains with its content intact and an error is shown

#### Scenario: Repeated send while creating
- **WHEN** the user triggers send again while creation is in progress
- **THEN** only one session is created

#### Scenario: Group target
- **WHEN** the draft was opened from a group-header "+"
- **THEN** the session created from it is assigned to that group

### Requirement: Draft page does not support Office selection references
The draft page SHALL NOT accept Office selection references, because a reference belongs to an existing session. Office editing entries SHALL continue to target existing sessions only.

#### Scenario: Add an Office selection while a draft page is open
- **WHEN** an Office window adds a selection and only a draft page exists for the workspace
- **THEN** the draft receives no reference and the existing Office session routing is unchanged

### Requirement: Draft page does not act on another session
While the draft page is shown, session-scoped actions such as rename, delete, share, terminal, and voice input SHALL NOT resolve to a different open session or tab.

#### Scenario: Action buttons on the draft page
- **WHEN** the draft page is shown while other sessions are open in tabs
- **THEN** session-scoped actions are hidden or disabled and do not affect those sessions

### Requirement: Draft page navigation stability
The draft route SHALL NOT be redirected to the last-opened session while a draft is being shown, and returning from Settings SHALL restore the draft page if it was the last page in that workspace.

#### Scenario: Open the draft page in a workspace with prior sessions
- **WHEN** the workspace has a remembered last session and the user opens the draft page
- **THEN** the draft page stays visible

#### Scenario: Return from Settings
- **WHEN** the user opens Settings from the draft page and goes back
- **THEN** the draft page is shown with its content
