# Spec Delta

## Purpose

Defines an accessible week/day planning surface that presents all-day and timed events predictably and lets users reschedule them without changing calendar data through ambiguous gestures.

## ADDED Requirements

### Requirement: Week and day planning views
The Desktop SHALL provide week and day calendar views over the authorized calendar data supplied by `add-cloud-calendar-core`. Each view SHALL expose its visible date range, use the user's selected display timezone, and remain usable without an Agent or AI provider.

#### Scenario: Open a week view
- **WHEN** a user opens the week view for a date
- **THEN** the Desktop displays the containing week with a column for each day and events authorized for that visible range

#### Scenario: Open a day view
- **WHEN** a user opens the day view for a date
- **THEN** the Desktop displays that date's all-day and timed events using the same filters and display timezone as the calendar surface

#### Scenario: Agent is unavailable
- **WHEN** the user navigates, reads, or edits the week or day view while no Agent is available
- **THEN** all non-Agent planning operations remain available

### Requirement: All-day and cross-day presentation
Each week or day view SHALL place all-day events in a distinct all-day region and timed events on the time axis. A cross-day timed event SHALL remain timed and SHALL be represented on every intersected visible date without being converted into separate stored events.

#### Scenario: All-day event spans several days
- **WHEN** an all-day event intersects multiple visible dates
- **THEN** the all-day region shows a continuous span across those dates with exclusive-end date semantics preserved

#### Scenario: Timed event crosses midnight
- **WHEN** a timed event starts on one visible date and ends on another
- **THEN** each intersected day shows the applicable timed segment while every segment opens the same event

#### Scenario: All-day region exceeds its collapsed capacity
- **WHEN** more all-day events intersect a date than the collapsed region can show
- **THEN** the view exposes an operable overflow control that reveals every hidden event without changing the events

### Requirement: Deterministic overlapping-event layout
Timed events that overlap SHALL be laid out in deterministic side-by-side columns. Events that do not overlap in time MUST NOT be forced into the same overlap group, and layout decisions MUST NOT mutate event times or duration.

#### Scenario: Two events overlap
- **WHEN** two timed events overlap on the same visible day
- **THEN** both remain readable in separate horizontal lanes over their actual time intervals

#### Scenario: Event starts when another ends
- **WHEN** one event's start instant equals another event's end instant
- **THEN** the events are treated as non-overlapping

#### Scenario: Overlap data is rendered again
- **WHEN** the same events, timezone, and visible range are rendered repeatedly
- **THEN** lane assignment and ordering remain stable

### Requirement: Current-time indicator
The week and day views SHALL show an accessible current-time indicator only when the current instant falls on a displayed local date. While the view is mounted, the indicator SHALL advance without requiring a data refresh.

#### Scenario: Today is visible
- **WHEN** the current instant belongs to a date visible in the selected display timezone
- **THEN** that date's time axis shows the current-time indicator at the corresponding local time and exposes a non-color-only accessible label

#### Scenario: Historical range is visible
- **WHEN** the current instant does not belong to any displayed local date
- **THEN** no current-time indicator is shown

#### Scenario: Local date rolls over
- **WHEN** the current instant crosses midnight in the selected display timezone while the view remains open
- **THEN** the indicator moves to the newly current date if it is visible or disappears if it is not

### Requirement: Drag rescheduling and duration adjustment
The Desktop SHALL let an authorized user drag a timed event to change its start while preserving duration and drag its start or end edge to change duration. It SHALL let the user move an all-day event by whole dates while preserving its all-day span. A drag SHALL show a preview and SHALL persist only after a valid drop.

#### Scenario: Move a timed event
- **WHEN** an authorized user drops a timed event on a valid time-axis position
- **THEN** the Desktop requests one versioned, idempotent update with the previewed start and an unchanged duration

#### Scenario: Resize a timed event
- **WHEN** an authorized user drops a resize edge at a valid time that leaves the event with positive duration
- **THEN** the Desktop requests one versioned, idempotent update for that boundary while preserving the other boundary

#### Scenario: Move an all-day event
- **WHEN** an authorized user drops an all-day event on another date
- **THEN** the Desktop requests one versioned, idempotent update that shifts both exclusive-end dates by the same whole-date offset

#### Scenario: Cancel or reject a drag
- **WHEN** a drag is canceled, dropped outside a valid target, or would create a non-positive duration
- **THEN** the preview is discarded and no calendar mutation is requested

### Requirement: Safe interactive mutation
Interactive planning mutations SHALL reuse calendar authorization, expected-version conflict detection, and idempotency semantics from `add-cloud-calendar-core`. The Desktop MUST NOT silently overwrite a newer event or present an unconfirmed optimistic preview as saved.

#### Scenario: Event changed during drag
- **WHEN** a drop submits an expected version older than the server's event version
- **THEN** the update is rejected as a conflict, the authoritative event is reloaded, and the user's intended change remains available for review or retry

#### Scenario: Drop response is retried
- **WHEN** the same interactive mutation is retried with the same idempotency key
- **THEN** at most one calendar change is applied and the original result is returned

#### Scenario: User lacks edit permission
- **WHEN** a user can view but cannot edit an event
- **THEN** move and resize affordances are unavailable and no mutation can be initiated through the planning view

### Requirement: Keyboard-equivalent planning
Every drag move and resize operation SHALL have a discoverable keyboard alternative. Keyboard editing SHALL expose the proposed dates or times, support cancel before commit, apply the same validation and write contract as dragging, and return focus to the event after completion.

#### Scenario: Move an event without dragging
- **WHEN** a keyboard user invokes the move action, selects a valid destination, and confirms
- **THEN** the same versioned and idempotent mutation used by drag rescheduling is requested

#### Scenario: Resize an event without dragging
- **WHEN** a keyboard user invokes duration adjustment, chooses a valid boundary, and confirms
- **THEN** the same duration validation and versioned mutation used by drag resizing is requested

#### Scenario: Cancel keyboard planning
- **WHEN** a keyboard user cancels before confirming a move or resize
- **THEN** no mutation is requested and focus returns to the unchanged event
