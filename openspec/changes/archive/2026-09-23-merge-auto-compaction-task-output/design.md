## Context

See `proposal.md` for motivation. OpenCode persists automatic compaction as a `user` message containing only a `CompactionPart`, followed by an assistant summary message with `summary: true`. The snapshot adapter already transfers the boundary's `auto` flag to the summary receipt and hides the raw part, but it still emits the now-empty user message. Assistant grouping correctly treats user messages as task boundaries, so that empty implementation-only record splits one continuous run.

Live event handling does not create the raw compaction boundary message because unsupported compaction parts are discarded before a message stub is inserted. However, OpenCode separately injects a synthetic user text part with `metadata.compaction_continue: true` after automatic compaction. The text part is hidden, but `message.updated` can leave its empty user-message shell in the canonical transcript. Presentation-level skipping is a useful compatibility fallback, but canonical live state should remove this implementation message regardless of whether `message.updated` or `message.part.updated` arrives first.

## Goals / Non-Goals

**Goals:**

- Preserve the automatic/manual mode association between a boundary and its summary.
- Remove only messages that contained compaction boundaries and have no remaining visible UI parts.
- Remove synthetic automatic-continuation messages from live transcript state under either event ordering.
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

### Suppress live automatic-continuation messages at synchronization

The session synchronizer recognizes only text parts that are both `synthetic: true` and explicitly marked with `metadata.compaction_continue: true`. When that part arrives, it removes any previously inserted message shell and tombstones the message id so a later `message.updated`, a late part event, or a buffered delta cannot recreate it. Tombstones are session-scoped (message ids are only unique within one session), bounded per session, cleared when the session is deleted, and consulted by snapshot seeding so a stale snapshot captured between message creation and marker persistence cannot resurrect the bare shell during reconciliation. Buffered deltas (`pendingDeltas` and the rAF flush buffer) for the message are dropped at suppression time, the delta flush path independently ignores tombstoned ids, and the activity store's recorded role for the shell is removed. A message that also carries visible mapped parts is kept and left untombstoned — mirroring the snapshot adapter's rule — so real user content sharing the message survives and its lifecycle events continue to flow.

Alternative considered: continue relying only on grouping to skip every empty user message. Rejected as the primary fix because it leaves a known engine implementation record in canonical transcript state and does not distinguish automatic continuation from other empty user records.

### Preserve the live compaction mode across boundary-less snapshots

A snapshot window that excludes the compaction boundary (for example the 140-message read limit splitting boundary from summary) maps the summary receipt to mode `unknown`, and live/snapshot part orderings differ (the live marker is created before the summary streams; the snapshot marker is appended last), so index-paired part merging cannot carry the live mode across. Message-level reconciliation therefore upgrades a merged `unknown` marker to the cached live mode whenever the live stream already observed `auto` or `manual`. Without this, every non-auto mode groups as a standalone compaction task and re-splits the run after reconciliation.

Alternative considered: trust the snapshot mode because snapshots are authoritative for persisted state. Rejected because the boundary's mode transfer is a rendering-layer reconstruction that a truncated window cannot perform; the live events observed the actual engine reason.

## Risks / Trade-offs

- [A compaction-boundary message later gains another visible part] → Drop it only when the mapped parts array is empty; otherwise preserve the message and its visible content.
- [A summary message is missing after the boundary] → The boundary record remains hidden, matching the existing rule that raw compaction parts are not receipts.
- [Snapshot ordering changes upstream] → Keep live event mode authoritative when present and cover the persisted ordering used by the installed runtime.
- [Live message and part events arrive in either order] → Remember suppressed continuation message IDs for the lifetime of the workspace sync and test both orders.
- [A stale snapshot races the continuation marker's persistence] → Session-scoped tombstones participate in snapshot seeding, so the bare shell cannot re-enter canonical state.
- [Message ids collide across sessions] → Tombstones key on session plus message id, so a real turn in another session is never suppressed by an unrelated continuation.
- [Tombstones accumulate across a long-lived sync] → Per-session tombstone sets are bounded and cleared on session deletion; entries disappear with the workspace sync itself.
- [A delayed message.removed is followed by a replayed message.updated] → Removal keeps the tombstone; only session deletion clears it, so the empty shell cannot return.

## Migration Plan

This is a renderer-only compatibility fix with no data migration. Existing sessions are corrected the next time their snapshot is mapped. Rollback restores the previous split presentation without altering stored messages.
