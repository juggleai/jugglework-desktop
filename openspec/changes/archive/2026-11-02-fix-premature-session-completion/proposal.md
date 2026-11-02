## Why

A local task was recorded completed 56 milliseconds after reservation, before its first assistant message. Renderer progress followed by a transient idle can settle the coordinator prematurely, while sidebar and session surfaces disagree about execution.

## What Changes

- Treat renderer idle/completed observations as hints requiring current engine and delegated-descendant checks plus a current-run final assistant receipt.
- Require separated authoritative idle samples even after activity was observed; preserve exact run identity and accepted abort handling.
- Ignore user-message writes as engine progress and preserve server-owned running presentation across transient idle snapshots.
- Keep the session surface running while the coordinator owns the task, except explicit failures; show failures/incomplete work as attention rather than green completion.

## Capabilities

### New Capabilities
- `session-completion-consistency`: Evidence-based completion and consistent task presentation.

### Modified Capabilities
None.

## Impact

Server session mutation routes/coordinator, renderer run observation and activity/completion state, focused regression tests. No schema migration or application restart required for source changes; installed binaries require rebuilding before use.
