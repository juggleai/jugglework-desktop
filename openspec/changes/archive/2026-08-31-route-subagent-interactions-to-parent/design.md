## Context

OpenCode emits permission and question events with the originating `sessionID`; subagent events therefore identify a hidden child session. Parentage is stored separately on Session records. The renderer currently stores interactions under exact per-session query keys and only observes the selected session, while the server reads and resolves interactions for one exact session. Exact-session replies are correct and security-sensitive, but presentation ownership and reply ownership are currently conflated.

The fix crosses renderer synchronization, server read models, Task presentation, and remote-control projection. It must support legacy and v2 OpenCode interaction APIs, live events plus snapshots, nested descendants, and reply races.

## Goals / Non-Goals

**Goals:**
- Separate presentation ownership (`rootSessionId`) from reply ownership (`targetSessionId`).
- Maintain one canonical workspace interaction record and select it by visible root.
- Reconstruct descendant interactions after missed events or restarts.
- Preserve exact child targeting and existing atomic resolution behavior.
- Surface blocked Task state without exposing child sessions in navigation.
- Apply the same ownership model to local and remote consumers.

**Non-Goals:**
- Resuming model generation after an engine or process restart.
- Automatically granting external-directory permissions.
- Making child sessions top-level navigable sessions.
- Replacing OpenCode permission policy or authorization semantics.

## Decisions

### Use a canonical interaction identity with separate owner fields

Each normalized interaction is keyed by workspace, kind, target session, and request ID and carries `targetSessionId`, `parentSessionId`, and `rootSessionId`. UI selectors group by root; reply dispatch always uses target.

This avoids copying one interaction into parent and child caches, which would create duplicate dialogs and difficult cleanup races. Overwriting the event `sessionID` was rejected because it would break v2 reply routing and server validation.

### Resolve ancestry from authoritative session records

The server will build a workspace session graph from the OpenCode session list and walk `parentID` links with cycle protection. The renderer may cache live ancestry for immediate event presentation, but authoritative reconciliation is responsible for recovery and correction.

Deriving ownership only from Task tool metadata was rejected because interactions can originate from nested sessions or non-Task child execution and because metadata may arrive after the permission event.

### Add a descendant-aware interaction snapshot API

The server will expose pending interactions for a visible root with descendant inclusion. It will enumerate the root subtree, merge legacy global lists and v2 exact-session lists, normalize protocols, and return presentation plus target identifiers. The endpoint is read-only; existing exact-session reply endpoints remain authoritative.

Renderer-only aggregation was rejected because a renderer that starts after the child event cannot reliably discover all pending v2 requests without reconstructing and enumerating the tree itself. Centralizing this logic also supports remote control.

### Reconcile snapshots using request revision timestamps

The canonical store retains `receivedAt`. Snapshot reads capture a start timestamp: interactions received after that point survive an older snapshot, while older absent records are removed. Reply/answer events create terminal tombstones long enough to prevent an in-flight snapshot from resurrecting resolved interactions.

### Route live child events immediately, then verify asynchronously

When live ancestry is known, a child interaction is immediately assigned to its visible root. If ancestry is unknown, it remains in a workspace orphan set rather than being dropped. Session create/update events or the next snapshot resolve and re-home it.

### Represent waiting as interaction-derived Task state

The renderer correlates a descendant target session to the parent Task call using existing Task metadata. A pending descendant interaction decorates the in-progress Task as waiting for approval; OpenCode remains authoritative for eventual completed/error state. The UI does not fabricate completion on rejection.

### Reuse the server resolution coordinator for replies

The parent presentation passes the target session and request ID to the existing semantic reply endpoint. Existing resolution reservations provide exactly-once behavior for local/remote races. Server validation continues to reject a parent session ID used in place of the target child.

### Project root ownership to remote control

Remote interaction events and snapshots include root and target identifiers. A controller bound to the root receives descendant interactions; mutation adapters resolve using target. Exact root binding remains required so unrelated workspace interactions are not leaked.

## Risks / Trade-offs

- [Enumerating v2 interactions across many descendants can increase requests] → Bound concurrency, only reconcile visible/active roots, and reuse the session graph and legacy global result per snapshot.
- [Session events and interaction events can arrive out of order] → Keep orphan interactions and re-home them when ancestry becomes known; authoritative snapshots correct live routing.
- [Cycles or missing parents in malformed session data] → Use cycle detection and retain the target as an orphan instead of assigning it to an unrelated root.
- [A stale snapshot can resurrect an already resolved request] → Maintain resolution tombstones and snapshot-start revisions.
- [One child could be referenced by multiple visible panes] → Canonical storage plus root selectors prevents duplicate records and server resolution remains exactly once.
- [Remote payload compatibility] → Add ownership fields without removing existing session/request fields and preserve exact-target behavior for older consumers.

## Migration Plan

1. Add descendant-aware server read models and tests without changing reply routes.
2. Add the canonical renderer interaction store and adapt current-session selectors.
3. Switch live events and snapshot hydration to canonical records.
4. Add Task waiting presentation and remote projection support.
5. Retain existing per-session APIs during migration; remove obsolete cache paths only after all consumers move.

Rollback can restore exact-session presentation without schema or data migration because pending interaction state remains owned by OpenCode and no durable format is changed.
