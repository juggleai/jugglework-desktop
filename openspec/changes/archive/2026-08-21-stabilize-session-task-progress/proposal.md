## Why

The task-progress panel above the composer can disappear while a task is active or remain after the run has ended because todo data and run state use independent cache keys, lifetimes, and terminal semantics. This makes progress unreliable precisely when users need it to understand long-running work.

## What Changes

- Keep todo state alive while its session is retained instead of allowing unobserved query GC to erase it mid-run.
- Use the runtime workspace identity consistently for todo events, snapshots, and UI reads, including remote workspaces.
- Subscribe each split pane to its own session interactions instead of forcing the secondary pane to have no todos.
- Reconcile live todo events and snapshots without allowing an older snapshot to overwrite newer live progress.
- Tie progress visibility to run and todo terminal state: preserve active/incomplete work, and hide successfully completed/cancelled progress after a short acknowledgement period.
- Prevent a delayed prompt-acceptance response from reviving a run that already completed.

## Capabilities

### New Capabilities
- `session-task-progress`: Reliable, session-scoped task progress presentation across active, terminal, remote, split-pane, snapshot, and reconnect flows.

### Modified Capabilities

None.

## Impact

- Renderer session synchronization, query-cache defaults, interaction hooks, split-pane plumbing, and composer progress rendering.
- Session lifecycle tests for todo cache retention, workspace key consistency, stale snapshot protection, terminal visibility, and fast-run completion races.
- No public API or persisted-data breaking change.
