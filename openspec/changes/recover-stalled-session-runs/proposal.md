# Change: Recover stalled session runs

## Why

Provider streams and delegated child sessions can disappear without emitting an
idle, error, cancellation, or timeout event. The renderer currently recognizes
that no visible progress has occurred, but it continues to present the run as
active. A persisted `running` task can therefore survive after the authoritative
engine has no active execution, leaving the parent turn and progress UI stuck.

## What Changes

- Reconcile a stalled renderer run against an authoritative session snapshot.
- Treat in-flight tool parts in an authoritative idle snapshot as interrupted,
  instead of continuing to render them as running forever.
- Run completion diagnostics for interrupted tool parts and expose an explicit
  recoverable state to the user.
- Force a full authoritative session refresh after an event-stream reconnect.
- Treat recent delegated-child activity as parent-run progress while the parent
  is waiting for the task tool.
- Recover a confirmed stalled delegated child by aborting only that verified
  child session, never the root session that is waiting for it.
- Preserve a bounded, content-free lifecycle journal for start, activity,
  terminal, abort, and reconciliation events.
- Keep generation fencing so delayed observations cannot terminate a newer run.

## Compatibility boundary

The bundled OpenCode runtime owns the internal promise that waits for a child
agent. JuggleWork will not mutate that private promise or silently replay a user
prompt. A recovery request may use OpenCode's public per-session abort endpoint
only after verifying the child belongs to the waiting parent and the child's own
liveness window has expired. The parent remains active so OpenCode can return the
child cancellation through the task tool and continue with partial results.
