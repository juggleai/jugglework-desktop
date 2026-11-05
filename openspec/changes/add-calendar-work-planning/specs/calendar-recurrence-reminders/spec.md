# Spec Delta

## Purpose

Defines predictable basic recurring calendar series and a durable reminder lifecycle whose user-visible state remains truthful across edits, retries, multiple clients, and Desktop runtime availability.

## ADDED Requirements

### Requirement: Basic recurrence rules
The calendar SHALL support daily, weekly, and monthly recurring event series in an explicit IANA timezone. Daily rules SHALL use a positive day interval, weekly rules SHALL use a positive week interval and one or more unique ISO weekdays, and monthly rules SHALL use a positive month interval and one or more unique month days. A rule MAY end at an inclusive local date or after a positive occurrence count.

#### Scenario: Create a daily series
- **WHEN** an authorized user creates a daily event series with an interval and optional end condition
- **THEN** the system stores one series rule and expands occurrences at the event's local wall-clock time in the series timezone

#### Scenario: Create a weekly series
- **WHEN** an authorized user creates a weekly series for selected weekdays
- **THEN** the system expands one occurrence on each selected weekday in eligible weeks until the end condition is reached

#### Scenario: Monthly date is absent
- **WHEN** a monthly series targets a day that does not exist in an eligible month
- **THEN** that month has no occurrence for that day and the date is not clamped into another day or month

#### Scenario: Unsupported recurrence is submitted
- **WHEN** a write requests yearly recurrence, arbitrary RRULE parts, or another unsupported frequency
- **THEN** the system rejects the recurrence without partially creating or changing a series

### Requirement: Series instances have stable identity
Each expanded occurrence SHALL expose the series ID, an immutable original occurrence key, its effective start and end, and whether it is generated, modified, or canceled. The same series revision and requested range SHALL produce the same occurrence identities across clients and retries.

#### Scenario: Query the same range twice
- **WHEN** a client queries the same series revision and time range twice
- **THEN** each occurrence has the same original occurrence key and series relationship in both results

#### Scenario: Modified instance moves outside the range
- **WHEN** an exception moves an occurrence from inside a requested range to outside it
- **THEN** that occurrence is absent from the range result and is not also returned at its generated time

#### Scenario: Modified instance moves into the range
- **WHEN** an exception moves an occurrence whose original time was outside a requested range into it
- **THEN** the effective occurrence is included once in the range result

### Requirement: Single-instance exceptions
An authorized user SHALL be able to modify or cancel only one occurrence without changing the series rule. A single-instance exception SHALL target the immutable original occurrence key and SHALL retain identity if its effective time is changed.

#### Scenario: Modify only this occurrence
- **WHEN** a user changes an occurrence with scope `this occurrence`
- **THEN** the system stores an exception for its original occurrence key and leaves other generated occurrences unchanged

#### Scenario: Delete only this occurrence
- **WHEN** a user deletes an occurrence with scope `this occurrence`
- **THEN** the system records a canceled exception and excludes that occurrence from ordinary range results while preserving the rest of the series

#### Scenario: Modify the exception again
- **WHEN** a user edits an already modified occurrence with scope `this occurrence`
- **THEN** the existing exception is versioned in place rather than creating a second effective occurrence

### Requirement: Whole-series mutations
An authorized user SHALL be able to modify or delete an entire series. The only supported scopes for a recurring occurrence mutation SHALL be `this occurrence` and `entire series`; `this and following` MUST NOT be offered or accepted.

#### Scenario: Modify the entire series
- **WHEN** a user confirms a change with scope `entire series`
- **THEN** the series definition is versioned once and future range expansion uses the updated definition

#### Scenario: Delete the entire series
- **WHEN** a user confirms deletion with scope `entire series`
- **THEN** the series and every occurrence become unavailable to ordinary queries according to core soft-delete semantics

#### Scenario: Unsupported range scope is submitted
- **WHEN** a client submits `this and following` or another occurrence range scope
- **THEN** the system rejects the request without modifying the series or any exception

#### Scenario: Whole-series edit affects exceptions
- **WHEN** a whole-series edit would leave existing exceptions without a matching original occurrence
- **THEN** the user is shown the affected exceptions before confirmation and the confirmed result deterministically removes those orphaned exceptions

### Requirement: Recurrence across daylight-saving transitions
Occurrence expansion SHALL preserve the series' local date and wall-clock time in its stored IANA timezone. A nonexistent local start SHALL resolve to the earliest valid instant after the gap on that date, and an ambiguous local start SHALL resolve to the earlier instant. Timed duration SHALL be preserved in elapsed time unless an instance exception changes it.

#### Scenario: Daily time falls in a forward gap
- **WHEN** a daily occurrence's configured local start does not exist because clocks move forward
- **THEN** that occurrence starts at the earliest valid instant after the gap on the intended local date

#### Scenario: Weekly time is ambiguous
- **WHEN** a weekly occurrence's configured local start occurs twice because clocks move backward
- **THEN** that occurrence uses the earlier instant and retains a stable original occurrence key

#### Scenario: Viewer uses another display timezone
- **WHEN** a client displays a series in a timezone different from the series timezone
- **THEN** expansion follows the series timezone and only the resulting instants are converted for display

### Requirement: Reminder definitions and recipients
An event SHALL support reminder offsets from its effective start. The cloud SHALL schedule reminders only for authorized recipients, SHALL validate that an offset resolves before the effective start, and SHALL bind an instance reminder to the series and original occurrence key when recurrence is involved.

#### Scenario: Add a reminder to one event
- **WHEN** an authorized user adds a valid reminder offset to a timed or all-day event
- **THEN** the cloud persists the reminder definition and schedules its due instant from that event's effective start semantics

#### Scenario: Expand reminders for a recurring range
- **WHEN** recurring occurrences enter the scheduling horizon
- **THEN** the cloud materializes reminder work with stable identities per reminder definition, recipient, and original occurrence key

#### Scenario: Recipient loses access
- **WHEN** a recipient no longer has permission to read the event before delivery
- **THEN** pending reminder work for that recipient is canceled and no event content is delivered

### Requirement: Reminder state boundaries
Reminder work SHALL distinguish at least `scheduled`, `generated`, `fetched`, `display_requested`, `read`, and `canceled`. `generated` SHALL mean the business reminder event exists, `fetched` SHALL mean a client obtained it, `display_requested` SHALL mean a running client requested a notification surface, and `read` SHALL require an explicit read action. No earlier state SHALL imply a later state.

#### Scenario: Client fetches a reminder
- **WHEN** a client retrieves a generated reminder event
- **THEN** the recipient delivery state becomes fetched without becoming display-requested or read

#### Scenario: Running Desktop requests notification display
- **WHEN** an eligible running Desktop asks the operating system or in-app surface to display a fetched reminder
- **THEN** the state records display-requested even if the operating system suppresses or denies the desktop notification

#### Scenario: User opens but does not acknowledge the calendar elsewhere
- **WHEN** another device fetches the same reminder or opens the calendar without an explicit read action
- **THEN** the reminder does not become read

#### Scenario: User marks a reminder read
- **WHEN** the recipient explicitly marks the reminder read on any client
- **THEN** read state synchronizes for that recipient without implying that every device displayed it

### Requirement: Reminder recomputation and cancellation
Creating or changing an event, recurrence rule, exception, timezone, start, reminder offset, deletion state, or access SHALL atomically cancel obsolete pending reminder work and calculate replacement work. Committed generated events SHALL remain auditable and MUST NOT be rewritten as if they had never been generated.

#### Scenario: Event is moved before reminder generation
- **WHEN** an event start changes while its reminder is scheduled but not generated
- **THEN** the obsolete schedule is canceled and one replacement is scheduled from the new effective start

#### Scenario: Occurrence is canceled after generation
- **WHEN** a single occurrence is canceled after its reminder event was generated but before it is read
- **THEN** pending delivery is withdrawn where possible and the generated audit record is marked canceled rather than deleted

#### Scenario: Whole series is changed
- **WHEN** a series edit changes future occurrence times
- **THEN** pending reminder work for affected occurrences is canceled and recomputed from the new series revision without changing unaffected past records

#### Scenario: Reminder offset is removed
- **WHEN** an authorized user removes a reminder definition
- **THEN** its pending schedules and undelivered generated work are canceled and no replacement is created

### Requirement: Idempotent reminder generation and delivery
Reminder generation and each recipient/channel display request SHALL use stable deduplication identities. Scheduler retries, concurrent workers, client reconnects, and multiple signed-in Desktop instances MUST NOT create duplicate business reminder events or repeated display requests for the same identity on one client installation.

#### Scenario: Scheduler claims the same due reminder twice
- **WHEN** concurrent or retried scheduler work targets the same reminder identity
- **THEN** exactly one generated business reminder event is committed

#### Scenario: Client fetch repeats after reconnect
- **WHEN** a Desktop fetches the same generated reminder more than once
- **THEN** its installation requests each eligible notification channel at most once unless the user explicitly invokes a later reminder action

#### Scenario: Two devices are running
- **WHEN** two authorized Desktop installations fetch the same reminder
- **THEN** each installation can request local display once while sharing one recipient reminder event and synchronized read state

### Requirement: Desktop runtime notification boundary
The Desktop SHALL provide an in-app reminder surface while its runtime is active and MAY request an operating-system notification subject to platform permission and policy. The system MUST NOT promise an operating-system popup after the application has explicitly exited.

#### Scenario: Desktop is running in the background
- **WHEN** a reminder is fetched while the Desktop runtime is active but its window is hidden
- **THEN** the reminder appears in the in-app notification state and the Desktop may request an allowed system notification

#### Scenario: Application explicitly exited
- **WHEN** a reminder becomes due after all Desktop runtimes for the recipient have explicitly exited
- **THEN** the cloud retains the reminder for later fetch but no desktop popup at the due instant is guaranteed

#### Scenario: Desktop starts after a reminder became due
- **WHEN** the Desktop next starts and fetches an unread generated reminder
- **THEN** it exposes the reminder in-app and applies current notification policy without claiming it was displayed at the original due instant
