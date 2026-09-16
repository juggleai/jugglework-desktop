# Design

## Invariants

1. An authoritative idle snapshot cannot contain a visibly running tool.
2. A delayed event from generation N cannot change generation N+1.
3. Stream reconnection must be followed by a full snapshot reconciliation.
4. Lifecycle telemetry must not contain prompt text, file contents, credentials,
   tool arguments, or model output.

## Renderer reconciliation

The existing five-minute no-progress timer remains a suspicion signal, not an
immediate failure. When it fires, the session sync layer invalidates the session
snapshot and active-run query. The server performs its existing two-sample
authoritative idle check. If the refreshed snapshot is idle, any tool part still
in an input/running state is projected as an interrupted error part.

This changes only the presentation projection. Stored OpenCode messages are not
rewritten, so subsequent runtime upgrades can continue to own their transcript.

## Delegated child recovery

A parent can legitimately produce no text while one or more delegated child
sessions continue to emit model or tool activity. The watchdog therefore reads
the child session IDs preserved on in-flight task parts and evaluates each
child's activity record independently.

Recent child activity refreshes the waiting parent's progress clock. A child is
eligible for destructive recovery only when the child itself has crossed the
no-progress threshold and second-stage grace period, is still authoritative
busy, and is not retrying, compacting, or waiting for user interaction.

Recovery calls a parent-bound endpoint that verifies the child's `parentID`
before forwarding an abort to that child. It never aborts the root session. If
child identity or activity is unavailable, the watchdog remains non-destructive
and relies on snapshot reconciliation.

## Stream recovery

The first successful event-stream connection uses the initial snapshot already
loaded by the session surface. Every later successful connection invalidates the
session snapshot and active-run query, recovering events lost while disconnected.

## Lifecycle journal

The server stores one current run row and bounded lifecycle event rows in its
runtime SQLite database. Rows contain IDs, generation, origin, event, status,
timestamps, and terminal reason only. The journal is diagnostic and does not
replace the in-memory mutation coordinator.

## Upstream boundary

Automatically resolving OpenCode's private child-task promise or replaying a
prompt could duplicate file writes and tool calls. This change uses only the
public child-session abort operation; OpenCode remains responsible for resolving
the task tool and continuing the parent with completed sibling results.
