## ADDED Requirements

### Requirement: Share the JuggleWork window
The meeting share picker SHALL offer the JuggleWork main window as a dedicated source. Desktop SHALL start capture only when that source is present in the current capture enumeration, and SHALL show a sharing indicator with a stop control in the main window while it is being shared.

#### Scenario: Main window source is unavailable
- **WHEN** the main window source is missing from the current enumeration
- **THEN** Desktop does not start capture
- **AND** it asks the user to choose from desktops and windows instead

### Requirement: Choose a cloud document to share
The share dialog SHALL offer "Desktop and windows" and "Cloud documents" tabs. The cloud documents tab SHALL list recent readable documents of the meeting organization, search them by title, and allow documents, whiteboards, spreadsheets and presentations to be selected. The client SHALL start and hold the organization background page while the user is in a meeting, and SHALL show the last list of the meeting immediately while refreshing it. Switching to the cloud documents tab SHALL cancel any pending capture request without reporting an error.

#### Scenario: Switch from capture to documents
- **WHEN** the user opens the dialog on "Desktop and windows" and switches to "Cloud documents"
- **THEN** the pending capture request is cancelled and no stream is published
- **AND** returning to "Desktop and windows" starts a new capture request from that click

#### Scenario: Spreadsheet and presentation
- **WHEN** a listed item is a spreadsheet or presentation
- **THEN** it can be selected and shared like a document

### Requirement: Single server-owned share slot
The meeting service SHALL hold at most one share slot per meeting, of kind screen or doc. Only a joined participant with its current session SHALL claim the slot, and claiming SHALL replace any existing slot with a new share id. Only the sharer or the host SHALL release it. The slot SHALL be cleared when the sharer leaves, its session expires, it is removed, or the meeting ends. The service SHALL NOT store the shared document or viewport.

#### Scenario: Another participant becomes the sharer
- **WHEN** a participant claims the slot while another share is active
- **THEN** the service stores a new share id for that participant
- **AND** the previous sharer's client stops its screen stream or doc state broadcasting after its next snapshot

#### Scenario: Stale release
- **WHEN** a release carries a share id that is no longer current
- **THEN** the service leaves the current slot unchanged and returns the current snapshot

### Requirement: Doc share state message
The sharer's client SHALL publish `jw:meeting-share-docs` to the meeting chatroom as a JuggleIM status message (`isStatus`, not stored, not counted). Each message SHALL carry the sharer's complete current document and viewport state with a sequence number that increases within the share id, and SHALL NOT carry actions, document content, titles or URLs. The viewport SHALL be a block anchor for pages, canvas coordinates for whiteboards, a slide id for presentations, and a sheet id with the top-left visible cell for spreadsheets. The sharer SHALL resend the current state while idle. Receivers SHALL apply only the newest state from the sender, session and share id in the current snapshot, and SHALL NOT request retransmission.

#### Scenario: Out-of-order or stale state
- **WHEN** a receiver gets a state whose sequence is not greater than the last applied one, or whose share id, session or sender does not match the snapshot
- **THEN** it discards the message without changing its view

#### Scenario: Participant joins mid-share
- **WHEN** a participant joins while a doc share is active
- **THEN** it opens the document from the next received state without asking the sharer

#### Scenario: State stops arriving
- **WHEN** no newer state arrives for 10 seconds
- **THEN** the participant keeps the current document and shows that position sync is interrupted

### Requirement: Open shared documents with each participant's own access
Each participant SHALL open the shared document through a normal Docs launch for the meeting organization with their own identity. Doc sharing SHALL NOT transmit rendered pixels or grant document access.

#### Scenario: Participant lacks access
- **WHEN** Docs denies a participant access to the shared document
- **THEN** the meeting window shows a no-access state for that participant
- **AND** the participant's meeting media and chat continue

### Requirement: Follow and free browsing
Participants SHALL follow the latest share state by default. A viewport report marked as user input SHALL switch the participant to free browsing. "Follow sharer" SHALL return to following and apply the latest state. While free browsing, the share bar SHALL show where the sharer is relative to the local viewport, using a heading read from the participant's own document. Local zoom SHALL NOT change the follow state, be published, or affect cloud documents in other windows.

#### Scenario: Sharer opens another document
- **WHEN** the latest state names a different document
- **THEN** following participants open that document
- **AND** free-browsing participants stay on their current document with a notice

### Requirement: Restricted viewport bridge
Docs SHALL report and apply meeting viewports only after advertising the `meetingViewport` capability in `docs.ready`. Viewport messages SHALL contain only document id, mode, block anchor or canvas coordinates and a user-input flag derived from real input events, and the preload SHALL drop any other field.

#### Scenario: Remote viewport applied
- **WHEN** the host applies a viewport to the page
- **THEN** the resulting scroll is reported with the user-input flag false
- **AND** the participant stays in following
