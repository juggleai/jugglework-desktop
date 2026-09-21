## ADDED Requirements

### Requirement: Composer offers explicit voice dictation

The desktop composer SHALL provide a microphone action that starts and stops one recording. The final non-empty transcript SHALL be inserted into the composer without submitting the task.

#### Scenario: User dictates a task

- **WHEN** the user starts dictation, speaks, and stops recording
- **THEN** the final transcript is inserted at the current composer selection
- **AND** the task is not submitted automatically

#### Scenario: Composer already contains content

- **WHEN** dictation completes while the composer contains text, attachments, or capability tokens
- **THEN** those existing values are preserved
- **AND** only the active text selection is replaced or extended

#### Scenario: No voice model is configured

- **WHEN** neither JuggleWork Models voice nor a direct OpenAI Realtime credential is configured
- **THEN** the composer microphone action is visibly disabled
- **AND** hovering the action explains that the user must configure a voice model in Settings

### Requirement: Dictation has bounded lifecycle

The application SHALL release microphone, media, peer, channel, and timer resources after success, cancellation, error, navigation, timeout, or unmount.

#### Scenario: User switches sessions during recording

- **WHEN** the owning session or workspace changes before dictation completes
- **THEN** recording is cancelled
- **AND** a late transcript is not applied to either session

#### Scenario: Transcription does not complete

- **WHEN** no final transcript arrives within the completion timeout
- **THEN** dictation returns to a retryable state
- **AND** the existing composer draft remains unchanged

### Requirement: Dictation never behaves as a voice assistant

The application SHALL configure dictation without automatic responses or tools and SHALL use automatic language detection.

#### Scenario: Audio is committed

- **WHEN** the user stops a dictation recording
- **THEN** the audio buffer is committed for transcription
- **AND** no assistant response, tool call, or audio playback is requested

### Requirement: Microphone ownership is exclusive

Composer dictation and Voice Mode SHALL NOT capture the microphone concurrently.

#### Scenario: Another voice feature owns the microphone

- **WHEN** the user starts dictation while Voice Mode owns the microphone
- **THEN** dictation does not interrupt Voice Mode
- **AND** the user receives a clear conflict message
