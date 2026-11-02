## Why

The desktop app already has microphone permission handling and a Realtime Voice Mode, but the task composer has no direct dictation path. Users must type long task descriptions or open the separate voice-control panel, which can also answer and operate the UI instead of behaving like a predictable text input.

## What Changes

- Add a microphone action beside the composer submit control.
- Capture one user-controlled recording and insert its final transcript at the composer selection without submitting it.
- Extend the existing Realtime session contract with a backward-compatible dictation purpose that disables responses and tools.
- Reuse the current managed-model and direct OpenAI credential resolution without exposing durable secrets to the renderer.
- Coordinate microphone ownership between composer dictation and Voice Mode.

## Capabilities

### New Capabilities

- `composer-voice-dictation`: Session-scoped, user-controlled speech-to-text input for the task composer.

### Modified Capabilities

None.

## Impact

- Updates the session composer, Lexical editor command surface, voice Realtime client, server voice-session route, Electron microphone usage copy, and localized strings.
- Adds no audio persistence and does not change task submission semantics.
