## ADDED Requirements
### Requirement: Organization meetings
Desktop SHALL expose a meeting workspace with upcoming meetings, scheduling and calendar, scoped to the active authenticated organization.
#### Scenario: No media configuration
- **WHEN** ZEGO configuration is absent
- **THEN** Desktop shows the missing-configuration state and does not simulate a successful call.
### Requirement: Independent meeting transport
Meeting SHALL use ZEGO for media and JuggleIM chatrooms for meeting chat, without using JuggleCall.
#### Scenario: Private chat adds a third participant
- **WHEN** an authorized attendee invites another organization member
- **THEN** that member can access meeting chat but cannot access the source private conversation.
### Requirement: Group admission
Current members of a meeting's source organization group SHALL be able to join without individual invitation.
#### Scenario: Former member attempts admission
- **WHEN** a former group member with no separate invitation attempts to join
- **THEN** the server denies admission.

### Requirement: Stable meeting interaction
Desktop SHALL preserve video capture during audio-only changes and reuse the active meeting window.
#### Scenario: Microphone toggled during video
- **WHEN** the attendee enables or mutes their microphone
- **THEN** the video stream and rendered video element remain intact.
#### Scenario: Rejoin the active meeting
- **WHEN** an attendee clicks Join for the meeting they are already attending
- **THEN** Desktop focuses its existing window without opening another admission preview.

### Requirement: Persistent compact window
Desktop SHALL show compact controls when the full meeting window is unfocused, minimized or hidden.
#### Scenario: Another window takes focus
- **WHEN** another window covers the meeting
- **THEN** compact controls appear while the full meeting window remains open.
#### Scenario: Return to the meeting
- **WHEN** the full meeting window regains focus
- **THEN** compact controls hide without recreating the meeting renderer.

### Requirement: Member attendance and targeted invitations
Desktop SHALL distinguish active participants from absent members and allow invitations on absent member rows.
#### Scenario: Invite an absent member
- **WHEN** an attendee invites one absent member
- **THEN** authorization is saved and a private JuggleIM meeting card is sent only to that member; invitation delivery alone does not mark them present.

### Requirement: Stable scheduling display
Background refresh SHALL retain schedule content during loading.
#### Scenario: Home calendar date selected
- **WHEN** a user selects a date in the home calendar
- **THEN** only the adjacent schedule changes and the home view remains selected.

### Requirement: Explicit desktop and window selection
Electron SHALL present a meeting-window modal with desktop/window thumbnails and filters before sharing. Selection alone SHALL NOT start capture.
#### Scenario: Confirm a source
- **WHEN** the user selects an available source and confirms sharing
- **THEN** the pending display request resolves with that source, preserving the existing ZEGO publication and cleanup path.
#### Scenario: Cancel or invalidate selection
- **WHEN** the user cancels, leaves, the request times out, or the owning renderer/window is destroyed
- **THEN** the pending display request is cancelled without publishing a stream.
#### Scenario: Selected window has closed
- **WHEN** the selected source no longer exists at confirmation
- **THEN** the modal remains open with a refresh/reselection message and no fallback capture starts.

### Requirement: Draggable workbench navigation
The meeting workbench header SHALL support native window dragging without intercepting navigation controls.
#### Scenario: Switch meeting views
- **WHEN** the user clicks Home, Calendar or History in the header
- **THEN** the selected view changes normally; the tabs remain outside the native drag region.
