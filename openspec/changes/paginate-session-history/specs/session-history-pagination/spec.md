## ADDED Requirements

### Requirement: Session opening remains bounded
The application SHALL open a session with one bounded snapshot containing no more than the latest 140 raw messages and SHALL NOT prefetch older history before the user requests or approaches it.

#### Scenario: User opens a long session
- **WHEN** a session contains more than 140 raw messages
- **THEN** the initial snapshot returns only the latest 140 messages
- **AND** the session becomes interactive without waiting for older pages

### Requirement: Earlier messages are cursor-paginated
The system SHALL expose an opaque older-history cursor and an accurate older-history availability flag, and SHALL retrieve earlier records in bounded chronological pages without changing the existing raw message schema.

#### Scenario: More history exists
- **WHEN** the current oldest loaded message has earlier stored records
- **THEN** the response includes an opaque cursor and reports that older history exists

#### Scenario: User loads the final page
- **WHEN** a history request reaches the beginning of the session
- **THEN** the returned page is merged chronologically
- **AND** the system reports that no older history remains

### Requirement: Older history loads only on user demand
The session surface SHALL load at most one older page when the user scrolls upward near the transcript top or activates an explicit accessible load control. It SHALL NOT continuously drain history merely because the viewport remains underfilled or the top sentinel remains visible.

#### Scenario: User approaches the transcript top
- **WHEN** older history exists, no page is loading and the user scrolls upward into the top threshold
- **THEN** the surface requests exactly one older page

#### Scenario: Initial messages do not fill the viewport
- **WHEN** older history exists but the initial transcript is not scrollable
- **THEN** the surface exposes an explicit load-earlier control
- **AND** it does not automatically load every remaining page

### Requirement: Prepending preserves the reading position
The session surface SHALL preserve the first visible message and its viewport offset while an older page is prepended, with a height-delta fallback when the original anchor cannot be restored.

#### Scenario: Older messages are inserted above the viewport
- **WHEN** an older page finishes loading while the user is reading the previous oldest region
- **THEN** the same message remains at the same visual offset after layout settles

### Requirement: Historical and live messages reconcile safely
The system SHALL merge historical pages, the bounded snapshot and live events by raw message ID in chronological order. Current snapshot or live versions SHALL take precedence over historical copies, and a bounded snapshot refresh SHALL NOT discard explicitly loaded older pages.

#### Scenario: Snapshot refresh follows an older-page load
- **WHEN** the application refreshes the latest 140-message snapshot after older pages were loaded
- **THEN** the older pages remain available
- **AND** updated current or live records replace stale historical duplicates

#### Scenario: A semantic boundary crosses pages
- **WHEN** compaction, synthetic continuation or revert-related records straddle the snapshot/history boundary
- **THEN** the existing transcript presentation and deletion fences apply to the merged chronological input

### Requirement: Pagination failure is local and cancellable
Older-history requests SHALL be abortable when session navigation supersedes them. A failed page SHALL leave the current transcript usable and expose a retry action, while cancellation SHALL NOT surface as an error.

#### Scenario: User switches sessions during a history request
- **WHEN** an older-page request is still pending and the user opens another session
- **THEN** the obsolete request is aborted
- **AND** it cannot modify or block the newly selected session

#### Scenario: Loading an older page fails
- **WHEN** a non-cancellation error occurs while loading history
- **THEN** the already loaded transcript remains visible
- **AND** the user can retry the same page

### Requirement: Cursor loops are bounded
The client SHALL track consumed older-history cursors and SHALL stop pagination when an upstream response repeats the requested cursor or another already consumed cursor.

#### Scenario: Upstream repeats a cursor
- **WHEN** a page response returns a cursor already used by the session history loader
- **THEN** no automatic follow-up request is made
- **AND** the loop is recorded without logging message content or cursor values
