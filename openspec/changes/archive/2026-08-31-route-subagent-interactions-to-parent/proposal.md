## Why

Subagents run in child OpenCode sessions that are intentionally hidden from normal desktop navigation. When a child requests an interaction such as `external_directory`, JuggleWork currently keys and displays that request only under the child session, leaving the visible parent with no approval surface and the parent Task tool permanently running.

## What Changes

- Introduce workspace-level interaction ownership that preserves the child session as the reply target while resolving its visible root parent for presentation.
- Surface pending permission and question requests from all descendant sessions in the visible parent session, including nested subagents.
- Reconcile descendant interactions from authoritative snapshots after startup, navigation, event loss, or SSE reconnection instead of relying only on live child events.
- Keep interaction replies session-exact and race-safe so approvals shown in a parent are dispatched to the originating child session.
- Represent a parent Task that is blocked by a descendant interaction as waiting for approval rather than generic perpetual running.
- Extend local and remote interaction projection so descendant requests remain actionable through the visible root session without exposing hidden child sessions as top-level sessions.

## Capabilities

### New Capabilities
- `descendant-session-interactions`: Aggregates permissions and questions from child and nested subagent sessions into their visible root session while retaining exact child-session reply targeting, lifecycle reconciliation, and blocked-task status.

### Modified Capabilities

## Impact

- Desktop renderer session sync, interaction cache/store, approval UI, and Task tool status presentation.
- JuggleWork desktop server interaction read APIs and session-tree resolution.
- Remote session event projection and interaction snapshots for parent-bound remote control.
- OpenCode legacy and v2 permission/question compatibility paths.
- Regression coverage for parent/child routing, nested descendants, reconnect snapshots, exact-target replies, rejection, abort, and local/remote races.
