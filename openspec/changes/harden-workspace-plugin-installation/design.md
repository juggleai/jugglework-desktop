## Context

See `proposal.md` for motivation and `specs/workspace-plugin-installation/spec.md` for behavior. Marketplace resolution happens in the app, while local files, runtime MCP configuration, engine synchronization, and installation records are managed by the embedded JuggleWork Server. These stores do not share a transaction, and the app currently resolves the workspace target late through mutable route state.

## Goals / Non-Goals

**Goals:**

- Bind every plugin mutation and refresh to an immutable workspace operation context.
- Provide compensating transactions across workspace files, runtime MCP config, engine state, and SQLite records.
- Reconcile exact ownership during upgrade and removal.
- Represent Cloud-only and partial component outcomes without local payload duplication.
- Make UI status and completion reflect actual component readiness.

**Non-Goals:**

- Copying Cloud-hosted MCP configuration or credentials into workspace files.
- Automatically resolving ownership conflicts by overwriting user configuration.
- Installing plugins directly into unsupported external OpenCode runtimes.
- Solving arbitrary concurrent edits to all `.opencode` files; scope is plugin-owned paths and MCP entries.

## Decisions

### Capture a workspace operation context in the app

The app captures workspace ID, root, workspace type, selected server client, capability flags, and a monotonically unique operation key before resolving the plugin. Store methods accept this context instead of reading `routeStateRef.current` after asynchronous work. Refreshes compare the operation context to the current view before updating visible state.

Alternative rejected: disable workspace navigation during installation. It avoids one race but creates a poor desktop experience and does not protect background refreshes.

### Build a deterministic delivery plan before mutation

The server resolves memberships into a plan containing local file writes, local file removals, MCP upserts/removals, Cloud-only outcomes, conflicts, and warnings. Validation, graph-internal duplicate destination detection, and ownership checks happen before mutation. Two components that normalize to the same file path or MCP name are both failed rather than choosing a sequential winner, and an update retains the previously installed graph. The plan is stable for a plugin graph and workspace.

Alternative rejected: continue mutating while iterating memberships. It cannot report all conflicts up front and makes rollback incomplete.

### Use snapshots and compensating rollback

Before applying a plan, the server snapshots every affected file, runtime MCP entry, and existing installation record. It applies file changes through staged temporary files/atomic renames, applies runtime MCP changes, writes the new installation record, then synchronizes the engine. Any failure restores only the affected file and runtime MCP names plus the previous record, so unrelated runtime changes made concurrently survive compensation; a rollback failure is persisted as a repair-required state.

Alternative rejected: one SQLite transaction. Files and the OpenCode engine cannot participate in the SQLite transaction.

### Persist component outcomes and ownership

The installation record evolves from a list of local files to a component ledger. Each entry records config object ID, component type, delivery outcome, local path or MCP name when applicable, digest/ownership fingerprint, and actionable error metadata. Cloud components are ledger entries without local payloads; resolved Cloud readiness and component connection bindings map to available, needs-sign-in, or needs-administrator-setup outcomes. MCP ownership includes plugin ID and config object ID; pre-existing unowned entries cause a conflict.

Alternative rejected: infer installation completeness by comparing local file count to Marketplace member count. Cloud components intentionally do not create local files.

### Reconcile by ownership, not by type-specific exceptions

Upgrade computes `previous owned ledger - next owned ledger` and removes all obsolete owned files/MCPs after staging the next graph. Removal validates ownership fingerprints before deletion. User-modified resources are preserved and reported as conflicts rather than silently deleted.

Alternative rejected: only clean removed MCP names. It leaves removed Skills, Commands, Agents, and other resources active indefinitely.

### Return structured operation results

Install/sync/remove returns overall status (`installed`, `partial`, `failed`, `repair_required`), component outcomes, warnings, and refresh hints. The app uses these values for Toast severity and detail status instead of assuming any HTTP 2xx means complete success.

## Risks / Trade-offs

- [Rollback across files and engine sync can itself fail] → Persist repair-required state with snapshots and expose retry/remove repair actions.
- [Existing install records lack component ownership] → Migrate them into legacy-owned entries; destructive cleanup requires path/MCP match and otherwise preserves resources with a warning.
- [User edits plugin-owned files] → Compare digest/ownership before overwrite or removal; synchronization reports a conflict unless the user explicitly retries with overwrite in a future change.
- [More install metadata increases runtime DB size] → Store metadata and digests only, not Cloud payloads or file snapshots after successful commit.
- [Engine synchronization may be slow] → Keep operation scoped and visible; only report completion after affected capability stores refresh.

## Migration Plan

1. Add versioned component-ledger fields while continuing to read legacy installation records.
2. Backfill legacy local files/MCPs as owned only when their current path/name matches the recorded resource.
3. Deploy deterministic planning, conflict detection, and rollback behind the same API contract with additive result fields.
4. Update the app to capture operation contexts, consume structured outcomes, gate unsupported workspaces, and refresh all capabilities.
5. After validation, stop using file-count/member-count heuristics.
6. Rollback keeps the additive ledger columns inert; legacy readers continue using existing plugin/file fields.
