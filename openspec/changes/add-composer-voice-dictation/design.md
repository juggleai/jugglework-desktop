## Context

Voice Mode already obtains a short-lived Realtime client secret, opens a WebRTC connection, and captures microphone audio. It is an assistant-control surface with automatic responses and tools. Composer dictation needs the same secure transport and permissions but must never answer, call tools, replace unrelated draft content, or submit a task.

## Decisions

### Keep dictation separate from Voice Mode

Composer dictation owns a small state machine and only produces final text. The existing Voice Mode panel remains a voice assistant. Both use a shared microphone lease so only one feature can capture audio at a time.

### Extend the existing voice-session route

`POST /voice/realtime/session` accepts `purpose: "assistant" | "dictation"`, defaulting to `assistant`. A dictation session uses transcription without a fixed language, disables turn detection, clears tools, and does not create a response. The renderer repeats the safe session configuration after the data channel opens so older managed brokers cannot accidentally enable assistant behavior.

### Commit audio explicitly

The user clicks once to start and once to stop. Stopping disables the microphone track, commits the Realtime input buffer, waits up to 20 seconds for the completed transcription, and then releases every media and peer resource. Recording is bounded to five minutes.

### Insert through Lexical

The editor exposes an imperative text insertion command. It inserts at the current range selection, replaces selected text, and appends at the end if no valid selection exists. The operation is one Lexical update so normal undo removes the transcript in one step.

### Cancel on navigation

Dictation belongs to the session that started it. Changing session or workspace, unmounting the composer, or closing the page cancels capture and discards any late transcript.

## Risks and Mitigations

- A managed broker may ignore the new purpose. The client sends a defensive session update and never requests a response.
- Permission can be denied outside the renderer. Existing Electron permission handlers and the macOS system bridge remain authoritative, with actionable localized errors.
- Realtime completion may never arrive. A bounded timeout closes the connection and preserves the existing draft.
- Voice Mode and dictation may contend for the same microphone. A shared lease rejects the second owner without interrupting the first.
