## 1. Server pagination contract

- [x] 1.1 Extend the OpenCode message wrapper to accept an opaque `before` cursor and preserve `X-Next-Cursor` response metadata.
- [x] 1.2 Return `{ items, page: { olderCursor, hasOlder } }` from the messages API with input bounds and cancellation preserved.
- [x] 1.3 Include optional message-page metadata in the existing 140-message snapshot response without adding another initial request.
- [x] 1.4 Add server unit and end-to-end coverage for first, middle, final, exact-full, invalid-cursor and cancelled page reads.

## 2. App data model and reconciliation

- [x] 2.1 Extend App client and mounted OpenCode adapter types to pass `before` and tolerate optional snapshot pagination metadata.
- [x] 2.2 Add session-scoped older-history page state with one in-flight cursor, abort support and repeated-cursor protection.
- [x] 2.3 Merge historical raw pages with current snapshot/live messages chronologically by ID while preserving live precedence and deletion/revert fences.
- [x] 2.4 Add focused tests for page ordering, overlap deduplication, snapshot refresh preservation, live updates and semantic boundaries across pages.

## 3. Transcript interaction

- [x] 3.1 Add an accessible load-earlier/loading/retry/history-start control at the transcript top.
- [x] 3.2 Trigger at most one older page when the user deliberately scrolls upward into the top threshold.
- [x] 3.2a Also trigger one page when an upward wheel, touch drag or `ArrowUp`/`PageUp`/`Home` happens while already within the top threshold, with a 400ms post-load cooldown and no stacked requests.
- [x] 3.3 Capture and restore the first visible message anchor after prepend, with a scroll-height delta fallback.
- [x] 3.4 Cancel or ignore an older-page request when workspace/session navigation supersedes it and preserve session-scoped retained history.
- [x] 3.5 Add UI and scroll-controller tests for underfilled viewports, duplicate trigger prevention, anchor stability, retry and session switching.
- [x] 3.6 Add scroll-controller tests for top gestures: upward wheel at the top loads once, downward or far-from-top gestures do not, keyboard and touch trigger, exhausted history does not load, and repeated events start one request.

## 4. Verification

- [x] 4.1 Run focused App and Server tests, TypeScript checks and production builds.
- [x] 4.2 Validate the OpenSpec change strictly and run `git diff --check` while preserving unrelated Calendar worktree changes.
- [ ] 4.3 Manually verify a session with more than 340 raw messages opens at 140, loads 100-message pages upward and reaches its beginning without visual jumps.
