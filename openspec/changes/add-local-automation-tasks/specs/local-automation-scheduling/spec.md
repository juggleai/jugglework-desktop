## ADDED Requirements

### Requirement: Supported versioned schedules
The editor and local scheduler SHALL support one versioned discriminated schedule union mapped to the UI modes `周期` (`calendar`), `按间隔` (`interval`), and `单次` (`once`). Every schedule MUST store an explicit IANA timezone and exactly one mode payload; fields belonging to an inactive mode MUST NOT be persisted.

Calendar mode SHALL support:

- Daily: required local execution time.
- Weekly: one or more unique ISO weekdays plus required local execution time.
- Monthly: required day-of-month 1–31 plus required local execution time.
- Yearly: required month 1–12, day-of-month 1–31, and required local execution time.

Interval mode SHALL require a positive integer amount and unit `minute`, `hour`, or `day`, SHALL carry an anchor date/time interpreted in the schedule timezone, and MAY carry an optional set of unique ISO weekdays that restricts which local days can fire. Once mode SHALL require one future local date/time interpreted in the schedule timezone.

The schedule timezone SHALL be captured from the executing host rather than typed by the user; the editor SHALL NOT present a timezone control in any mode.

The editor SHALL expose interval mode as amount, unit, and weekday restriction only. The anchor is derived on create and preserved on edit, and SHALL NOT be an editor control.

#### Scenario: Interval task completes late
- **WHEN** a two-hour interval task completes after its next anchor-based occurrence
- **THEN** future occurrences remain aligned to the original anchor rather than drifting from completion time

#### Scenario: Task is outside its active range
- **WHEN** a calculated occurrence falls before the active start date or after the active end date
- **THEN** the occurrence is not executed

#### Scenario: User configures a yearly task like the reference
- **WHEN** the user selects 周期, 每年, month 1, day 21, time 18:12, and a valid timezone
- **THEN** the saved calendar payload contains yearly frequency, month 1, day 21, local time 18:12, and that timezone only

#### Scenario: User configures multiple weekly days
- **WHEN** the user selects 周期, 每周, Monday and Friday, and 09:00
- **THEN** the calculator produces one occurrence on each selected weekday at 09:00 in the stored timezone

#### Scenario: Interval task restricted to selected weekdays
- **WHEN** the user selects 按间隔, 每 6 小时, and restricts execution to Monday and Wednesday
- **THEN** anchor-derived occurrences that land on any other local weekday are skipped and the next run is the first anchor-derived instant on a Monday or Wednesday

#### Scenario: Interval task has no weekday restriction
- **WHEN** the user selects no weekday or selects all seven
- **THEN** the stored payload omits the weekday set and every anchor-derived occurrence stays eligible

#### Scenario: User switches frequency modes before save
- **WHEN** the user enters yearly values, switches to 按间隔, and saves a valid interval
- **THEN** the stored schedule contains only interval amount, unit, anchor, optional weekdays, and timezone with no yearly month/day fields

### Requirement: Schedule field validation and preview
The editor MUST validate schedule fields before full-access confirmation. Integer fields MUST reject zero, negative, decimal, and out-of-range values. Local dates/times and IANA timezone MUST parse successfully. A newly saved one-time instant MUST be strictly after the successful save time.

Every valid draft SHALL show a localized human-readable schedule summary and its calculated next run before save. An invalid or occurrence-free draft SHALL show a field error instead of a misleading next-run value.

#### Scenario: Interval amount is invalid
- **WHEN** the user enters zero, a negative value, or a decimal interval amount
- **THEN** Save is blocked and the amount field explains that a positive whole number is required

#### Scenario: One-time instant is in the past
- **WHEN** the user selects 单次 with a date/time that is not later than save time
- **THEN** Save is blocked and no completed task is created accidentally

#### Scenario: Valid schedule is previewed
- **WHEN** all schedule fields and optional active range are valid
- **THEN** the form displays the localized recurrence summary and exact next-run instant that will be persisted

### Requirement: Interval anchor semantics
Interval occurrences MUST be derived from the stored anchor and interval amount/unit, never from the prior run's start, completion, failure, or queue delay. The anchor MAY precede save/edit time. Create/edit SHALL choose the first anchor-derived occurrence at or after the local commit time and SHALL NOT create catch-up history for earlier anchor-derived occurrences.

#### Scenario: Past anchor aligns future execution
- **WHEN** a two-hour interval is anchored at 00:00 and saved at 10:15
- **THEN** its next run is 12:00 in the stored timezone and no 02:00–10:00 history rows are created

#### Scenario: Queue delays an interval run
- **WHEN** the 12:00 occurrence starts at 12:20 because another task occupied the executor
- **THEN** later occurrences remain 14:00, 16:00, and so on rather than shifting to 14:20

### Requirement: Optional inclusive active date range
An active range SHALL be either absent or contain both start and end local dates. Blank means always active. Partial ranges MUST be rejected, end MUST be on or after start, and both dates SHALL be inclusive in the stored schedule timezone. The editor MUST reject a schedule that can never produce an occurrence inside the range.

The active range applies to recurring modes only. Once mode SHALL NOT offer an active range, because its single local date/time already fixes the only occurrence; switching to 单次 SHALL clear any range captured in another mode.

The editor SHALL collect the range through one range control that commits only after both endpoints are chosen, so a half-selected range is never submitted for validation.

#### Scenario: Active range is blank
- **WHEN** the user leaves the effective date range empty
- **THEN** the definition is always eligible according to its schedule until paused, completed, or deleted

#### Scenario: One-time task offers no active range
- **WHEN** the user selects 单次
- **THEN** the effective date range control is not shown and any previously chosen range is cleared from the draft

#### Scenario: Active range is reversed
- **WHEN** the end date precedes the start date
- **THEN** Save is blocked with a date-range error

#### Scenario: Occurrence is on the end date
- **WHEN** a calendar occurrence falls on the configured end date at its valid local time
- **THEN** that occurrence is eligible because the range is inclusive

#### Scenario: Yearly schedule has no occurrence in range
- **WHEN** a yearly schedule targets February 29 but the finite active range contains no leap-year February 29
- **THEN** Save is blocked because the schedule has no possible occurrence in its active range

### Requirement: Deterministic calendar calculation
Calendar due-time calculation MUST be deterministic across restart and daylight-saving changes. A nonexistent local time SHALL resolve to the earliest valid instant after the gap on that date; an ambiguous local time SHALL resolve to the earlier occurrence. A calendar date that does not exist SHALL be skipped rather than clamped.

#### Scenario: Scheduled local time is skipped by daylight saving
- **WHEN** a daily calendar task targets a local time inside a forward daylight-saving gap
- **THEN** that date's occurrence uses the earliest valid instant after the gap

#### Scenario: Monthly day does not exist
- **WHEN** a monthly task targets day 31 and the current month has fewer than 31 days
- **THEN** the scheduler skips that month and calculates the next month containing day 31

#### Scenario: Yearly leap day
- **WHEN** a yearly task targets February 29
- **THEN** it runs in leap years and skips non-leap years without clamping to February 28 or March 1

#### Scenario: System timezone changes
- **WHEN** the device timezone changes after a task was saved
- **THEN** the task continues using its stored IANA timezone until the user explicitly edits it

### Requirement: Embedded-server scheduler lifecycle
The scheduler SHALL run inside the embedded local JuggleWork server after runtime database and workspace initialization and SHALL stop when that runtime is disposed. It MUST continue while renderer routes change or the application window is hidden, but SHALL make no guarantee after explicit client exit, runtime crash, device shutdown, or power loss.

#### Scenario: Application window is hidden
- **WHEN** the Electron runtime remains active while the renderer window is hidden
- **THEN** the embedded scheduler continues calculating and dispatching due runs

#### Scenario: Client has exited
- **WHEN** an occurrence becomes due while the client runtime is not running
- **THEN** no execution occurs at that instant and restart reconciliation applies the missed-run policy

### Requirement: Transactional idempotent due-run claiming
For every scheduler wake-up, due-run creation and task `next_run_at` advancement MUST be committed atomically. Scheduled and catch-up occurrences MUST be unique per automation and scheduled instant so timer duplication, restart, or clock adjustment cannot dispatch the same occurrence twice.

#### Scenario: Scheduler wakes twice for one instant
- **WHEN** two wake-ups attempt to claim the same automation occurrence
- **THEN** exactly one non-skipped run is created and dispatched for that scheduled instant

#### Scenario: Database transaction fails
- **WHEN** due-run insertion or next-run advancement fails before commit
- **THEN** neither partial state becomes visible and the occurrence remains eligible for a later retry

### Requirement: Bounded missed-run handling
At startup or resume, the scheduler SHALL accept at most the latest missed occurrence. It SHALL create one catch-up run when that occurrence is no more than ten minutes late and still inside the active range; otherwise it SHALL record a skipped run with `missed_deadline`. It MUST NOT enqueue every historical occurrence.

#### Scenario: Device resumes within grace period
- **WHEN** the latest missed occurrence is seven minutes old and no run is active
- **THEN** exactly one catch-up run is created for that scheduled instant

#### Scenario: Device resumes after many missed occurrences
- **WHEN** several occurrences were missed and the latest is more than ten minutes old
- **THEN** no execution is dispatched, a skipped history result records the missed deadline, and the next future occurrence is calculated

### Requirement: Non-overlap and bounded local concurrency
An automation MUST have at most one queued or running run. A due occurrence that overlaps a nonterminal run SHALL be recorded as skipped with `overlap_blocked`. The first release SHALL execute at most one automation run globally at a time while allowing additional non-overlapping runs to remain queued.

#### Scenario: Same automation remains running
- **WHEN** another occurrence becomes due before the previous run reaches a terminal state
- **THEN** the new occurrence is marked skipped and is not submitted to OpenCode

#### Scenario: Two different tasks become due together
- **WHEN** two eligible automations become due at the same instant
- **THEN** one runs and the other remains durably queued until the executor slot is free

### Requirement: Restart recovery
The scheduler SHALL persist queued/running state and reconcile it on startup. Queued runs SHALL resume dispatch subject to current validation. Running runs with a session id SHALL be reconciled from OpenCode session status; missing or unrecoverable sessions SHALL fail with a stable error instead of remaining nonterminal indefinitely.

#### Scenario: Client restarts after session dispatch
- **WHEN** a persisted run is `running` and its OpenCode session is idle after restart
- **THEN** the run is reconciled to succeeded without dispatching the prompt again

#### Scenario: Persisted session no longer exists
- **WHEN** a running record references a session that cannot be found after restart
- **THEN** the run becomes failed with `session_lost` and the automation can run again later

### Requirement: One-time schedule terminal behavior
After a one-time occurrence is accepted, skipped for a terminal scheduling reason, or found outside the active range, the automation SHALL have no next run and SHALL be shown as completed rather than repeatedly reconsidered.

#### Scenario: One-time task succeeds
- **WHEN** the sole scheduled occurrence is accepted for execution
- **THEN** `next_run_at` is cleared and no second scheduled run can be created

### Requirement: Create and edit recompute future schedule
After a successful local create or edit, the scheduler SHALL atomically calculate `next_run_at` from the committed schedule revision and commit time. Creating/editing MUST NOT invoke missed-run catch-up for occurrences before that commit. Any queued or running run SHALL retain its captured older definition revision and MUST NOT be rewritten by the edit.

#### Scenario: User changes schedule before the next run
- **WHEN** an enabled task is edited from daily 09:00 to daily 10:00 at 08:00
- **THEN** the next run becomes 10:00 under the new revision and the old 09:00 occurrence is not dispatched

#### Scenario: User edits while a run is active
- **WHEN** a run captured revision five and the user saves revision six
- **THEN** the active run continues with revision five while later runs use revision six

### Requirement: Pause and resume schedule semantics
Pausing SHALL clear the active timer eligibility without deleting the stored schedule or historical next-run context. Occurrences during an intentional pause MUST NOT create skipped run records. Resuming SHALL calculate the first future occurrence from resume time and MUST NOT catch up the paused period. A task whose active range has already ended SHALL become completed rather than resumable to a future scheduled run.

#### Scenario: Daily task remains paused for three days
- **WHEN** the task is resumed after three daily occurrences passed while paused
- **THEN** no missed/catch-up rows are created for those days and the next future daily occurrence is scheduled

#### Scenario: User resumes after active range ended
- **WHEN** the configured end date is before resume time
- **THEN** the task is shown completed with no next scheduled run
