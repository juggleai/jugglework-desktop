## Context

See `proposal.md` for motivation. OpenCode persists automatic compaction as a `user` message containing only a `CompactionPart`, followed by an assistant summary message with `summary: true`. The snapshot adapter already transfers the boundary's `auto` flag to the summary receipt and hides the raw part, but it still emits the now-empty user message. Assistant grouping correctly treats user messages as task boundaries, so that empty implementation-only record splits one continuous run.

Live event handling does not create this empty boundary message because unsupported raw compaction parts are discarded before a message stub is inserted. The defect is therefore concentrated in snapshot mapping and becomes visible after snapshot reconciliation or reopening the session.

## Goals / Non-Goals

**Goals:**

- Preserve the automatic/manual mode association between a boundary and its summary.
- Remove only messages that contained compaction boundaries and have no remaining visible UI parts.
- Keep automatic compaction before, during, and after output in one assistant task group.
- Preserve the standalone manual `/compact` presentation.

**Non-Goals:**

- Remove real user prompts, including prompts with other visible parts.
- Change OpenCode persistence or event ordering.
- Render the internal generated summary text.

## Decisions

### Drop boundary-only messages in the snapshot adapter

After recording the latest boundary mode, the adapter omits a message when it contained a `CompactionPart` and mapping leaves it with no visible parts. This prevents the invisible engine record from reaching generic role-based grouping while leaving normal empty-message behavior unchanged.

Alternative considered: teach `groupMessages` to skip every empty user message. Rejected because empty messages can have other runtime meanings and grouping should not need to understand an OpenCode persistence detail.

### Keep mode transfer before filtering

Boundary detection and pending-mode assignment occur before the message is dropped. The following summary message therefore still receives `mode: auto` and remains an inline process marker. Manual boundaries likewise retain `manual`, so a genuine `/compact` summary remains standalone.

Alternative considered: infer automatic mode from whether a task is currently streaming. Rejected because it is ambiguous after reload and would misclassify manual commands.

### Verify the full presentation pipeline

The regression test constructs the observed snapshot order—assistant output, automatic boundary-only user message, summary message, and continued assistant output—then runs snapshot mapping, rendered-message derivation, and task grouping. The assertion checks both removal of the empty boundary and a single assistant task group.

## Risks / Trade-offs

- [A compaction-boundary message later gains another visible part] → Drop it only when the mapped parts array is empty; otherwise preserve the message and its visible content.
- [A summary message is missing after the boundary] → The boundary record remains hidden, matching the existing rule that raw compaction parts are not receipts.
- [Snapshot ordering changes upstream] → Keep live event mode authoritative when present and cover the persisted ordering used by the installed runtime.

## Migration Plan

This is a renderer-only compatibility fix with no data migration. Existing sessions are corrected the next time their snapshot is mapped. Rollback restores the previous split presentation without altering stored messages.
