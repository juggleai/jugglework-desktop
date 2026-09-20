## Context

The embedded Server persists desktop cloud differences per workspace and organization-member context, but reconstructs every difference with a new timestamp and carries stale pending rows forward. The renderer then drops occurrence metadata, compares only an in-memory pending map, and relies on visible notification coalescing that resets after read, clear, prune, workspace switch, or restart.

## Goals / Non-Goals

**Goals:**
- Give observed differences a stable occurrence identity across repeated polls and restarts.
- Reconcile stale pending changes away when resources return to sync.
- Deliver each scoped removal occurrence once per device while permitting a later removal.
- Keep historical organization/member contexts isolated.

**Non-Goals:**
- Adding cloud administrator audit logs.
- Detecting a reappearance/removal cycle that occurs entirely between two snapshots.
- Changing generic notification coalescing semantics for unrelated notifications.
- Adding a new network acknowledgement endpoint.

## Decisions

### Version occurrences in persisted workspace sync state

Each context entry owns `nextChangeVersion`. Reconciliation compares a semantic fingerprint containing resource identity, change kind, and previous/next update timestamps. An unchanged fingerprint preserves its version and queued time; a new fingerprint consumes the next version; absent differences are removed.

Version-1 state is migrated deterministically by assigning positive versions to its persisted pending order and advancing `nextChangeVersion` above them.

### Persist source delivery cursors separately from visible notifications

The notification store adds a bounded `sourceVersions` map. Source-aware `add` operations atomically reject equal or older versions and advance the cursor with the visible notification. Marking read or clearing visible notifications does not clear source cursors.

During migration, a persisted legacy `plugin-removed:<pluginId>` notification counts as delivery evidence for the first scoped occurrence seen after upgrade. The store seeds the new source cursor without creating another visible notification.

### Scope source identity completely

The source key includes workspace, organization, organization member, resource kind, Marketplace, and Plugin. The visible dedupe key also includes occurrence version so a legitimate later removal does not merge into an unread older occurrence.

### Use active context on fallback reads

Renderer fallback parsing selects the entry matching the current Den organization and member from the latest successful snapshot instead of flattening all entries.

## Risks / Trade-offs

- [Notification cursors grow over time] → Retain only a bounded number of most recently delivered source keys.
- [Legacy state lacks occurrence versions] → Migrate deterministically and preserve the result on the next successful sync.
- [Snapshot polling cannot see unobserved intermediate states] → Document this limitation; a future Den event cursor would be required for stronger guarantees.
