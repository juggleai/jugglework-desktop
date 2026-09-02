## 1. Snapshot Mapping

- [x] 1.1 Omit compaction-boundary-only messages after transferring their mode to the following summary
- [x] 1.2 Preserve messages that contain a compaction boundary plus other visible UI parts

## 2. Task Grouping Verification

- [x] 2.1 Add an end-to-end snapshot presentation test covering output before and after automatic compaction
- [x] 2.2 Confirm manual compaction remains a standalone task output

## 3. Validation

- [x] 3.1 Run focused compaction and task-presentation tests
- [x] 3.2 Run app type checking and strict OpenSpec validation
