## 1. Contract and Runtime

- [x] 1.1 Extend the voice-session client and server contract with a backward-compatible dictation purpose.
- [x] 1.2 Configure direct and managed sessions for transcription without fixed language, tools, or automatic responses.
- [x] 1.3 Add a shared microphone lease and reusable permission handling.

## 2. Composer Integration

- [x] 2.1 Add a bounded dictation controller with complete cleanup, cancellation, and timeout behavior.
- [x] 2.2 Add Lexical insertion at the current selection with append fallback and undo support.
- [x] 2.3 Add localized microphone states beside the submit control without automatic submission.
- [x] 2.4 Cancel dictation on session/workspace change and block concurrent Voice Mode capture.
- [x] 2.5 Detect whether a voice service is configured, disable the unavailable microphone action, and explain how to configure it on hover.

## 3. Desktop and Diagnostics

- [x] 3.1 Update the macOS microphone usage description for Voice Mode and task dictation.
- [x] 3.2 Keep audio and transcript contents out of persistence and diagnostic logs.

## 4. Validation

- [x] 4.1 Add unit coverage for the state machine, lease, transcript completion, cancellation, and insertion fallback.
- [x] 4.2 Add server coverage for assistant compatibility and dictation session configuration.
- [x] 4.3 Run focused tests, app/server typechecks, OpenSpec validation, and production builds.
- [ ] 4.4 Manually verify microphone permission and dictation on packaged macOS and Windows builds.
