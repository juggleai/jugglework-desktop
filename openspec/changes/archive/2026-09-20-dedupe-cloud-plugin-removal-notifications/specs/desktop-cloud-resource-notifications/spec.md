## Purpose

Provide durable identity and idempotent delivery for desktop cloud-resource changes so historical plugin tombstones do not repeatedly notify users while later real lifecycle changes remain visible.

## ADDED Requirements

### Requirement: Cloud resource change occurrences are durable
The embedded desktop Server SHALL assign a monotonically increasing occurrence version to each observed resource difference within a workspace and organization-member context. Repeated observation of the same semantic difference MUST preserve the occurrence version and original queued time across refreshes and Server restarts.

#### Scenario: Removed Plugin remains absent
- **WHEN** a synchronized Plugin is absent from successive cloud resource snapshots
- **THEN** each sync returns one pending removal with the same occurrence version and original queued time

### Requirement: Current pending differences are reconciled
Each cloud sync SHALL persist only differences that remain current. When a previously absent Plugin is observed again in a synchronized state, its pending removal MUST be cleared; a later observed removal MUST receive a greater occurrence version.

#### Scenario: Plugin reappears and is removed again
- **WHEN** a removed Plugin is observed present and synchronized, and a later snapshot omits it again
- **THEN** the original removal is cleared and the later removal has a greater occurrence version

### Requirement: Notification delivery is scoped and idempotent
The Desktop SHALL persist the greatest delivered occurrence version for each workspace, organization, organization member, Marketplace, and Plugin identity. It MUST display a removal notification only when an occurrence version is newer than that cursor. Reading, clearing, pruning, refreshing, switching workspaces, or restarting the app MUST NOT make the same occurrence eligible again.

#### Scenario: Historical removal is refreshed repeatedly
- **WHEN** the Desktop repeatedly receives the same scoped Plugin removal occurrence before and after restart or workspace switching
- **THEN** exactly one removal notification is created for that device

#### Scenario: Legacy removal notification predates source cursors
- **WHEN** persisted notification history already contains the legacy removal notification for a Plugin and the upgraded Desktop receives that still-current removal occurrence
- **THEN** the Desktop records the scoped occurrence as delivered without creating another visible notification

#### Scenario: Later removal is delivered
- **WHEN** the same scoped Plugin is observed present after one removal and a later removal has a greater occurrence version
- **THEN** the Desktop creates a new removal notification

### Requirement: Historical cloud contexts remain isolated
Fallback reads of persisted desktop cloud sync state MUST select only the active organization and organization-member context and MUST NOT project pending changes from other historical contexts.

#### Scenario: Same Plugin identifier exists in another context
- **WHEN** persisted state contains changes for the same Plugin identifier under two organization-member contexts
- **THEN** a refresh for one context considers only that context's pending changes and notification cursor
