## Why

The session surface intentionally opens with only the latest 140 raw messages to keep large-session navigation responsive, but users currently cannot retrieve anything older from the UI. Long conversations therefore appear incomplete after reload even though their earlier messages remain in OpenCode storage.

## What Changes

- Preserve the existing single-request, 140-message initial snapshot window.
- Expose OpenCode's opaque `before` cursor and accurate older-history availability through the JuggleWork session read API.
- Load older messages in bounded pages only when the user scrolls toward the transcript top or explicitly requests them.
- Merge paged raw history with the bounded snapshot and live transcript without allowing snapshot refreshes to discard loaded history or stale pages to overwrite live updates.
- Preserve the user's visual reading anchor while older messages are prepended, and provide accessible loading, retry and history-start states.
- Cancel superseded history reads and guard against duplicate or looping cursors.

## Capabilities

### New Capabilities
- `session-history-pagination`: Bounded initial session hydration with cursor-based, user-driven retrieval of earlier messages and stable transcript scrolling.

### Modified Capabilities
- `session-view-reuse`: Session navigation cancellation also applies to in-flight older-history page reads, and retained sessions preserve independently loaded history without changing the bounded initial snapshot contract.

## Impact

- JuggleWork Server session messages and snapshot HTTP contracts gain optional pagination metadata and a `before` query parameter.
- The App server client, mounted OpenCode adapter, session surface, transcript reconciliation and scroll controller gain paged-history support.
- Existing OpenCode SDK 1.19.3 legacy message pagination is reused; no dependency upgrade or V2 message-model migration is required.
- Session-opening latency and initial response size remain bounded at 140 raw messages.
