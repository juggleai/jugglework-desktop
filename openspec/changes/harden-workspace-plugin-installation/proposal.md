## Why

Workspace plugin installation currently reports success before the workspace has a complete, owned, and recoverable copy of every local component. Switching workspaces during installation, partial write failures, stale files after upgrades, MCP name collisions, and Cloud-only component accounting can make “Install in workspace” or “Sync to workspace” disagree with the actual workspace state.

## What Changes

- Bind each install, sync, and removal operation to the workspace target captured when the user starts it; late responses cannot write into or overwrite another workspace's UI state.
- Make local plugin delivery transactional across files, runtime MCP configuration, and the installation record, with rollback on failure.
- Reconcile upgrades exactly: remove files and MCPs that the new plugin graph no longer owns, preserve valid member MCP state, and make repeated installation idempotent.
- Protect user and cross-plugin MCP configuration with explicit ownership and conflict detection; removal only deletes resources still owned by that plugin.
- Record Cloud-hosted components and component outcomes without writing their payloads locally, so Cloud-only and mixed plugins can reach a stable installed state.
- Surface ready, update available, needs sign-in, needs administrator setup, partial failure, and unsupported workspace states accurately.
- Gate install actions when the selected runtime cannot safely install workspace plugins, and refresh all affected workspace capabilities after success.
- Project live Marketplace detail into one canonical lifecycle with deterministic actions, scoped last-known-good caching, structured refresh failures, and true no-op synchronization.

## Capabilities

### New Capabilities
- `workspace-plugin-installation`: Defines workspace binding, transactional delivery, ownership, reconciliation, status accounting, capability gating, and post-install refresh for Marketplace plugins.

### Modified Capabilities

None.

## Impact

- Desktop application Marketplace UI and extension store.
- Embedded JuggleWork Server cloud-plugin install/list/remove routes and runtime SQLite schema.
- Workspace `.opencode` files, runtime MCP configuration, and managed engine synchronization.
- Cloud plugin installation records and component status contracts.
- Tests for multi-workspace isolation, rollback, idempotency, mixed plugins, ownership conflicts, and UI state.
