## Why

Session snapshot refreshes are currently treated like navigation transitions, which temporarily disables the composer and drops the user's caret. Session navigation also broadcasts four untargeted focus events, so stale retries and multiple mounted composers can override newer user intent.

## What Changes

- Keep the intended session composer interactive while its existing snapshot refreshes in the background.
- Replace fixed-delay global focus retries with one pending request scoped to a target session.
- Cancel stale focus requests when another navigation or a newer pointer/keyboard action occurs.
- Allow only the active workbench pane to complete a focus handoff.

## Capabilities

### New Capabilities

- `session-composer-focus`: Stable drafting and intentional focus handoff across session navigation and background synchronization.

### Modified Capabilities

None.

## Impact

- Updates session transition classification, composer focus coordination, onboarding navigation, model-picker return focus, and control-driven composer input.
- Adds focused regression coverage without changing persisted session or draft data.
