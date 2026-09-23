## 1. Snapshot Mapping

- [x] 1.1 Omit compaction-boundary-only messages after transferring their mode to the following summary
- [x] 1.2 Preserve messages that contain a compaction boundary plus other visible UI parts
- [x] 1.3 Remove live synthetic compaction-continuation messages from canonical transcript state under either event ordering

## 2. Task Grouping Verification

- [x] 2.1 Add an end-to-end snapshot presentation test covering output before and after automatic compaction
- [x] 2.2 Confirm manual compaction remains a standalone task output
- [x] 2.3 Add live synchronization regression coverage for both continuation event orders and real user prompts

## 3. Validation

- [x] 3.1 Run focused compaction and task-presentation tests
- [x] 3.2 Run app type checking and strict OpenSpec validation
- [x] 3.3 Run focused live/snapshot compaction tests, app type checking, and strict OpenSpec validation

## 4. Race and Lifecycle Hardening

- [x] 4.1 Scope continuation tombstones per session so identical message ids in other sessions are never suppressed
- [x] 4.2 Fence snapshot seeding with tombstones so a stale snapshot cannot resurrect a suppressed continuation shell
- [x] 4.3 Keep message.removed from clearing tombstones and clear them on session deletion, bounding growth per session
- [x] 4.4 Drop buffered and in-flight deltas for suppressed continuation messages and remove their activity-store role
- [x] 4.5 Preserve messages that mix visible content with the continuation marker instead of deleting them
- [x] 4.6 Preserve the live-observed compaction mode when a boundary-less snapshot would downgrade it to unknown
- [x] 4.7 Add live end-to-end grouping coverage across compaction lifecycle, continuation suppression, and a stale snapshot reconciliation
