# Change: Stabilize switching between large sessions

## Why
Long-running desktop processes can accumulate expensive OpenCode session reads and event-stream reconnects. The renderer currently treats 30 seconds without a business event as a stale stream even though an SSE connection may legitimately be quiet, and superseded sidebar/detail/snapshot reads are ignored only after they finish rather than being cancelled. Together these behaviors can leave OpenCode servicing obsolete work until session switching appears stuck.

## What Changes
- Keep a healthy event stream open while it is quiet and reconnect only after the transport ends or fails.
- Retry failed event streams with bounded exponential backoff and jitter while preserving one connection per workspace endpoint.
- Abort superseded session-list, route-detail, and transcript-snapshot reads when a newer navigation or refresh replaces them.
- Preserve the existing bounded transcript window and all session history in storage; this change does not delete or compact user data.

## Impact
- Affected specs: `session-runtime-observability`, `session-view-reuse`
- Affected app areas: workspace session routing, shared session sync, JuggleWork server client, session snapshot loading

