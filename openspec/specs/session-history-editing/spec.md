# Session history editing

## Purpose

Allow a user to revise a previously sent message and continue from that point in the same task session.

## Requirements

### Requirement: Edit a message in place

The desktop client SHALL open an inline editor with the selected message text. Opening or cancelling the editor SHALL preserve the transcript and the main composer draft.

#### Scenario: Cancel an edit

- **WHEN** the user modifies a historical message and cancels
- **THEN** the original message and subsequent turns remain visible in their original order

### Requirement: Submit a replacement in the same session

For an idle session, the workspace service SHALL preserve all messages preceding the selected user message and replace the conversation from that message onward. The edit SHALL NOT create a fork or archive or revert workspace files.

#### Scenario: Replace the first user message

- **WHEN** the user confirms an edit of the first message
- **THEN** the edited prompt starts a new turn in the same session with the original file attachments

#### Scenario: Resend after an assistant error with no response text

- **WHEN** the last persisted message contains only an assistant error and the user opens an earlier message for editing
- **THEN** the desktop captures the last persisted message ID from the session snapshot, including the error message, for the history check at submission

#### Scenario: The transcript changed while editing

- **WHEN** the latest message no longer matches the tail recorded when editing began
- **THEN** the service rejects the edit before deleting messages

#### Scenario: The service does not support history editing

- **WHEN** a workspace service does not advertise history editing
- **THEN** the client explains the limitation and does not send the edited prompt
