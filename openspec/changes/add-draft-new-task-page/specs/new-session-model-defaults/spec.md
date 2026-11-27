## MODIFIED Requirements

### Requirement: Remember model and reasoning selection
The desktop SHALL remember the model and reasoning strength most recently selected by the user and SHALL use that pair as the default for subsequently created workspace sessions. A model or reasoning selection made on a workspace draft page SHALL be held on that draft and SHALL apply to the session created from it. It SHALL become the remembered default when that session is created, and it SHALL NOT change the model of any existing session.

#### Scenario: New session after model and reasoning selection
- **WHEN** the user selects a model and reasoning strength in one session and then creates another session
- **THEN** the new session initially uses the selected model and reasoning strength

#### Scenario: Session-specific selection remains isolated
- **WHEN** a user changes a session's model or reasoning strength
- **THEN** the current session receives an explicit override while future sessions inherit the same values from the remembered defaults

#### Scenario: Selection made on the draft page
- **WHEN** the user selects a model on a workspace draft page and sends the first message
- **THEN** the created session uses that model and reasoning strength
- **AND** existing sessions keep their own models

#### Scenario: Draft selection is never sent
- **WHEN** the user selects a model on a draft page and leaves without sending
- **THEN** the remembered default for later sessions is unchanged
