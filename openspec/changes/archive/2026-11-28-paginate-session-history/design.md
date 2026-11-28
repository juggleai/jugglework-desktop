## Context

`SessionSurface` currently hydrates one bounded snapshot with the latest 140 raw OpenCode messages and then reconciles SSE updates into the live transcript. The bound is important for large-session switching, but the HTTP wrapper discards OpenCode's legacy `X-Next-Cursor` header and neither the App nor UI can request records before that window. OpenCode SDK 1.19.3 already supports `session.messages({ limit, before })`, returns each page in chronological order and emits an accurate next cursor only when an additional older record exists.

The solution spans the Server proxy, App API types, raw-message reconciliation and scroll behavior. It must preserve the existing snapshot/SSE correctness fences, including live-message precedence, revert deletion fences, compaction presentation and request cancellation.

## Goals / Non-Goals

**Goals:**
- Keep session opening to one snapshot request containing at most the latest 140 raw messages.
- Expose opaque, accurate older-history pagination without migrating message schemas.
- Fetch one bounded older page at a time when the user requests or approaches the transcript top.
- Keep the visible reading anchor stable when records are prepended.
- Preserve loaded history across bounded snapshot refreshes while preventing stale pages from overwriting live state.
- Cancel old-session page reads and make pagination failure local and retryable.

**Non-Goals:**
- Migrating to OpenCode's V2 `SessionMessage` projection API.
- Prefetching entire conversations or persisting message bodies outside existing caches.
- Merging child-session transcripts into their parent.
- Adding message-list virtualization in the first release.
- Changing historical large-tool-output bounding or the initial 140-message limit.

## Decisions

### Reuse the legacy opaque `before` cursor

The Server SHALL call the existing `opencode.session.messages` method with `limit` and optional `before`, preserve the SDK response metadata, and map `X-Next-Cursor` to an explicit `{ olderCursor, hasOlder }` envelope. This path retains the current `{ info, parts }` schema, page ordering and exact `limit + 1` availability check. The cursor remains opaque across all JuggleWork layers.

The alternative V2 API was rejected for this change because it returns a different projected message union, defaults to descending order, generates cursors without proving another page exists and would require a broad read-model migration.

### Include pagination metadata in the bounded snapshot

The snapshot response SHALL include optional message-page metadata derived from the same 140-message read. This avoids repeating the initial window before the first older-page request. Optional response fields preserve compatibility with an older Server; absence disables pagination without breaking the transcript.

### Keep historical pages separate from the live transcript cache

Older raw pages SHALL be cached under a session-scoped history query key. The existing bounded snapshot and SSE-protected transcript remain authoritative for records they contain. Rendering combines older raw pages with the current snapshot/live records by message ID, preferring live/current records over historical copies, then applies the existing message presentation semantics to the complete ordered raw boundary where required.

This separation prevents periodic 140-message snapshot refreshes from deleting explicitly loaded history and avoids expanding the normal snapshot payload.

Because the latest 140-message window can advance while retained history remains cached, the cache SHALL track the snapshot root cursor as a generation. A changed root starts a new active chain from the new snapshot boundary; the previous chain remains detached and is joined only after a fetched page overlaps it by raw message ID. A complete non-overlapping new chain replaces an unreachable detached chain rather than displaying an unproven gap.

### Load one page per deliberate upward gesture at the top

The UI SHALL use 100-message older pages and SHALL NOT require a click in the normal case. Two triggers request one page, both only when `hasOlder`, no page is loading, and the user's input was deliberate:

1. **Threshold entry.** A scroll event that moves from beyond the 240px top threshold into it while scrolling upward, within the 600ms user-intent window. Each entry is consumed once and re-arms only after the position leaves the threshold.
2. **Gesture at the top.** An upward wheel, a touch drag toward the top, or `ArrowUp` / `PageUp` / `Home` while `scrollTop` is already within the threshold. Once at the top the browser emits no further scroll events (and a short transcript cannot scroll at all), so threshold entry alone would never fire again; the gesture itself is the signal.

A 400ms cooldown after a request settles, plus the single in-flight request, prevents inertial scrolling from draining several pages. Programmatic scrolling and downward gestures never load. The explicit accessible “Load earlier messages” control remains for retry after failure and for assistive technology. History is never drained automatically without a further user gesture.

### Restore a DOM message anchor after prepend

Before loading, the controller records the first visible message ID and its viewport offset. A gesture at `scrollTop <= 0` does not move content, so it does not discard the pending anchor; any other user input during the request does. After React commits the prepended page, it restores that element to the same offset. A `scrollHeight` delta is the fallback when the element is unavailable. Short-lived resize compensation may handle delayed media layout but stops on user scrolling.

### Bound concurrency and reject pagination loops

React Query's abort signal SHALL reach the Server request. Only one older cursor may be in flight for a session. Loaded cursors are tracked, repeated/self-referential cursors stop pagination with diagnostics, and cancellation does not surface as a user error. Page failure leaves the current transcript usable and exposes a local retry action.

### Preserve current semantic boundaries

Pagination SHALL retain chronological server order and deduplicate by raw message ID. Current snapshot/live versions win conflicts. Existing compaction, synthetic-message and revert handling remains authoritative; tests SHALL cover boundaries split between the oldest snapshot record and newest history-page record. Parent and child sessions remain independently paginated.

If an authoritative revert cursor is older than the currently continuous loaded window, the transcript SHALL fail closed rather than display messages that may all be after the revert point. Loading or refreshing can restore visibility once the cursor boundary is present or the complete timeline proves it is absent.

## Risks / Trade-offs

- **[Long manual reads can grow DOM and memory]** → Fetch only on demand, use 100-record pages, keep session-scoped cache retention bounded by existing query lifecycle, and defer virtualization until measured usage warrants it.
- **[Prepending dynamic-height content can jump]** → Restore a stable message anchor, use height-delta fallback and test delayed layout changes.
- **[Snapshot and SSE can race with history pages]** → Keep history separate and merge by ID with live/current precedence and existing deletion/revert fences.
- **[A retained history chain can become detached when the latest window advances]** → Key active history by snapshot root cursor and bridge old generations only through a proven message-ID overlap.
- **[A remote revert can point before the loaded window]** → Fail closed until the boundary is loaded or timeline completeness is proven.
- **[Older Server versions omit pagination metadata]** → Treat metadata as optional and keep the existing 140-message transcript fully functional.
- **[Opaque cursor misuse or loops]** → Validate length at the HTTP boundary, never decode it in JuggleWork, track consumed cursors and terminate repeated cursors.
- **[Initial implementation does not virtualize thousands of records]** → Instrument page depth and render cost; add virtualization as a separate change if real usage crosses agreed thresholds.

## Migration Plan

1. Ship backward-compatible Server response fields and `before` support.
2. Ship App client types that tolerate absent page metadata.
3. Add manual retryable older-page loading behind the normal session surface.
4. Add scroll-threshold and top-gesture loading and anchor restoration after data correctness tests pass.
5. Monitor page depth, latency, cancellations and anchor corrections without logging message content or cursor values.

Rollback is application-only: older clients ignore the added fields, and removing the UI pagination path returns behavior to the bounded 140-message snapshot without changing stored conversations.

## Open Questions

- Whether a later release should virtualize transcripts after a measured threshold (for example, more than 1,500 rendered raw messages).
- Whether history-page cache retention should eventually differ from the existing retained-session lifetime based on memory telemetry.
