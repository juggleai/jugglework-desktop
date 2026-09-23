## Why

Automatic context compaction can split one continuous model run into three visible task outputs: work before compaction, a standalone compaction receipt, and work after compaction. This breaks the existing task-continuity contract and makes one run look like multiple tasks.

## What Changes

- Preserve automatic-compaction mode when live transcript state is reconciled with session snapshots.
- Associate persisted compaction-boundary metadata with the corresponding summary receipt without rendering the raw boundary part.
- Keep pre-compaction output, the automatic-compaction marker, and post-compaction output in one assistant task group.
- Retain the existing standalone presentation for user-triggered manual `/compact` commands.
- Add live and snapshot regression coverage for automatic compaction grouping.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-task-progress`: Strengthen context-compaction continuity so automatic compaction never creates a standalone task boundary, including after snapshot reconciliation.

## Impact

- Session snapshot-to-UI mapping and transcript reconciliation under `apps/app/src/react-app/domains/session`.
- Assistant message grouping under `apps/app/src/components/chat`.
- Compaction and task-presentation tests.
- No external API, persistence schema, or model-context changes.
