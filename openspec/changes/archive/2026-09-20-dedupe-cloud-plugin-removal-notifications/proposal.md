## Why

Desktop cloud sync persists historical plugin-removal tombstones, while the notification producer remembers only the current renderer's in-memory pending map. Restarting the app, switching workspaces, clearing notifications, or refreshing the same old snapshot can therefore announce the same administrator removal repeatedly.

## What Changes

- Assign each observed desktop cloud resource transition a durable, monotonically increasing occurrence version.
- Reconcile pending changes so repeated observation preserves the same occurrence and a reappearing resource clears the old tombstone.
- Scope fallback reads to the active organization/member rather than flattening historical contexts.
- Persist notification delivery cursors separately from visible notification rows.
- Notify once per workspace, organization/member, plugin, and occurrence version; permit a later observed remove-after-reappearance event to notify again.
- Keep generic notification coalescing behavior unchanged for unrelated events.

## Capabilities

### New Capabilities

- `desktop-cloud-resource-notifications`: Durable cloud-resource transition identity and idempotent desktop notifications across refreshes, workspace switches, and app restarts.

### Modified Capabilities

None.

## Impact

- Embedded Server desktop cloud sync state and migration
- Desktop cloud sync client contracts and projections
- Persistent notification store and Extensions notification producer
- Focused Server/App lifecycle and persistence tests
