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
- Preserve a bounded, content-free lifecycle journal for start, activity,
  terminal, abort, and reconciliation events.
- Keep generation fencing so delayed observations cannot terminate a newer run.

## Compatibility boundary

The bundled OpenCode runtime owns the internal promise that waits for a child
agent. JuggleWork will not mutate that private promise or silently replay a user
prompt. When the runtime has already become idle, JuggleWork terminalizes its UI
projection and reports the interrupted work. The user can then retry or continue
without the application falsely claiming the old execution is still alive.

